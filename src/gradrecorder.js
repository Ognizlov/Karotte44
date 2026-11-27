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
  // buffer: the scanner's recent trades [[timeMs, isBuy, sol, user, event]] incl. the one that started tracking
  start(mint, now, buffer, refSol) {
    const startAt = buffer.length ? buffer[0][0] : now;
    const r = { v: 'g1', mint, startAt, trackDt: now - startAt, refSol, users: [], uidx: new Map(), trades: [], events: [] };
    this.active.set(mint, r);
    for (const b of buffer) this.trade(mint, b[0], b[4]);
  }
  trade(mint, now, e) {
    const r = this.active.get(mint);
    if (!r) return;
    let u = r.uidx.get(e.user);
    if (u === undefined) { u = r.users.length; r.users.push(e.user); r.uidx.set(e.user, u); }
    r.trades.push([now - r.startAt, e.isBuy ? 1 : 0, e.sol, u, e.vSol, e.vTokens, e.slot || 0]);
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
