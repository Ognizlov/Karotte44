// Paper-trading pipeline: Scout -> Filter -> Analyst -> Executor -> Risk -> Logger
// SIMULATION ONLY. No wallet, no private key, no transactions are ever sent.
const Feed = process.env.MOCK === '1' ? require('./mockfeed') : require('./feed');
const Logger = require('./logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const fmt = (x, d = 4) => Number(x).toFixed(d);

class Bot {
  constructor(cfg, root) {
    this.cfg = cfg;
    this.logger = new Logger(cfg.logger, root);
    this.feed = new Feed(cfg.wsUrl, this.logger);
    this.cash = cfg.startCapital;
    this.pendingSol = 0; // funds reserved for buys in flight
    this.tokens = new Map();     // mint -> observed token state
    this.positions = new Map();  // mint -> open position
    this.closed = [];
    this.equity = [{ t: Date.now(), v: cfg.startCapital }];
    this.startedAt = Date.now();
    const agent = (state) => ({ state, last: '-', count: 0 });
    this.agents = {
      scout: agent('idle'), filter: agent('idle'), analyst: agent('idle'),
      executor: agent('idle'), risk: agent('idle'), logger: agent('aktiv'),
    };
    this.logger.on('line', () => { this.agents.logger.count++; });
  }

  touch(name, last, state) {
    const a = this.agents[name]; a.count++; a.last = last; if (state) a.state = state;
  }

  start() {
    this.logger.log('system', `Start – Paper-Trading, Kapital ${this.cfg.startCapital} SOL (SIMULATION, kein Wallet)`);
    this.feed.on('create', (m) => this.scout(m));
    this.feed.on('trade', (m) => this.onTrade(m));
    this.feed.connect();
    setInterval(() => this.riskTick(), this.cfg.risk.checkIntervalMs);
    setInterval(() => this.recordEquity(), 5000);
  }

  // ---------- 1. Scout ----------
  scout(m) {
    if (!m.mint || this.tokens.has(m.mint)) return;
    const watching = [...this.tokens.values()].filter((t) => t.stage === 'watching').length;
    this.agents.scout.state = `beobachtet ${watching}`;
    if (watching >= this.cfg.scout.maxWatching) {
      this.touch('scout', `übersprungen ${m.symbol} (Kapazität)`);
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
    t.startPrice = t.vSol / t.vTokens;
    if (t.initialBuy > 0) t.balances.set(t.dev, t.initialBuy);
    this.tokens.set(m.mint, t);
    this.feed.watch(m.mint);
    this.touch('scout', `neu: ${t.symbol} (Dev-Buy ${fmt((t.initialBuy / supply) * 100, 2)}%)`);
    this.logger.log('scout', `Neuer Token ${t.symbol} ${m.mint.slice(0, 8)} – Dev-Initialbuy ${fmt((t.initialBuy / supply) * 100, 2)}%`);
    t.timer = setTimeout(() => this.filter(t), this.cfg.filter.observeSeconds * 1000);
  }

  onTrade(m) {
    const t = this.tokens.get(m.mint);
    if (!t) return;
    t.vSol = Number(m.vSolInBondingCurve); t.vTokens = Number(m.vTokensInBondingCurve);
    t.lastTrade = Date.now();
    const sol = Number(m.solAmount) || 0;
    t.volumeSol += sol;
    if (m.newTokenBalance !== undefined) t.balances.set(m.traderPublicKey, Number(m.newTokenBalance));
    if (m.txType === 'buy') { t.buys++; t.buyers.add(m.traderPublicKey); }
    else {
      t.sells++;
      if (m.traderPublicKey === t.dev) t.devSold = true;
    }
    if (t.stage === 'watching' && t.devSold && this.cfg.filter.rejectIfDevSells) {
      clearTimeout(t.timer);
      this.reject(t, 'filter', 'Dev hat verkauft');
    }
    if (t.stage === 'position') this.checkPosition(t);
  }

  reject(t, module, reason, extra = {}) {
    t.stage = 'done';
    this.feed.unwatch(t.mint);
    this.touch(module, `✗ ${t.symbol}: ${reason}`);
    this.logger.decision(module, 'REJECT', { mint: t.mint, symbol: t.symbol, price: t.vSol / t.vTokens, reason, ...extra });
    setTimeout(() => this.tokens.delete(t.mint), 60000);
  }

  // ---------- 2. Filter ----------
  filter(t) {
    if (t.stage !== 'watching') return;
    const f = this.cfg.filter, supply = this.cfg.totalSupply;
    const devPct = (t.initialBuy / supply) * 100;
    if (devPct > f.maxDevInitialBuyPct) return this.reject(t, 'filter', `Dev-Initialbuy ${fmt(devPct, 2)}% > ${f.maxDevInitialBuyPct}%`);
    if (t.devSold && f.rejectIfDevSells) return this.reject(t, 'filter', 'Dev hat verkauft');
    const top10 = [...t.balances.values()].sort((a, b) => b - a).slice(0, 10).reduce((s, x) => s + x, 0);
    const topPct = (top10 / supply) * 100;
    if (topPct > f.maxTop10HolderPct) return this.reject(t, 'filter', `Top-10-Holder ${fmt(topPct, 1)}% > ${f.maxTop10HolderPct}%`);
    t.top10Pct = topPct;
    this.touch('filter', `✓ ${t.symbol} (Dev ${fmt(devPct, 1)}%, Top10 ${fmt(topPct, 1)}%)`);
    this.logger.log('filter', `PASS ${t.symbol} – Dev ${fmt(devPct, 2)}%, Top10 ${fmt(topPct, 1)}%`);
    this.analyst(t);
  }

  // ---------- 3. Analyst ----------
  analyst(t) {
    const a = this.cfg.analyst, w = a.weights, g = a.targets;
    const ratio = t.sells === 0 ? t.buys : t.buys / t.sells;
    const priceChg = ((t.vSol / t.vTokens) / t.startPrice - 1) * 100;
    const parts = {
      uniqueBuyers: clamp01(t.buyers.size / g.uniqueBuyers),
      buySellRatio: clamp01(ratio / g.buySellRatio),
      volume: clamp01(t.volumeSol / g.volumeSol),
      priceChange: clamp01(priceChg / g.priceChangePct),
    };
    const wsum = w.uniqueBuyers + w.buySellRatio + w.volume + w.priceChange;
    const score = (parts.uniqueBuyers * w.uniqueBuyers + parts.buySellRatio * w.buySellRatio +
      parts.volume * w.volume + parts.priceChange * w.priceChange) / wsum;
    const detail = `Buyers ${t.buyers.size}, B/S ${fmt(ratio, 2)}, Vol ${fmt(t.volumeSol, 2)} SOL, Δ ${fmt(priceChg, 1)}%`;
    t.score = score;
    if (score < a.minScore) return this.reject(t, 'analyst', `Score ${fmt(score, 2)} < ${a.minScore} (${detail})`, { score: fmt(score, 3) });
    this.touch('analyst', `✓ ${t.symbol} Score ${fmt(score, 2)}`);
    this.logger.decision('analyst', 'APPROVE', { mint: t.mint, symbol: t.symbol, score: fmt(score, 3), reason: `Score ${fmt(score, 2)} ≥ ${a.minScore} (${detail})` });
    this.executeBuy(t);
  }

  // ---------- Bonding curve math (constant product on virtual reserves) ----------
  quoteBuy(t, solIn) {
    const net = solIn * (1 - this.cfg.executor.feePct / 100);
    const k = t.vSol * t.vTokens;
    return t.vTokens - k / (t.vSol + net);
  }
  quoteSell(t, tokens) {
    const k = t.vSol * t.vTokens;
    const gross = t.vSol - k / (t.vTokens + tokens);
    return gross * (1 - this.cfg.executor.feePct / 100);
  }

  // ---------- 4. Executor ----------
  async executeBuy(t) {
    const e = this.cfg.executor;
    if (this.positions.size >= e.maxOpenPositions) return this.reject(t, 'executor', `Max. ${e.maxOpenPositions} offene Positionen`);
    const size = this.equityNow() * (e.positionSizePct / 100);
    if (this.cash < size + e.priorityFeeSol) return this.reject(t, 'executor', `Zu wenig Cash (${fmt(this.cash)} SOL)`);
    t.stage = 'buying';
    this.cash -= size + e.priorityFeeSol; // reserve funds during latency
    this.pendingSol += size + e.priorityFeeSol;
    this.touch('executor', `kaufe ${t.symbol}…`, 'Order läuft');
    await sleep(e.delayMs); // simulated network/landing latency
    this.pendingSol -= size + e.priorityFeeSol;
    const tokens = this.quoteBuy(t, size);
    const price = t.vSol / t.vTokens;
    const pos = { mint: t.mint, symbol: t.symbol, tokens, costSol: size + e.priorityFeeSol, entryPrice: price,
      peakPrice: price, openedAt: Date.now(), trailing: false, selling: false, lastPnlPct: 0, score: t.score };
    this.positions.set(t.mint, pos);
    t.stage = 'position';
    this.agents.executor.state = 'idle';
    this.touch('executor', `✓ BUY ${t.symbol} ${fmt(size)} SOL`);
    this.logger.decision('executor', 'BUY', { mint: t.mint, symbol: t.symbol, price: price.toExponential(4), sol: fmt(pos.costSol, 5),
      tokens: Math.round(tokens), score: fmt(t.score, 3),
      reason: `Sim-Kauf ${e.positionSizePct}% Kapital, Fee ${e.feePct}%, Prio ${e.priorityFeeSol} SOL, Delay ${e.delayMs}ms` });
  }

  async executeSell(t, pos, reason) {
    if (pos.selling) return;
    pos.selling = true;
    const e = this.cfg.executor;
    this.touch('executor', `verkaufe ${t.symbol}…`, 'Order läuft');
    await sleep(e.delayMs);
    const out = this.quoteSell(t, pos.tokens) - e.priorityFeeSol;
    const price = t.vSol / t.vTokens;
    this.cash += out;
    const pnl = out - pos.costSol, pnlPct = (pnl / pos.costSol) * 100;
    this.positions.delete(t.mint);
    t.stage = 'done';
    this.feed.unwatch(t.mint);
    setTimeout(() => this.tokens.delete(t.mint), 60000);
    this.closed.push({ symbol: t.symbol, mint: t.mint, pnl, pnlPct, reason, closedAt: Date.now(), heldS: (Date.now() - pos.openedAt) / 1000 });
    if (this.closed.length > 200) this.closed.shift();
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
    const r = this.cfg.risk;
    const price = t.vSol / t.vTokens;
    const chg = (price / pos.entryPrice - 1) * 100;
    pos.lastPnlPct = chg;
    if (price > pos.peakPrice) pos.peakPrice = price;
    const peakChg = (pos.peakPrice / pos.entryPrice - 1) * 100;
    if (!pos.trailing && peakChg >= r.trailingActivationPct) {
      pos.trailing = true;
      this.touch('risk', `Trailing aktiv ${t.symbol}`);
      this.logger.log('risk', `Trailing-Stop aktiviert für ${t.symbol} bei +${fmt(peakChg, 1)}%`);
    }
    let reason = null;
    if (chg <= r.stopLossPct) reason = `Stop-Loss ${fmt(chg, 1)}% ≤ ${r.stopLossPct}%`;
    else if (pos.trailing && price <= pos.peakPrice * (1 - r.trailingDistancePct / 100))
      reason = `Trailing-Stop: ${fmt(r.trailingDistancePct, 1)}% unter Hoch (+${fmt(peakChg, 1)}%), aktuell ${fmt(chg, 1)}%`;
    else if (Date.now() - pos.openedAt >= r.maxHoldMinutes * 60000) reason = `Max. Haltezeit ${r.maxHoldMinutes} min (${fmt(chg, 1)}%)`;
    if (reason) {
      this.touch('risk', `EXIT ${t.symbol}: ${reason}`);
      this.logger.decision('risk', 'EXIT', { mint: t.mint, symbol: t.symbol, price: price.toExponential(4), pnlPct: fmt(chg, 2), reason });
      this.executeSell(t, pos, reason);
    }
  }
  riskTick() {
    this.agents.risk.state = this.positions.size ? `überwacht ${this.positions.size}` : 'idle';
    for (const pos of this.positions.values()) { const t = this.tokens.get(pos.mint); if (t) this.checkPosition(t); }
    const w = [...this.tokens.values()].filter((t) => t.stage === 'watching').length;
    this.agents.scout.state = this.feed.connected ? `beobachtet ${w}` : 'offline';
    this.agents.filter.state = w ? `prüft ${w}` : 'idle';
  }

  // ---------- Equity ----------
  equityNow() {
    let v = this.cash + this.pendingSol;
    for (const pos of this.positions.values()) {
      const t = this.tokens.get(pos.mint);
      v += t ? Math.max(0, this.quoteSell(t, pos.tokens) - this.cfg.executor.priorityFeeSol) : pos.costSol;
    }
    return v;
  }
  recordEquity() {
    this.equity.push({ t: Date.now(), v: this.equityNow() });
    if (this.equity.length > 5000) this.equity.splice(0, this.equity.length - 5000);
  }

  state() {
    const wins = this.closed.filter((c) => c.pnl > 0).length;
    return {
      connected: this.feed.connected, tradesBlocked: this.feed.tradesBlocked, mock: process.env.MOCK === '1', msgCount: this.feed.msgCount, uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
      cash: this.cash, equity: this.equityNow(), startCapital: this.cfg.startCapital,
      agents: this.agents, equityCurve: this.equity,
      positions: [...this.positions.values()].map((p) => ({ symbol: p.symbol, mint: p.mint, costSol: p.costSol,
        pnlPct: p.lastPnlPct, trailing: p.trailing, heldS: Math.round((Date.now() - p.openedAt) / 1000) })),
      closed: this.closed.slice(-30).reverse(),
      stats: { trades: this.closed.length, wins, winRate: this.closed.length ? wins / this.closed.length : 0,
        watching: [...this.tokens.values()].filter((t) => t.stage === 'watching').length },
      log: this.logger.lines.slice(-150),
    };
  }
}
module.exports = Bot;
