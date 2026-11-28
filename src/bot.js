// Paper-trading pipeline: Scout -> Filter -> Analyst -> Executor -> Risk -> Logger (+ Optimizer)
// SIMULATION ONLY. No wallet, no private key, no transactions are ever sent.
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const Logger = require('./logger');
const Recorder = require('./recorder');
const Usage = require('./usage');
const S = require('./strategy');
const G = require('./gradstrategy');
const GradRecorder = require('./gradrecorder');

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
    if (this.tuned && this.tuned.strategyVersion !== S.STRATEGY_VERSION) { this.staleTuned = true; this.tuned = null; }
    this.cfg = S.mergeConfig(baseCfg, this.tuned); // live parameters
    this.logger = new Logger(baseCfg.logger, root);
    // Data source: free Solana blockchain feed (default), paid PumpPortal stream, or synthetic mock data.
    if (process.env.MOCK === '1') this.feed = new (require('./mockfeed'))(null, this.logger);
    else if (baseCfg.source === 'pumpportal') this.feed = new (require('./feed'))(baseCfg.pumpportal.wsUrl, this.logger);
    else this.feed = new (require('./solanafeed'))(baseCfg.solana, this.logger);
    this.usage = new Usage(path.join(this.dataDir, 'usage.json'), baseCfg.dataCost);
    this.recorder = new Recorder(this.dataDir);
    // Strategy: 'graduation' (older tokens with SOL in the curve + buying momentum) or 'newTokens' (first seconds)
    this.mode = baseCfg.strategy === 'newTokens' ? 'newTokens' : 'graduation';
    this.scanner = new Map();               // mint -> graduation state of every active standard curve
    this.gradRec = new GradRecorder(this.dataDir);
    this.gradTracked = new Map();           // mint -> { since }
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
    this.logger.log('system', `Start – Version 5 (${this.mode === 'graduation' ? 'ältere Tokens: nur bekannte Vorgeschichte + Whale-Filter' : 'neue Tokens'}), Paper-Trading, Kapital ${this.cfg.startCapital} SOL (SIMULATION, kein Wallet)`);
    if (this.mode === 'graduation') this.loadScanner();
    if (this.tuned) this.logger.log('system', `Optimierte Parameter geladen: ${JSON.stringify(this.tuned.params)}`);
    if (this.staleTuned) this.logger.log('system', 'Optimierte Werte einer älteren Version ignoriert – Startwerte aus config.json gelten');
    this.feed.on('create', (m) => this.scout(m));
    this.feed.on('trade', (m) => this.onTrade(m));
    this.feed.on('invalid', (m) => this.onInvalid(m));
    this.feed.on('complete', (m) => this.onComplete(m));
    if (this.mode === 'graduation') {
      this.feed.on('curve', (e) => this.onCurve(e));
      setInterval(() => this.gradHousekeeping(), 10000);
    }
    this.feed.connect();
    setInterval(() => this.riskTick(), this.cfg.risk.checkIntervalMs);
    setInterval(() => this.recordEquity(), 5000);
    const o = this.baseCfg.optimizer;
    if (o.auto) {
      setTimeout(() => this.runOptimizer('auto'), o.firstRunMinutes * 60000);
      setInterval(() => this.runOptimizer('auto'), o.everyMinutes * 60000);
    }
  }

  stop() { this.recorder.finishAll(Date.now()); this.gradRec.finishAll(Date.now()); this.usage.save(); if (this.mode === 'graduation') this.saveScanner(); }

  // Wallet histories survive a restart (Strg + C): trades during the downtime are missing, which shows up as
  // "unknown holdings" (curve sold more tokens than the wallets we know hold).
  saveScanner() {
    const now = Date.now(), keepMs = 3 * 3600000, out = [];
    for (const st of this.scanner.values()) {
      if (!st.holders || now - st.lastTrade > keepMs) continue;
      out.push({ mint: st.mint, createdAt: st.createdAt, dev: st.dev, S: st.S, T: st.T, slot: st.slot, lastTrade: st.lastTrade,
        holders: [...st.holders].filter(([, b]) => Math.abs(b) > 1e-9), firstBuy: st.firstBuy ? [...st.firstBuy] : [] });
    }
    try { fs.writeFileSync(path.join(this.dataDir, 'scanner.json'), JSON.stringify({ savedAt: now, states: out })); } catch {}
  }
  loadScanner() {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'scanner.json'), 'utf8')); } catch { return; }
    const now = Date.now();
    let n = 0;
    for (const x of d.states || []) {
      if (now - x.lastTrade > 3 * 3600000 || this.scanner.has(x.mint)) continue;
      const st = G.newState(x.mint, true, x.createdAt, x.dev);
      Object.assign(st, { S: x.S, T: x.T, real: x.S - G.OFFSET, slot: x.slot, lastTrade: x.lastTrade });
      st.holders = new Map(x.holders); st.firstBuy = new Map(x.firstBuy);
      this.scanner.set(x.mint, st); n++;
    }
    if (n) this.logger.log('system', `Wallet-Historie von ${n} Tokens geladen (seit ${Math.round((now - d.savedAt) / 60000)} min Pause)`);
  }

  // A token stays subscribed while it is observed, held, or recorded as research candidate.
  release(t) {
    if (t.stage === 'watching' || t.stage === 'buying' || this.positions.has(t.mint) || this.recorder.isActive(t.mint) || this.gradTracked.has(t.mint)) return;
    this.feed.unwatch(t.mint);
    if (!t.deleteTimer) t.deleteTimer = setTimeout(() => this.tokens.delete(t.mint), 60000);
  }

  // ---------- 1. Scout ----------
  scout(m) {
    if (this.mode !== 'newTokens') {
      // graduation: a token seen from its creation gets full wallet tracking (whale check later on)
      if (m.mint && !this.scanner.has(m.mint)) { const now = Date.now(); const st = G.newState(m.mint, true, now, m.traderPublicKey); st.lastTrade = now; this.scanner.set(m.mint, st); }
      return;
    }
    if (!m.mint || this.tokens.has(m.mint)) return;
    const watching = this.watchingCount();
    if (watching >= this.cfg.scout.maxWatching) { this.touch('scout', `übersprungen ${m.symbol} (Kapazität)`); return; }
    if (this.feed.billed && this.usage.overBudget()) {
      if (!this.budgetLogged || Date.now() - this.budgetLogged > 600000) {
        this.budgetLogged = Date.now();
        this.logger.log('scout', `Datenbudget ${this.baseCfg.dataCost.maxSolPerDay} SOL/24h erreicht – Scan pausiert (config.json → dataCost)`, 'warn');
      }
      this.touch('scout', 'pausiert: Datenbudget erreicht', 'Budget erreicht');
      return;
    }
    const supply = this.cfg.totalSupply;
    if (!(Number(m.vSolInBondingCurve) > 0 && Number(m.vTokensInBondingCurve) > 0)) return;
    const t = S.newToken(m, Date.now());
    this.tokens.set(m.mint, t);
    this.feed.watch(m.mint);
    this.startRecording(t);
    const devPct = fmt((t.initialBuy / supply) * 100, 2);
    this.touch('scout', `neu: ${t.symbol} (Dev-Buy ${devPct}%)`);
    this.logger.log('scout', `Neuer Token ${t.symbol} ${m.mint.slice(0, 8)} – Dev-Initialbuy ${devPct}%`);
    t.timer = setTimeout(() => this.filter(t), this.cfg.filter.observeSeconds * 1000);
  }

  onTrade(m) {
    if (this.feed.billed) this.usage.add(1); // only PumpPortal charges per message
    if (this.feed.tradesBlocked) { this.feed.tradesBlocked = false; this.logger.log('feed', 'Trade-Daten kommen wieder an'); }
    const t = this.tokens.get(m.mint);
    if (!t || t.mode === 'grad') return; // graduation tokens are driven by the scanner (onCurve)
    const now = Date.now();
    S.applyTrade(t, m, now);
    this.recorder.trade(t.mint, now, m);
    if (t.stage === 'watching' && t.devSold && this.cfg.filter.rejectIfDevSells) {
      clearTimeout(t.timer);
      this.reject(t, 'filter', 'Dev hat verkauft');
    }
    if (this.positions.has(t.mint)) this.checkPosition(t);
  }

  // Token is not traded against SOL (pump.fun also supports other quote currencies) – cannot be simulated.
  onInvalid(m) {
    const t = this.tokens.get(m.mint);
    if (!t) return;
    this.recorder.event(m.mint, Date.now(), 'invalid');
    this.gradRec.event(m.mint, Date.now(), 'invalid');
    const pos = this.positions.get(m.mint);
    if (pos && !pos.selling) {
      const reason = `${m.reason} – Verkauf zum letzten gültigen Kurs`;
      this.logger.decision('risk', 'EXIT', { mint: t.mint, symbol: t.symbol, price: (t.vSol / t.vTokens).toExponential(4), pnlPct: fmt(pos.netPct, 2), reason });
      this.executeSell(t, pos, reason);
    } else if (t.stage === 'watching') { clearTimeout(t.timer); this.reject(t, 'filter', m.reason); }
  }

  // Bonding curve completed (token migrates to an AMM): no curve price anymore – close at the last curve price.
  onComplete(m) {
    const t = this.tokens.get(m.mint);
    if (!t) return;
    this.recorder.event(m.mint, Date.now(), 'complete');
    this.gradRec.event(m.mint, Date.now(), 'complete');
    if (this.gradTracked.has(m.mint)) this.endTracking(m.mint, 'Kurve abgeschlossen');
    const pos = this.positions.get(m.mint);
    if (pos && !pos.selling) {
      const reason = 'Bonding-Curve abgeschlossen (Migration) – Verkauf zum letzten Kurven-Preis';
      this.logger.decision('risk', 'EXIT', { mint: t.mint, symbol: t.symbol, price: (t.vSol / t.vTokens).toExponential(4), pnlPct: fmt(pos.netPct, 2), reason });
      this.executeSell(t, pos, reason);
    } else if (t.stage === 'watching') { clearTimeout(t.timer); this.reject(t, 'filter', 'Bonding-Curve bereits abgeschlossen'); }
  }

  // ---------- Graduation strategy: scanner over all running tokens ----------
  onCurve(e) {
    if (!G.isStandard(e)) return; // only standard SOL curves (no Mayhem mode, no other quote currency)
    const g = this.cfg.graduation, now = Date.now();
    let st = this.scanner.get(e.mint);
    if (!st) { // seen mid-life: wallets unknown, age at least the time since the bot started
      st = G.newState(e.mint, false); st.ageRefAt = this.startedAt; this.scanner.set(e.mint, st);
    }
    G.apply(st, e, now, g.bufferSeconds * 1000);
    let t = this.tokens.get(e.mint);
    if (!this.gradTracked.has(e.mint)) {
      // 1. Scout: start following a token once its curve holds enough real SOL
      if (st.done || t || st.real < g.trackRealSol) return;
      t = { mint: e.mint, symbol: e.mint.slice(0, 6), mode: 'grad', stage: 'grad', createdAt: now, vSol: st.S, vTokens: st.T, lastTrade: now };
      this.tokens.set(e.mint, t);
      this.feed.watch(e.mint);
      this.gradTracked.set(e.mint, { since: now });
      this.gradRec.start(e.mint, now, st.buf, this.positionSize(), st);
      this.touch('scout', `verfolge ${t.symbol} (${st.real.toFixed(1)} SOL in der Kurve)`);
      this.logger.log('scout', `Verfolge ${t.symbol}… – ${st.real.toFixed(1)} SOL in der Kurve`);
    } else {
      this.gradRec.trade(e.mint, now, e);
    }
    if (!t) return;
    t.vSol = st.S; t.vTokens = st.T; t.lastTrade = now;
    if (this.positions.has(e.mint)) return this.checkPosition(t);
    if (st.entered || t.stage === 'buying') return;
    // 2./3. Filter + Analyst: progress window and buying momentum (one entry per token)
    const m = G.signal(st, now, g.entry);
    if (!m) return;
    st.entered = true;
    const why = G.describeSignal(st, m, g.entry);
    this.touch('analyst', `✓ ${t.symbol}: ${why}`);
    this.logger.decision('analyst', 'APPROVE', { mint: t.mint, symbol: t.symbol, reason: `Graduation-Signal: ${why}` });
    this.executeBuy(t, { mode: 'grad', reason: why });
  }

  endTracking(mint, why) {
    const tr = this.gradTracked.get(mint);
    if (!tr) return;
    this.gradTracked.delete(mint);
    this.gradRec.finish(mint, Date.now());
    const st = this.scanner.get(mint); if (st) st.done = true;
    const t = this.tokens.get(mint);
    if (t && !this.positions.has(mint)) { t.stage = 'done'; this.release(t); }
  }

  gradHousekeeping() {
    const g = this.cfg.graduation, now = Date.now();
    for (const [mint, tr] of this.gradTracked) {
      const t = this.tokens.get(mint);
      if (now - tr.since >= g.maxTrackMinutes * 60000) this.endTracking(mint, 'Zeit');
      else if (t && now - t.lastTrade >= g.inactiveMinutes * 60000) this.endTracking(mint, 'inaktiv');
    }
    // forget quiet curves: tokens with known wallet history after 3 h, others after 15 min
    for (const [mint, st] of this.scanner) {
      if (this.gradTracked.has(mint)) continue;
      if (now - st.lastTrade > (st.holders ? 3 * 3600000 : 15 * 60000)) this.scanner.delete(mint);
    }
    if (now - (this.lastScannerSave || 0) > 10 * 60000) { this.lastScannerSave = now; this.saveScanner(); } // also survives crashes
    let known = 0; for (const st of this.scanner.values()) if (st.holders) known++;
    this.agents.scout.state = `verfolgt ${this.gradTracked.size} · scannt ${this.scanner.size} (${known} mit Wallet-Historie)`;
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
    const why = S.entryCheck(f, sc, this.cfg.analyst);
    if (why) return this.reject(t, 'analyst', `${why} (${detail})`, { score: fmt(sc, 3) });
    this.touch('analyst', `✓ ${t.symbol} Score ${fmt(sc, 2)}`);
    this.logger.decision('analyst', 'APPROVE', { mint: t.mint, symbol: t.symbol, score: fmt(sc, 3), reason: `Score ${fmt(sc, 2)} ≥ ${this.cfg.analyst.minScore} (${detail})` });
    this.executeBuy(t);
  }

  // Research: record every token's full trade history from creation, so the optimizer can replay it with
  // other observation windows (entry after 5/10/15/20/30 s), entry thresholds and exit rules.
  observeWindows() {
    return [...new Set([...(this.baseCfg.research.observeWindows || [5, 10, 15, 20, 30]), this.cfg.filter.observeSeconds])].sort((a, b) => a - b);
  }
  startRecording(t) {
    const r = this.baseCfg.research;
    if (!r.enabled || (this.feed.billed && this.usage.ratio() >= 0.8)) return;
    const ex = this.cfg.executor, maxW = Math.max(...this.observeWindows()) * 1000;
    this.recorder.start(t, this.positionSize());
    // After the longest observation window: keep only tokens that would be a candidate in some window.
    setTimeout(() => {
      const rec = this.recorder.get(t.mint);
      if (!rec) return;
      const minScore = r.minScore ?? this.baseCfg.analyst.minScore;
      const keep = this.observeWindows().some((W) => { const e = S.entryAt(rec, W, this.baseCfg); return e && e.score >= minScore; });
      if (!keep) { this.recorder.drop(t.mint); this.release(t); return; }
      // ...and follow it long enough to simulate exits after the latest possible entry
      setTimeout(() => { this.recorder.finish(t.mint, Date.now()); this.release(t); }, 2 * ex.delayMs + r.horizonSeconds * 1000 + 1000);
    }, maxW + 50);
  }

  // ---------- 4. Executor ----------
  // Position size: fixed (positionSizePct of the start capital) or a percentage of current equity;
  // never more than maxPositionPctOfEquity of the current equity.
  positionSize() {
    const e = this.cfg.executor, eq = this.equityNow();
    let size = (e.sizing === 'percent' ? eq : this.cfg.startCapital) * (e.positionSizePct / 100);
    if (e.maxPositionPctOfEquity > 0) size = Math.min(size, eq * (e.maxPositionPctOfEquity / 100));
    return size;
  }

  async executeBuy(t, info = {}) {
    const e = this.cfg.executor;
    if (this.positions.size + this.pendingBuys >= e.maxOpenPositions) return this.reject(t, 'executor', `Max. ${e.maxOpenPositions} offene Positionen`);
    const size = this.positionSize();
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
      peakPrice: price, openedAt: Date.now(), trailing: false, selling: false, netPct: 0, score: t.score, mode: info.mode || 'new' };
    this.positions.set(t.mint, pos);
    t.stage = 'position';
    this.agents.executor.state = 'idle';
    this.touch('executor', `✓ BUY ${t.symbol} ${fmt(size)} SOL`);
    this.logger.decision('executor', 'BUY', { mint: t.mint, symbol: t.symbol, price: price.toExponential(4), sol: fmt(pos.costSol, 5),
      tokens: Math.round(tokens), score: t.score === undefined ? '' : fmt(t.score, 3),
      reason: `Sim-Kauf${info.mode === 'grad' ? ' (Graduation)' : ''} ${fmt(size, 4)} SOL (${e.sizing === 'percent' ? e.positionSizePct + '% vom Guthaben' : 'fester Einsatz'}), Fee ${e.feePct}%, Prio ${e.priorityFeeSol} SOL, Delay ${e.delayMs}ms` });
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
    let out = this.liquidation(t, pos);
    if (!Number.isFinite(out)) { this.logger.log('executor', `Ungültiger Kurs für ${t.symbol} – Verkauf als Totalverlust gewertet`, 'error'); out = 0; }
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
    const r = pos.mode === 'grad' ? this.cfg.graduation.risk : this.cfg.risk, now = Date.now(), price = t.vSol / t.vTokens;
    const wasTrailing = pos.trailing;
    const code = S.priceExit(pos, price, r, t.vSol) || S.timeExit(now - pos.openedAt, now - Math.max(t.lastTrade, pos.openedAt), r);
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
    if (this.mode === 'graduation') { if (!this.feed.connected) this.agents.scout.state = 'offline'; return; }
    const w = this.watchingCount();
    this.agents.scout.state = !this.feed.connected ? 'offline' : this.feed.billed && this.usage.overBudget() ? 'Budget erreicht' : `beobachtet ${w}`;
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
      fs.writeFileSync(this.tunedPath, JSON.stringify({ at: rep.at, strategyVersion: S.STRATEGY_VERSION, params: b.params, test: b.test, all: b.all }, null, 2));
      this.tuned = JSON.parse(fs.readFileSync(this.tunedPath, 'utf8'));
      const merged = S.mergeConfig(this.baseCfg, this.tuned);
      Object.assign(this.cfg.filter, merged.filter); Object.assign(this.cfg.analyst, merged.analyst); Object.assign(this.cfg.risk, merged.risk);
      if (merged.graduation) { Object.assign(this.cfg.graduation.entry, merged.graduation.entry); Object.assign(this.cfg.graduation.risk, merged.graduation.risk); }
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
    const diff = (cur, base) => { for (const k of Object.keys(cur)) if (typeof cur[k] !== 'object' && cur[k] !== base[k]) tunedKeys.push(k); };
    const grad = this.mode === 'graduation', g = this.cfg.graduation;
    if (grad) { diff(g.entry, this.baseCfg.graduation.entry); diff(g.risk, this.baseCfg.graduation.risk); }
    else for (const sec of ['filter', 'analyst', 'risk']) diff(this.cfg[sec], this.baseCfg[sec]);
    const a = this.cfg.analyst, r = grad ? g.risk : this.cfg.risk;
    const entryParams = grad
      ? { minRealSol: g.entry.minRealSol, maxRealSol: g.entry.maxRealSol, lookbackSeconds: g.entry.lookbackSeconds, minNetSol: g.entry.minNetSol, minBuyers: g.entry.minBuyers, minSells: g.entry.minSells || 0, maxTopBuyerShare: g.entry.maxTopBuyerShare || 0, requireKnown: !!g.entry.requireKnown, minAgeSeconds: g.entry.minAgeSeconds || 0, maxEarlyPct: g.entry.maxEarlyPct || 0, maxTopHolderPct: g.entry.maxTopHolderPct || 0, maxUnknownPct: g.entry.maxUnknownPct || 0 }
      : { observeSeconds: this.cfg.filter.observeSeconds, minScore: a.minScore, minUniqueBuyers: a.minUniqueBuyers, maxPriceChangePct: a.maxPriceChangePct, maxTop10Pct: a.maxTop10Pct || 0 };
    return {
      connected: this.feed.connected, tradesBlocked: this.feed.tradesBlocked, mock: process.env.MOCK === '1',
      msgCount: this.feed.msgCount, uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
      cash: this.cash, equity: this.equityNow(), startCapital: this.cfg.startCapital, positionSize: this.positionSize(),
      sizing: this.cfg.executor.sizing === 'percent' ? `${this.cfg.executor.positionSizePct}% vom Guthaben` : 'fest',
      agents: this.agents, equityCurve: this.equity,
      positions: [...this.positions.values()].map((p) => ({ symbol: p.symbol, mint: p.mint, costSol: p.costSol,
        pnlPct: p.netPct, trailing: p.trailing, heldS: Math.round((Date.now() - p.openedAt) / 1000) })),
      closed: this.closed.slice(-30).reverse(),
      stats: { trades: this.closed.length, wins, winRate: this.closed.length ? wins / this.closed.length : 0,
        tradesLastHour: this.closed.filter((c) => c.closedAt > hourAgo).length, watching: grad ? this.gradTracked.size : this.watchingCount() },
      usage: { ...this.usage.state(), billed: !!this.feed.billed },
      feed: this.feed.info ? this.feed.info() : { source: process.env.MOCK === '1' ? 'mock' : 'pumpportal' },
      research: grad ? { active: this.gradRec.active.size, recorded: this.gradRec.written } : { active: this.recorder.active.size, recorded: this.recorder.written },
      strategy: {
        mode: this.mode, tunedKeys, tunedAt: this.tuned ? this.tuned.at : null,
        params: { ...entryParams, ...(grad ? { exitRealSol: r.exitRealSol } : {}),
          stopLossPct: r.stopLossPct, takeProfitPct: r.takeProfitPct, trailingActivationPct: r.trailingActivationPct,
          trailingDistancePct: r.trailingDistancePct, maxHoldMinutes: r.maxHoldMinutes, stallExitSeconds: r.stallExitSeconds },
      },
      optimizer: { running: this.optRunning, report: this.optReport, minTrades: this.baseCfg.optimizer.minTrades },
      log: this.logger.lines.slice(-150),
    };
  }
}
module.exports = Bot;
