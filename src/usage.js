// Meters PumpPortal trade messages (billed: 0.01 SOL per 10,000) and enforces a daily data budget.
const fs = require('fs');
const H = 3600000;

class Usage {
  constructor(file, cfg) {
    this.file = file; this.cfg = cfg; this.session = 0;
    try { this.buckets = JSON.parse(fs.readFileSync(file, 'utf8')).buckets || {}; } catch { this.buckets = {}; }
    setInterval(() => this.save(), 60000).unref();
  }
  add(n = 1) { const h = Math.floor(Date.now() / H); this.buckets[h] = (this.buckets[h] || 0) + n; this.session += n; }
  msgsLast(hours) {
    const h = Math.floor(Date.now() / H); let s = 0;
    for (const k in this.buckets) if (Number(k) > h - hours) s += this.buckets[k];
    return s;
  }
  cost(msgs) { return (msgs / 10000) * this.cfg.solPer10kMessages; }
  cost24h() { return this.cost(this.msgsLast(24)); }
  ratio() { return this.cfg.maxSolPerDay > 0 ? this.cost24h() / this.cfg.maxSolPerDay : 0; }
  overBudget() { return this.cfg.maxSolPerDay > 0 && this.ratio() >= 1; }
  save() {
    const h = Math.floor(Date.now() / H);
    for (const k in this.buckets) if (Number(k) < h - 48) delete this.buckets[k];
    try { fs.writeFileSync(this.file, JSON.stringify({ buckets: this.buckets })); } catch {}
  }
  state() {
    return { session: this.session, msgs1h: this.msgsLast(1), msgs24h: this.msgsLast(24), cost24h: this.cost24h(),
      costSession: this.cost(this.session), budget: this.cfg.maxSolPerDay, overBudget: this.overBudget() };
  }
}
module.exports = Usage;
