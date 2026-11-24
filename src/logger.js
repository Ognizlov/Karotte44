const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class Logger extends EventEmitter {
  constructor(cfg, root) {
    super();
    this.logPath = path.join(root, cfg.logFile);
    this.csvPath = path.join(root, cfg.tradesCsv);
    this.maxLines = cfg.memoryLines;
    this.lines = [];
    this.setMaxListeners(0);
    if (!fs.existsSync(this.csvPath)) {
      fs.writeFileSync(this.csvPath, 'time,module,action,mint,symbol,price_sol,sol,tokens,pnl_sol,pnl_pct,score,reason\n');
    }
  }
  log(module, msg, level = 'info') {
    const entry = { t: new Date().toISOString(), module, level, msg };
    fs.appendFile(this.logPath, `${entry.t} [${module}] ${level.toUpperCase()} ${msg}\n`, () => {});
    this.lines.push(entry);
    if (this.lines.length > this.maxLines) this.lines.shift();
    this.emit('line', entry);
  }
  // Every decision: printed to log.txt and appended to trades.csv
  decision(module, action, d) {
    const esc = (v) => (v === undefined || v === null ? '' : `"${String(v).replace(/"/g, '""')}"`);
    const row = [new Date().toISOString(), module, action, d.mint, d.symbol, d.price, d.sol, d.tokens, d.pnlSol, d.pnlPct, d.score, d.reason];
    fs.appendFile(this.csvPath, row.map(esc).join(',') + '\n', () => {});
    this.log(module, `${action} ${d.symbol || ''} ${d.mint ? d.mint.slice(0, 8) : ''} – ${d.reason}`, action === 'REJECT' ? 'warn' : 'info');
  }
}
module.exports = Logger;
