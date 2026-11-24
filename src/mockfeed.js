// SYNTHETIC test feed (no network) – used only by `npm run mock` to exercise the
// full pipeline when no PumpPortal API key is available. Not market data.
const { EventEmitter } = require('events');
const rnd = (a, b) => a + Math.random() * (b - a);
const key = () => [...Array(44)].map(() => '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[Math.floor(Math.random() * 58)]).join('');

class MockFeed extends EventEmitter {
  constructor(url, logger) { super(); this.logger = logger; this.mints = new Map(); this.connected = false; this.msgCount = 0; this.tradesBlocked = false; }
  connect() {
    this.connected = true;
    this.logger.log('feed', 'MOCK-Feed aktiv – synthetische Daten, keine echten Marktdaten', 'warn');
    setInterval(() => this.newToken(), 2500);
    setInterval(() => { for (const s of this.mints.values()) if (Math.random() < s.activity) this.trade(s); }, 400);
  }
  newToken() {
    const s = { mint: key(), dev: key(), vSol: 30, vTokens: 1073000000, traders: [], activity: Math.random() < 0.6 ? 0.01 : rnd(0.1, 0.9),
      drift: rnd(-0.35, 0.45), devDumps: Math.random() < 0.1 };
    const devSol = Math.random() < 0.2 ? rnd(2, 4) : rnd(0, 1.2);
    const tok = s.vTokens - (s.vSol * s.vTokens) / (s.vSol + devSol);
    s.vSol += devSol; s.vTokens -= tok; s.devBal = tok;
    this.pending = s; this.msgCount++;
    this.emit('create', { txType: 'create', mint: s.mint, traderPublicKey: s.dev, initialBuy: tok, symbol: 'MOCK' + s.mint.slice(0, 3),
      vSolInBondingCurve: s.vSol, vTokensInBondingCurve: s.vTokens });
  }
  trade(s) {
    let trader, buy;
    if (s.devDumps && s.devBal > 0 && Math.random() < 0.05) { trader = s.dev; buy = false; }
    else {
      buy = Math.random() < 0.5 + s.drift;
      const holders = s.traders.filter((t) => t.bal > 0);
      if (!buy && holders.length) trader = holders[Math.floor(Math.random() * holders.length)];
      else { buy = true; trader = Math.random() < 0.7 || !s.traders.length ? { pk: key(), bal: 0 } : s.traders[Math.floor(Math.random() * s.traders.length)]; if (!s.traders.includes(trader)) s.traders.push(trader); }
    }
    const pk = trader === s.dev ? s.dev : trader.pk;
    const k = s.vSol * s.vTokens; let sol, tokens, bal;
    if (buy) { sol = rnd(0.05, 1.5); tokens = s.vTokens - k / (s.vSol + sol); s.vSol += sol; s.vTokens -= tokens; trader.bal += tokens; bal = trader.bal; }
    else {
      const have = trader === s.dev ? s.devBal : trader.bal; tokens = have * rnd(0.3, 1);
      sol = s.vSol - k / (s.vTokens + tokens); s.vSol -= sol; s.vTokens += tokens;
      if (trader === s.dev) bal = s.devBal -= tokens; else bal = trader.bal -= tokens;
    }
    this.msgCount++;
    this.emit('trade', { txType: buy ? 'buy' : 'sell', mint: s.mint, traderPublicKey: pk, solAmount: sol, tokenAmount: tokens,
      newTokenBalance: bal, pool: 'pump', vSolInBondingCurve: s.vSol, vTokensInBondingCurve: s.vTokens });
  }
  watch(mint) { if (this.pending && this.pending.mint === mint) this.mints.set(mint, this.pending); }
  unwatch(mint) { this.mints.delete(mint); }
}
module.exports = MockFeed;
