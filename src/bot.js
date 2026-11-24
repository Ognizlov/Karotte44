// Paper-trading pipeline: Scout -> Filter -> Analyst -> Executor -> Risk -> Logger (+ Optimizer)
// SIMULATION ONLY. No wallet, no private key, no transactions are ever sent.
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const Feed = process.env.MOCK === '1' ? require('./mockfeed') : require('./feed');
const Logger = require('./logger');
const Recorder = require('./recorder');
const Usage = require('./usage');
const S = require('./strategy');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (x, d = 4) => Number(x).toFixed(d);

class Bot {
  constructor(baseCfg, root, cfgPath) {
    this.root = root; this.cfgPath = cfgPath;
    this.dataDir = path.join(root, 'data');
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.baseCfg = baseCfg;   // config.json: also the (looser) thresholds for research candidates
    this.tunedPath = path.join(this.dataDir, 'tuned.json');
    try { this.tuned = JSON.parse(fs.readFileSync(this.tunedPath, 'utf8')); } catch { this.tuned = null; }
    this.cfg = S.mergeConfig(baseCfg, this.tuned); // live parameters
    this.logger = new Logger(baseCfg.logger, root);
    this.feed = new Feed(baseCfg.wsUrl, this.logger);
    this.usage = new Usage(path.join(this.dataDir, 'usage.json'), baseCfg.dataCost);
    this.recorder = new Recorder(this.dataDir);
    this.cash = baseCfg.startCapital;
    this.pendingSol = 0; this.pendingBuys = 0; // buys in flight (latency)
    this.tokens = new Map();     // mint -> observed token state
    this.positions = new Map();  // mint -> open position
    this.closed = [];
    this.equity = [{ t: Date.now(), v: baseCfg.startCapital }];
    this.startedAt = Date.now();
    this.optReport = null; this.optRunning = false;
    const agent = (state) => ({ state, last: '-', count: 0 });
    this.agents = {
      scout: agent('idle'), filter: agent('idle'), analyst: agent('idle'),
      executor: agent('idle'), risk: agent('idle'), logger: agent('aktiv'), optimizer: agent('wartet'),
    };
    this.logger.on('line', () => { this.agents.logger.count++; });
  }

  touch(name, last, state) {
    const a = this.agents[name]; a.count++; a.last = last; if (state) a.state = state;
  }

  start() {
    this.logger.log('system', `Start – Paper-Trading, Kapital ${this.cfg.startCapital} SOL (SIMULATION, kein Wallet)`);
    if (this.tuned) this.logger.log('system', `Optimierte Parameter geladen: ${JSON.stringify(this.tuned.params)}`);
    this.feed.on('create', (m) => this.scout(m));
    this.feed.on('trade', (m) => this.onTrade(m));
    this.feed.connect();
    setInterval(() => this.riskTick(), this.cfg.risk.checkIntervalMs);
    setInterval(() => this.recordEquity(), 5000);
    const o = this.baseCfg.optimizer;
    if (o.auto) {
      setTimeout(() => this.runOptimizer('auto'), o.firstRunMinutes * 60000);
      setInterval(() => this.runOptimizer('auto'), o.everyMinutes * 60000);
    }
  }

  stop() { this.recorder.finishAll(Date.now()); this.usage.save(); }

  // A token stays subscribed while it is observed, held, or recorded as research candidate.
  release(t) {
    if (t.stage === 'watching' || t.stage === 'buying' || this.positions.has(t.mint) || this.recorder.isActive(t.mint)) return;
    this.feed.unwatch(t.mint);
    if (!t.deleteTimer) t.deleteTimer = setTimeout(() => this.tokens.delete(t.mint), 60000);
  }

  // ---------- 1. Scout ----------
  scout(m) {
    if (!m.mint || this.tokens.has(m.mint)) return;
    const watching = this.watchingCount();
    if (watching >= this.cfg.scout.maxWatching) { this.touch('scout', `übersprungen ${m.symbol} (Kapazität)`); return; }
    if (this.usage.overBudget()) {
      if (!this.budgetLogged || Date.now() - this.budgetLogged > 600000) {
        this.budgetLogged = Date.now();
        this.logger.log('scout', `Datenbudget ${this.baseCfg.dataCost.maxSolPerDay} SOL/24h erreicht – Scan pausiert (config.json → dataCost)`, 'warn');
      }
      this.touch('scout', 'pausiert: Datenbudget erreicht', 'Budget erreicht');
      return;
    }
    const supply = this.cfg.totalSupply;
    const t = {
      mint: m.mint, symbol: m.symbol || '?', name: m.name || '', dev: m.traderPublicKey,
      createdAt: Date.now(), initialBuy: Number(m.initialBuy) || 0,
      vSol: Number(m.vSolInBondingCurve), vTokens: Number(m.vTokensInBondingCurve),
      balances: new Map(), buyers: new Set(), buys: 0, sells: 0, volumeSol: 0,
      devSold: false, stage: 'watching', lastTrade: Date.now(),
    };
    if (!(t.vSol > 0 && t.vTokens > 0)) return;
    t.startPrice = t.vSol / t.vTokens;
    if (t.initialBuy > 0) t.balances.set(t.dev, t.initialBuy);
    this.tokens.set(m.mint, t);
    this.feed.watch(m.mint);
    const devPct = fmt((t.initialBuy / supply) * 100, 2);
    this.touch('scout', `neu: ${t.symbol} (Dev-Buy ${devPct}%)`);
    this.logger.log('scout', `Neuer Token ${t.symbol} ${m.mint.slice(0, 8)} – Dev-Initialbuy ${devPct}%`);
    t.timer = setTimeout(() => this.filter(t), this.cfg.filter.observeSeconds * 1000);
  }

  onTrade(m) {
    if (process.env.MOCK !== '1') this.usage.add(1); // mock data is not billed
    if (this.feed.tradesBlocked) { this.feed.tradesBlocked = false; this.logger.log('feed', 'Trade-Daten kommen wieder an'); }
    const t = this.tokens.get(m.mint);
    if (!t) return;
    const vS = Number(m.vSolInBondingCurve), vT = Number(m.vTokensInBondingCurve);
    const curveOk = vS > 0 && vT > 0; // migrated / malformed updates carry no bonding-curve state
    if (curveOk) { t.vSol = vS; t.vTokens = vT; }
    t.lastTrade = Date.now();
    t.volumeSol += Number(m.solAmount) || 0;
    if (m.newTokenBalance !== undefined) t.balances.set(m.traderPublicKey, Number(m.newTokenBalance));
    if (m.txType === 'buy') { t.buys++; t.buyers.add(m.traderPublicKey); }
    else { t.sells++; if (m.traderPublicKey === t.dev) t.devSold = true; }
    if (curveOk) this.recorder.point(t.mint, t.lastTrade, t.vSol, t.vTokens);
    if (t.stage === 'watching' && t.devSold && this.cfg.filter.rejectIfDevSells) {
      clearTimeout(t.timer);
      this.reject(t, 'filter', 'Dev hat verkauft');
    }
    if (this.positions.has(t.mint)) this.checkPosition(t);
  }

  reject(t, module, reason, extra = {}) {
    t.stage = 'done';
    this.touch(module, `✗ ${t.symbol}: ${reason}`);
    this.logger.decision(module, 'REJECT', { mint: t.mint, symbol: t.symbol, price: t.vSol / t.vTokens, reason, ...extra });
    this.release(t);
  }

  // ---------- 2. Filter ----------
  filter(t) {
    if (t.stage !== 'watching') return;
    const f = S.features(t, this.cfg.totalSupply);
    const why = S.filterCheck(f, this.cfg.filter);
    if (why) return this.reject(t, 'filter', why);
    this.touch('filter', `✓ ${t.symbol} (Dev ${fmt(f.devPct, 1)}%, Top10 ${fmt(f.top10Pct, 1)}%)`);
    this.logger.log('filter', `PASS ${t.symbol} – Dev ${fmt(f.devPct, 2)}%, Top10 ${fmt(f.top10Pct, 1)}%`);
    this.analyst(t, f);
  }

  // ---------- 3. Analyst ----------
  analyst(t, f) {
    const sc = S.score(f, this.cfg.analyst);
    t.score = sc;
    const detail = `Buyers ${f.buyers}, B/S ${fmt(f.ratio, 2)}, Vol ${fmt(f.volumeSol, 2)} SOL, Δ ${fmt(f.priceChgPct, 1)}%`;
    // Research: tokens passing the base thresholds of config.json are recorded as hypothetical trades.
    if (this.baseCfg.research.enabled && !S.entryCheck(f, sc, this.baseCfg.analyst) && this.usage.ratio() < 0.8) this.startCandidate(t, f, sc);
    const why = S.entryCheck(f, sc, this.cfg.analyst);
    if (why) return this.reject(t, 'analyst', `${why} (${detail})`, { score: fmt(sc, 3) });
    this.touch('analyst', `✓ ${t.symbol} Score ${fmt(sc, 2)}`);
    this.logger.decision('analyst', 'APPROVE', { mint: t.mint, symbol: t.symbol, score: fmt(sc, 3), reason: `Score ${fmt(sc, 2)} ≥ ${this.cfg.analyst.minScore} (${detail})` });
    this.executeBuy(t);
  }

  startCandidate(t, f, sc) {
    const ex = this.cfg.executor, horizon = this.baseCfg.research.horizonSeconds * 1000;
    this.recorder.start(t.mint, { symbol: t.symbol, decidedAt: Date.now(), features: f, score: sc, refSol: this.equityNow() * ex.positionSizePct / 100 });
    setTimeout(() => this.recorder.fill(t.mint, Date.now(), t.vSol, t.vTokens), ex.delayMs);
    // record a little past the horizon so exits at the horizon still see the curve after the latency
    setTimeout(() => { this.recorder.finish(t.mint, Date.now()); this.release(t); }, ex.delayMs + horizon + ex.delayMs + 1000);
  }

  // ---------- 4. Executor ----------
  async executeBuy(t) {
    const e = this.cfg.executor;
    if (this.positions.size + this.pendingBuys >= e.maxOpenPositions) return this.reject(t, 'executor', `Max. ${e.maxOpenPositions} offene Positionen`);
    const size = this.equityNow() * (e.positionSizePct / 100);
    if (this.cash < size + e.priorityFeeSol) return this.reject(t, 'executor', `Zu wenig Cash (${fmt(this.cash)} SOL)`);
    t.stage = 'buying';
    this.cash -= size + e.priorityFeeSol; // reserve funds during latency
    this.pendingSol += size + e.priorityFeeSol; this.pendingBuys++;
    this.touch('executor', `kaufe ${t.symbol}…`, 'Order läuft');
    await sleep(e.delayMs); // simulated network/landing latency
    this.pendingSol -= size + e.priorityFeeSol; this.pendingBuys--;
    const { tokens, solNet } = S.quoteBuy(t.vSol, t.vTokens, size, e.feePct);
    const price = t.vSol / t.vTokens;
    const pos = { mint: t.mint, symbol: t.symbol, tokens, solNet, costSol: size + e.priorityFeeSol, entryPrice: price,
      peakPrice: price, openedAt: Date.now(), trailing: false, selling: false, netPct: 0, score: t.score };
    this.positions.set(t.mint, pos);
    t.stage = 'position';
    this.agents.executor.state = 'idle';
    this.touch('executor', `✓ BUY ${t.symbol} ${fmt(size)} SOL`);
    this.logger.decision('executor', 'BUY', { mint: t.mint, symbol: t.symbol, price: price.toExponential(4), sol: fmt(pos.costSol, 5),
      tokens: Math.round(tokens), score: fmt(t.score, 3),
      reason: `Sim-Kauf ${e.positionSizePct}% Kapital, Fee ${e.feePct}%, Prio ${e.priorityFeeSol} SOL, Delay ${e.delayMs}ms` });
  }

  liquidation(t, pos) {
    return Math.max(0, S.quoteSell(t.vSol, t.vTokens, pos.tokens, pos.solNet, this.cfg.executor.feePct) - this.cfg.executor.priorityFeeSol);
  }

  async executeSell(t, pos, reason) {
    if (pos.selling) return;
    pos.selling = true;
    const e = this.cfg.executor;
    this.touch('executor', `verkaufe ${t.symbol}…`, 'Order läuft');
    await sleep(e.delayMs);
    const out = this.liquidation(t, pos);
    const price = t.vSol / t.vTokens;
    this.cash += out;
    const pnl = out - pos.costSol, pnlPct = (pnl / pos.costSol) * 100;
    this.positions.delete(t.mint);
    t.stage = 'done';
    this.release(t);
    this.closed.push({ symbol: t.symbol, mint: t.mint, pnl, pnlPct, reason, closedAt: Date.now(), heldS: (Date.now() - pos.openedAt) / 1000 });
    if (this.closed.length > 500) this.closed.shift();
    this.agents.executor.state = 'idle';
    this.touch('executor', `✓ SELL ${t.symbol} ${pnl >= 0 ? '+' : ''}${fmt(pnl)} SOL`);
    this.logger.decision('executor', 'SELL', { mint: t.mint, symbol: t.symbol, price: price.toExponential(4), sol: fmt(out, 5),
      tokens: Math.round(pos.tokens), pnlSol: fmt(pnl, 5), pnlPct: fmt(pnlPct, 2), reason });
    this.recordEquity();
  }

  // ---------- 5. Risk ----------
  checkPosition(t) {
    const pos = this.positions.get(t.mint);
    if (!pos || pos.selling) return;
    const r = this.cfg.risk, now = Date.now(), price = t.vSol / t.vTokens;
    const wasTrailing = pos.trailing;
    const code = S.priceExit(pos, price, r) || S.timeExit(now - pos.openedAt, now - Math.max(t.lastTrade, pos.openedAt), r);
    pos.netPct = (this.liquidation(t, pos) / pos.costSol - 1) * 100;
    if (pos.trailing && !wasTrailing) {
      this.touch('risk', `Trailing aktiv ${t.symbol}`);
      this.logger.log('risk', `Trailing-Stop aktiviert für ${t.symbol} bei +${fmt((pos.peakPrice / pos.entryPrice - 1) * 100, 1)}%`);
    }
    if (code) {
      const reason = S.describeExit(code, pos, price, r);
      this.touch('risk', `EXIT ${t.symbol}: ${reason}`);
      this.logger.decision('risk', 'EXIT', { mint: t.mint, symbol: t.symbol, price: price.toExponential(4), pnlPct: fmt(pos.netPct, 2), reason });
      this.executeSell(t, pos, reason);
    }
  }
  watchingCount() { let n = 0; for (const t of this.tokens.values()) if (t.stage === 'watching') n++; return n; }
  riskTick() {
    this.agents.risk.state = this.positions.size ? `überwacht ${this.positions.size}` : 'idle';
    for (const pos of this.positions.values()) { const t = this.tokens.get(pos.mint); if (t) this.checkPosition(t); }
    const w = this.watchingCount();
    this.agents.scout.state = !this.feed.connected ? 'offline' : this.usage.overBudget() ? 'Budget erreicht' : `beobachtet ${w}`;
    this.agents.filter.state = w ? `prüft ${w}` : 'idle';
  }

  // ---------- Optimizer ----------
  runOptimizer(trigger) {
    if (this.optRunning) return false;
    this.optRunning = true;
    this.agents.optimizer.state = 'rechnet…';
    const child = fork(path.join(__dirname, 'optimizer.js'), ['--json'], { silent: true, env: { ...process.env, CONFIG: this.cfgPath } });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', () => {
      this.optRunning = false;
      let rep;
      try { rep = JSON.parse(out); } catch {
        this.agents.optimizer.state = 'Fehler';
        return this.logger.log('optimizer', `Fehler: ${err.slice(0, 300) || 'keine Ausgabe'}`, 'error');
      }
      this.onOptimizerReport(rep, trigger);
    });
    return true;
  }

  onOptimizerReport(rep, trigger) {
    this.optReport = rep;
    if (rep.status !== 'ok') {
      this.agents.optimizer.state = 'sammelt Daten';
      this.touch('optimizer', rep.reason);
      return this.logger.log('optimizer', `${rep.reason} (${trigger})`);
    }
    const b = rep.best, c = rep.current;
    const sum = (s) => `${s.n} Trades, Ø ${fmt(s.avgPct, 2)}%, Win ${fmt(s.winRate * 100, 0)}%`;
    const msg = `Aktuell: ${sum(c.all)} | Optimiert: ${sum(b.all)} | Test: ${sum(b.test)}`;
    if (rep.recommended && this.baseCfg.optimizer.autoApply) {
      fs.writeFileSync(this.tunedPath, JSON.stringify({ at: rep.at, params: b.params, test: b.test, all: b.all }, null, 2));
      this.tuned = JSON.parse(fs.readFileSync(this.tunedPath, 'utf8'));
      const merged = S.mergeConfig(this.baseCfg, this.tuned);
      Object.assign(this.cfg.analyst, merged.analyst); Object.assign(this.cfg.risk, merged.risk);
      this.agents.optimizer.state = 'angewendet';
      this.touch('optimizer', `✓ neue Parameter (${sum(b.all)})`);
      this.logger.decision('optimizer', 'APPLY', { reason: `${rep.reason}. ${msg}. Neu: ${JSON.stringify(b.params)}` });
    } else {
      this.agents.optimizer.state = 'beibehalten';
      this.touch('optimizer', `beibehalten: ${rep.reason}`);
      this.logger.decision('optimizer', 'KEEP', { reason: `${rep.reason}. ${msg}` });
    }
  }

  // ---------- Equity ----------
  equityNow() {
    let v = this.cash + this.pendingSol;
    for (const pos of this.positions.values()) {
      const t = this.tokens.get(pos.mint);
      v += t ? this.liquidation(t, pos) : pos.costSol;
    }
    return v;
  }
  recordEquity() {
    this.equity.push({ t: Date.now(), v: this.equityNow() });
    if (this.equity.length > 5000) this.equity.splice(0, this.equity.length - 5000);
  }

  state() {
    const wins = this.closed.filter((c) => c.pnl > 0).length;
    const hourAgo = Date.now() - 3600000;
    const tunedKeys = [];  // parameters where the optimizer deviates from config.json
    for (const sec of ['analyst', 'risk']) for (const k of Object.keys(this.cfg[sec])) if (this.cfg[sec][k] !== this.baseCfg[sec][k]) tunedKeys.push(k);
    const a = this.cfg.analyst, r = this.cfg.risk;
    return {
      connected: this.feed.connected, tradesBlocked: this.feed.tradesBlocked, mock: process.env.MOCK === '1',
      msgCount: this.feed.msgCount, uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
      cash: this.cash, equity: this.equityNow(), startCapital: this.cfg.startCapital,
      agents: this.agents, equityCurve: this.equity,
      positions: [...this.positions.values()].map((p) => ({ symbol: p.symbol, mint: p.mint, costSol: p.costSol,
        pnlPct: p.netPct, trailing: p.trailing, heldS: Math.round((Date.now() - p.openedAt) / 1000) })),
      closed: this.closed.slice(-30).reverse(),
      stats: { trades: this.closed.length, wins, winRate: this.closed.length ? wins / this.closed.length : 0,
        tradesLastHour: this.closed.filter((c) => c.closedAt > hourAgo).length, watching: this.watchingCount() },
      usage: this.usage.state(),
      research: { active: this.recorder.active.size, recorded: this.recorder.written },
      strategy: {
        tunedKeys, tunedAt: this.tuned ? this.tuned.at : null,
        params: { minScore: a.minScore, minUniqueBuyers: a.minUniqueBuyers, maxPriceChangePct: a.maxPriceChangePct,
          stopLossPct: r.stopLossPct, takeProfitPct: r.takeProfitPct, trailingActivationPct: r.trailingActivationPct,
          trailingDistancePct: r.trailingDistancePct, maxHoldMinutes: r.maxHoldMinutes, stallExitSeconds: r.stallExitSeconds },
      },
      optimizer: { running: this.optRunning, report: this.optReport, minTrades: this.baseCfg.optimizer.minTrades },
      log: this.logger.lines.slice(-150),
    };
  }
}
module.exports = Bot;
