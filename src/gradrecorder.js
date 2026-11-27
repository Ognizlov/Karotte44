// Records the trades of tracked older tokens (data/grad-YYYY-MM-DD.jsonl) for the graduation optimizer.
const fs = require('fs');
const path = require('path');

class GradRecorder {
  constructor(dir) {
    this.dir = dir; this.active = new Map(); this.written = 0;
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^grad-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m) continue;
      if (Date.now() - Date.parse(m[1]) > 8 * 86400000) fs.unlinkSync(path.join(dir, f));
      else this.written += fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).length;
    }
  }
  isActive(mint) { return this.active.has(mint); }
  // buffer: the scanner's recent trades [[timeMs, isBuy, sol, user, event]] incl. the one that started tracking.
  // holders: wallet balances after those trades (Map) if the token was seen from creation, else undefined.
  start(mint, now, buffer, refSol, holders) {
    const startAt = buffer.length ? buffer[0][0] : now;
    const r = { v: 'g2', mint, startAt, trackDt: now - startAt, bufN: buffer.length, refSol, users: [], uidx: new Map(), trades: [], events: [], holders: null };
    this.active.set(mint, r);
    for (const b of buffer) this.trade(mint, b[0], b[4]);
    if (holders) r.holders = [...holders].filter(([, bal]) => Math.abs(bal) > 1e-9).map(([u, bal]) => [this.uid(r, u), bal]);
  }
  uid(r, user) {
    let u = r.uidx.get(user);
    if (u === undefined) { u = r.users.length; r.users.push(user); r.uidx.set(user, u); }
    return u;
  }
  trade(mint, now, e) {
    const r = this.active.get(mint);
    if (!r) return;
    r.trades.push([now - r.startAt, e.isBuy ? 1 : 0, e.sol, this.uid(r, e.user), e.vSol, e.vTokens, e.slot || 0, e.tokens]);
  }
  event(mint, now, kind) { const r = this.active.get(mint); if (r) r.events.push([now - r.startAt, kind]); }
  finish(mint, now) {
    const r = this.active.get(mint);
    if (!r) return;
    this.active.delete(mint);
    r.endDt = now - r.startAt;
    delete r.uidx;
    fs.appendFileSync(path.join(this.dir, `grad-${new Date(r.startAt).toISOString().slice(0, 10)}.jsonl`), JSON.stringify(r) + '\n');
    this.written++;
  }
  finishAll(now) { for (const m of [...this.active.keys()]) this.finish(m, now); }
}
module.exports = GradRecorder;
