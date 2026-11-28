// Diagnosis of the graduation trades (trades.csv + data/grad-*.jsonl):  npm run diagnose
// Prints a compact text report to paste into the chat: result distribution, what happens right after
// the entry, how big losers differ from winners at entry, and who caused the crashes.
const fs = require('fs');
const path = require('path');
const G = require('./gradstrategy');

const root = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const delay = cfg.executor.delayMs, keep = cfg.graduation.bufferSeconds * 1000;

function parseLine(l) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
if (!fs.existsSync(path.join(root, 'trades.csv'))) { console.log('Keine trades.csv gefunden.'); process.exit(0); }
const rows = fs.readFileSync(path.join(root, 'trades.csv'), 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map(parseLine);

// recordings by mint (a mint can have several recordings after restarts)
const recs = new Map();
const dataDir = path.join(root, 'data');
if (fs.existsSync(dataDir)) for (const f of fs.readdirSync(dataDir).filter((x) => /^grad-.*\.jsonl$/.test(x))) {
  for (const line of fs.readFileSync(path.join(dataDir, f), 'utf8').split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (!recs.has(r.mint)) recs.set(r.mint, []); recs.get(r.mint).push(r); } catch {}
  }
}

// graduation trades: APPROVE (signal time) -> BUY (with "(Graduation)") -> SELL of the same mint
const open = new Map(), signalAt = new Map(), trades = [];
for (const r of rows) {
  const [time, module, action, mint, , , , , , pnlPct, , reason] = r;
  if (module === 'analyst' && action === 'APPROVE' && /Graduation-Signal/.test(reason)) signalAt.set(mint, Date.parse(time));
  if (action === 'BUY' && /Graduation/.test(reason)) open.set(mint, { buyAt: Date.parse(time), sigAt: signalAt.get(mint) });
  if (action === 'SELL' && open.has(mint)) { const o = open.get(mint); trades.push({ mint, ...o, sellAt: Date.parse(time), pct: Number(pnlPct), reason }); open.delete(mint); }
}
// optional: only the last N hours, e.g.  npm.cmd run diagnose -- --hours 24
const hi = process.argv.indexOf('--hours');
const sinceMs = hi > 0 ? Date.now() - Number(process.argv[hi + 1]) * 3600000 : 0;
if (sinceMs) for (let i = trades.length - 1; i >= 0; i--) if (trades[i].buyAt < sinceMs) trades.splice(i, 1);
if (!trades.length) { console.log('Noch keine Trades der Strategie „ältere Tokens“ im gewählten Zeitraum.'); process.exit(0); }

const price = (S, T) => S / T;
const f1 = (x) => (x === null || x === undefined || Number.isNaN(x) ? '   -  ' : (x >= 0 ? '+' : '') + x.toFixed(1));

// Rebuild what the bot saw at the decision and what happened afterwards
function analyse(t) {
  const list = recs.get(t.mint) || [];
  const decisionAbs = t.sigAt && t.sigAt <= t.buyAt && t.buyAt - t.sigAt < delay + 2000 ? t.sigAt : t.buyAt - delay;
  const rec = list.find((r) => decisionAbs >= r.startAt && decisionAbs <= r.startAt + r.endDt + 5000);
  if (!rec) return null;
  const dec = decisionAbs - rec.startAt, fill = dec + delay, sell = t.sellAt - rec.startAt;
  // token age at the signal: exact/lower bound if recorded; otherwise inferred when the recording starts at the launch
  let age = null;
  if (rec.ageAtStartMs !== undefined) age = (dec + rec.ageAtStartMs) / 1000;
  else if (rec.trades.length && rec.trades[0][4] < 31) age = (dec - rec.trades[0][0]) / 1000;
  const st = G.replayState(rec), bufN = rec.bufN || 0;
  let i = 0;
  for (; i < rec.trades.length && rec.trades[i][0] <= dec; i++) G.apply(st, G.evOf(rec, rec.trades[i]), rec.trades[i][0], keep, i >= bufN);
  const pDec = price(st.S, st.T), realDec = st.real;
  const m30 = G.momentum(st, dec, 30000), m60 = G.momentum(st, dec, 60000);
  let minP = pDec; for (const b of st.buf) if (b[0] >= dec - 30000 && b[4]) minP = Math.min(minP, price(b[4].vSol, b[4].vTokens));
  const runup30 = (pDec / minP - 1) * 100;
  const h = G.holderStats(st);
  // walk forward: price at fill, +10 s, and the biggest single drop until the sell
  let pFill = null, p10 = null, worst = null, prevP = null;
  for (; i < rec.trades.length; i++) {
    const tr = rec.trades[i], ev = G.evOf(rec, tr);
    if (tr[0] > fill && pFill === null) pFill = price(st.S, st.T);
    if (pFill !== null && tr[0] > fill + 10000 && p10 === null) p10 = price(st.S, st.T);
    const before = price(st.S, st.T), balBefore = st.holders ? (st.holders.get(ev.user) || 0) : null;
    G.apply(st, ev, tr[0], keep, i >= bufN);
    if (tr[0] > fill && tr[0] <= sell + 3000 && !ev.isBuy) {
      const drop = (price(st.S, st.T) / before - 1) * 100;
      if (!worst || drop < worst.drop) {
        const fb = st.firstBuy ? st.firstBuy.get(ev.user) : undefined;
        worst = { drop, sol: ev.sol, afterS: (tr[0] - fill) / 1000, sellerPct: ev.tokens !== undefined ? (ev.tokens / 1e9) * 100 : null,
          sellerBalPct: balBefore !== null ? (balBefore / 1e9) * 100 : null, isDev: st.dev && ev.user === st.dev, sellerFirstBuyS: fb !== undefined ? fb / 1000 : null };
      }
    }
    prevP = price(st.S, st.T);
  }
  if (pFill === null) pFill = prevP;
  return { ...t, real: realDec, m30, m60, runup30, h, age, toFill: (pFill / pDec - 1) * 100, after10: p10 !== null ? (p10 / pFill - 1) * 100 : null, worst, v: rec.v };
}

const A = trades.map(analyse).filter(Boolean);
const sum = (a, k) => a.reduce((s, x) => s + k(x), 0);
console.log('=== Karotte44 Diagnose (Strategie: ältere Tokens / Graduation) ===');
console.log(`Zeitraum: ${new Date(Math.min(...trades.map((x) => x.buyAt))).toLocaleString()} – ${new Date(Math.max(...trades.map((x) => x.buyAt))).toLocaleString()}${sinceMs ? ' (nur letzte ' + process.argv[hi + 1] + ' h)' : ''}`);
console.log(`Trades: ${trades.length}, davon mit Aufzeichnung: ${A.length}, Ø ${f1(sum(trades, (x) => x.pct) / trades.length)}%`);
const buckets = [['≤ -40 %', (p) => p <= -40], ['-40 bis -10 %', (p) => p > -40 && p <= -10], ['-10 bis 0 %', (p) => p > -10 && p <= 0], ['0 bis +10 %', (p) => p > 0 && p <= 10], ['> +10 %', (p) => p > 10]];
console.log('\n-- Verteilung der Ergebnisse --');
for (const [n, fn] of buckets) { const a = trades.filter((x) => fn(x.pct)); console.log(`${n.padEnd(14)} ${String(a.length).padStart(4)} Trades | Summe ${f1(sum(a, (x) => x.pct))} %-Punkte`); }

console.log('\n-- Nach Alter des Tokens beim Kauf --');
const ageB = [['< 30 s', (a) => a !== null && a < 30], ['30 s – 2 min', (a) => a !== null && a >= 30 && a < 120], ['2 – 10 min', (a) => a !== null && a >= 120 && a < 600],
  ['> 10 min', (a) => a !== null && a >= 600], ['unbekannt (älter)', (a) => a === null]];
for (const [n, fn] of ageB) {
  const a = A.filter((x) => fn(x.age));
  if (a.length) console.log(`${n.padEnd(18)} ${String(a.length).padStart(4)} Trades | Ø ${f1(sum(a, (x) => x.pct) / a.length)}% | Gewinner ${Math.round(a.filter((x) => x.pct > 0).length / a.length * 100)}% | ≤-40%: ${a.filter((x) => x.pct <= -40).length}`);
}

console.log('\n-- Direkt nach dem Einstieg (Kurs) --');
const med = (arr) => { const a = arr.filter((x) => x !== null && !Number.isNaN(x)).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
console.log(`Signal → Kauf (${delay / 1000} s Verzögerung): Median ${f1(med(A.map((x) => x.toFill)))} % | bei ${Math.round(A.filter((x) => x.toFill > 0).length / A.length * 100)} % teurer gekauft als beim Signal`);
console.log(`Kauf → 10 s später:          Median ${f1(med(A.map((x) => x.after10)))} % | bei ${Math.round(A.filter((x) => x.after10 !== null && x.after10 < 0).length / A.length * 100)} % gefallen`);

const groups = [['Große Verlierer ≤-40%', A.filter((x) => x.pct <= -40)], ['Andere Verlierer', A.filter((x) => x.pct > -40 && x.pct <= 0)], ['Gewinner', A.filter((x) => x.pct > 0)]];
const avg = (a, k) => { const v = a.map(k).filter((x) => x !== null && x !== undefined && !Number.isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const feats = [
  ['Alter beim Kauf (s)', (x) => x.age], ['SOL in der Kurve', (x) => x.real], ['Netto-Zufluss 30s (SOL)', (x) => x.m30.net], ['Käufer 30s', (x) => x.m30.buyers], ['Verkäufe 30s', (x) => x.m30.sells],
  ['Netto-Zufluss 60s (SOL)', (x) => x.m60.net], ['Anteil größter Käufer 60s %', (x) => x.m60.topShare * 100], ['Kursanstieg letzte 30s %', (x) => x.runup30],
  ['Wallets bekannt (Anteil %)', (x) => (x.h ? 100 : 0)], ['größte Wallet % Supply', (x) => x.h && x.h.topPct], ['Top-10 Wallets % Supply', (x) => x.h && x.h.top10Pct],
  ['unbekannte Bestände %', (x) => x.h && x.h.unknownPct], ['Frühkäufer (≤3s) halten %', (x) => x.h && x.h.earlyPct], ['Dev hält %', (x) => x.h && x.h.devPct],
];
console.log('\n-- Merkmale beim Einstieg (Durchschnitt) --');
console.log(''.padEnd(30) + groups.map(([n, a]) => `${n} (${a.length})`.padStart(26)).join(''));
for (const [n, k] of feats) console.log(n.padEnd(30) + groups.map(([, a]) => f1(avg(a, k)).padStart(26)).join(''));

const big = A.filter((x) => x.pct <= -40 && x.worst);
console.log('\n-- Die großen Verluste: wer hat verkauft? --');
for (const x of big.slice(0, 15)) {
  const w = x.worst;
  console.log(`${x.mint.slice(0, 6)} ${f1(x.pct)}% | größter Einzel-Verkauf ${f1(w.drop)}% Kurs nach ${w.afterS.toFixed(1)}s, ${w.sol.toFixed(1)} SOL`
    + (w.sellerPct !== null ? `, ${w.sellerPct.toFixed(1)}% Supply` : '')
    + (w.sellerBalPct !== null ? ` | Verkäufer hielt ${w.sellerBalPct.toFixed(1)}%` : ' | Verkäufer-Bestand unbekannt')
    + (w.isDev ? ' | DEV' : '') + (w.sellerFirstBuyS !== null ? ` | erster Kauf ${w.sellerFirstBuyS.toFixed(1)}s nach Erstellung` : '')
    + (x.age !== null ? ` | Token-Alter beim Kauf ${x.age.toFixed(0)}s` : ''));
}
console.log(`\nAufzeichnungen: ${[...recs.values()].reduce((s, a) => s + a.length, 0)} (davon mit Wallet-Daten: ${[...recs.values()].flat().filter((r) => r.holders).length}, mit Frühkäufer-Daten: ${[...recs.values()].flat().filter((r) => r.createdDt !== undefined).length})`);
