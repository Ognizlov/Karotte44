// Records the full trade history of every new token from its creation (data/tokens-YYYY-MM-DD.jsonl).
// The optimizer replays these tokens to test entry timing, entry thresholds and exit rules.
const fs = require('fs');
const path = require('path');

class Recorder {
  constructor(dir) {
    this.dir = dir; this.active = new Map(); this.written = 0;
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^(?:tokens|candidates)-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (m && Date.now() - Date.parse(m[1]) > 8 * 86400000) fs.unlinkSync(path.join(dir, f));
    }
    try { for (const f of fs.readdirSync(dir)) if (/^tokens-.*\.jsonl$/.test(f)) this.written += fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).length; } catch {}
  }
  isActive(mint) { return this.active.has(mint); }
  start(t, refSol) {
    this.active.set(t.mint, { v: 2, mint: t.mint, symbol: t.symbol, createdAt: t.createdAt, refSol,
      create: { dev: t.dev, initialBuy: t.initialBuy, vSol: t.vSol, vTokens: t.vTokens },
      users: [], uidx: new Map(), trades: [], events: [] });
  }
  get(mint) { return this.active.get(mint); }
  trade(mint, now, m) {
    const r = this.active.get(mint);
    if (!r) return;
    let u = r.uidx.get(m.traderPublicKey);
    if (u === undefined) { u = r.users.length; r.users.push(m.traderPublicKey); r.uidx.set(m.traderPublicKey, u); }
    r.trades.push([now - r.createdAt, u, m.txType === 'buy' ? 1 : 0, Number(m.solAmount) || 0, Number(m.tokenAmount) || 0,
      m.newTokenBalance === undefined ? undefined : Number(m.newTokenBalance), Number(m.vSolInBondingCurve), Number(m.vTokensInBondingCurve)]);
  }
  event(mint, now, kind) { const r = this.active.get(mint); if (r) r.events.push([now - r.createdAt, kind]); }
  drop(mint) { this.active.delete(mint); }
  finish(mint, now) {
    const r = this.active.get(mint);
    if (!r) return;
    this.active.delete(mint);
    r.endDt = now - r.createdAt;
    delete r.uidx;
    const file = path.join(this.dir, `tokens-${new Date(r.createdAt).toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(r) + '\n');
    this.written++;
  }
  finishAll(now) { for (const mint of [...this.active.keys()]) this.finish(mint, now); }
}
module.exports = Recorder;
