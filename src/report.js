// Short analysis of the simulated trades (trades.csv) to paste into the chat:  npm run report
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const file = path.join(root, 'trades.csv');
if (!fs.existsSync(file)) { console.log('Noch keine trades.csv vorhanden.'); process.exit(0); }

function parseLine(l) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map(parseLine);
const buys = new Map(), trades = [];
for (const r of rows) {
  const [time, , action, mint, symbol, , , , pnlSol, pnlPct, score, reason] = r;
  if (action === 'BUY') buys.set(mint, { score: Number(score), time: Date.parse(time) });
  if (action === 'SELL') {
    const b = buys.get(mint) || {};
    trades.push({ symbol, pnlSol: Number(pnlSol), pnlPct: Number(pnlPct), reason, score: b.score, heldS: b.time ? (Date.parse(time) - b.time) / 1000 : null });
  }
}
const invalid = trades.filter((t) => !Number.isFinite(t.pnlPct) || !Number.isFinite(t.pnlSol)).length;
for (let i = trades.length - 1; i >= 0; i--) if (!Number.isFinite(trades[i].pnlPct) || !Number.isFinite(trades[i].pnlSol)) trades.splice(i, 1);
if (!trades.length) { console.log('Noch keine abgeschlossenen Trades.'); process.exit(0); }
const f = (x, d = 1) => (x >= 0 ? '+' : '') + x.toFixed(d);
const sum = (a, k) => a.reduce((s, t) => s + t[k], 0);
const line = (name, a) => a.length ? `${name.padEnd(22)} ${String(a.length).padStart(4)} Trades | Ø ${f(sum(a, 'pnlPct') / a.length).padStart(6)}% | Gewinner ${String(Math.round(a.filter((t) => t.pnlSol > 0).length / a.length * 100)).padStart(3)}% | Summe ${f(sum(a, 'pnlSol'), 4)} SOL` : null;
const wins = trades.filter((t) => t.pnlSol > 0), losses = trades.filter((t) => t.pnlSol <= 0);
console.log('=== Karotte44 Report ===');
console.log(line('Alle', trades));
console.log(`Ø Gewinner ${wins.length ? f(sum(wins, 'pnlPct') / wins.length) : '-'}% · Ø Verlierer ${losses.length ? f(sum(losses, 'pnlPct') / losses.length) : '-'}% · Ø Haltezeit ${Math.round(trades.filter((t) => t.heldS).reduce((s, t) => s + t.heldS, 0) / Math.max(1, trades.filter((t) => t.heldS).length))} s`);
console.log('\n-- nach Verkaufsgrund --');
const kinds = [['Stop-Loss', /^Stop-Loss/], ['Take-Profit', /^Take-Profit/], ['Trailing-Stop', /^Trailing/], ['Keine Trades mehr', /^Kein Trade/], ['Max. Haltezeit', /^Max\. Haltezeit/], ['Sonstiges', /./]];
const used = new Set();
for (const [name, re] of kinds) {
  const a = trades.filter((t) => !used.has(t) && re.test(t.reason)); a.forEach((t) => used.add(t));
  const l = line(name, a); if (l) console.log(l);
}
console.log('\n-- nach Score beim Kauf --');
for (const [lo, hi] of [[0, 0.6], [0.6, 0.75], [0.75, 0.9], [0.9, 1.01]]) {
  const l = line(`Score ${lo.toFixed(2)}–${Math.min(hi, 1).toFixed(2)}`, trades.filter((t) => t.score >= lo && t.score < hi)); if (l) console.log(l);
}
let cands = 0;
const dataDir = path.join(root, 'data');
if (fs.existsSync(dataDir)) for (const x of fs.readdirSync(dataDir)) if (/^candidates-.*\.jsonl$/.test(x)) cands += fs.readFileSync(path.join(dataDir, x), 'utf8').split('\n').filter(Boolean).length;
console.log(`\nAufgezeichnete Kandidaten für den Optimizer: ${cands}`);
if (invalid) console.log(`(${invalid} Trades mit ungültigem Ergebnis aus älteren Versionen nicht mitgezählt)`);
