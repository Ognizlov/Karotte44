// Records the price path of every "candidate" (token passing the base thresholds in config.json) as if it
// had been bought, whether or not the live bot bought it. The optimizer learns from these paths.
const fs = require('fs');
const path = require('path');

class Recorder {
  constructor(dir) {
    this.dir = dir; this.active = new Map(); this.written = 0;
    fs.mkdirSync(dir, { recursive: true });
    // keep one week of recordings
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^candidates-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (m && Date.now() - Date.parse(m[1]) > 8 * 86400000) fs.unlinkSync(path.join(dir, f));
    }
  }
  isActive(mint) { return this.active.has(mint); }
  start(mint, meta) { this.active.set(mint, { mint, ...meta, path: null }); }
  fill(mint, now, S, T) { const c = this.active.get(mint); if (c) { c.fillAt = now; c.path = [[0, +S.toFixed(6), Math.round(T)]]; } }
  point(mint, now, S, T) { const c = this.active.get(mint); if (c && c.path) c.path.push([now - c.fillAt, +S.toFixed(6), Math.round(T)]); }
  finish(mint, now) {
    const c = this.active.get(mint);
    if (!c) return;
    this.active.delete(mint);
    if (!c.path) return;
    c.endDt = now - c.fillAt;
    const file = path.join(this.dir, `candidates-${new Date(c.decidedAt).toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(c) + '\n');
    this.written++;
  }
  finishAll(now) { for (const mint of [...this.active.keys()]) this.finish(mint, now); }
}
module.exports = Recorder;
