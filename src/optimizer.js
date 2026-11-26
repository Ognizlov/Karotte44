// Optimizer: replays recorded candidate price paths and grid-searches entry thresholds + exit rules.
// Walk-forward check: parameters are chosen on the older part of the data (train) and must also
// make a profit on the newer part (test) before they are recommended.
//   node src/optimizer.js            -> report
//   node src/optimizer.js --apply    -> report + write data/tuned.json (picked up on next start)
//   node src/optimizer.js --json     -> machine-readable (used by the bot's auto-optimizer)
const fs = require('fs');
const path = require('path');
const S = require('./strategy');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');

function loadCandidates(lookbackHours) {
  const since = Date.now() - lookbackHours * 3600000, out = [];
  if (!fs.existsSync(dataDir)) return out;
  for (const f of fs.readdirSync(dataDir).filter((x) => /^candidates-.*\.jsonl$/.test(x)).sort()) {
    for (const line of fs.readFileSync(path.join(dataDir, f), 'utf8').split('\n')) {
      if (!line) continue;
      try { const r = JSON.parse(line); if (r.decidedAt >= since && r.path && r.path.length) out.push(r); } catch {}
    }
  }
  return out.sort((a, b) => a.decidedAt - b.decidedAt);
}

// Active trading time: gaps between candidates longer than 15 min count as "bot was off".
function activeHours(recs) {
  let ms = 0;
  for (let i = 1; i < recs.length; i++) ms += Math.min(recs[i].decidedAt - recs[i - 1].decidedAt, 15 * 60000);
  return Math.max(ms / 3600000, 0.25);
}

function grid(base) {
  const scores = [];
  const lo = base.research.minScore ?? base.analyst.minScore;
  for (let s = lo; s <= 0.951; s += 0.05) scores.push(+s.toFixed(2));
  const entries = [];
  for (const minScore of scores) for (const minUniqueBuyers of [0, 8, 15])
    for (const maxPriceChangePct of [0, 150, 60]) for (const maxTop10Pct of [0, 20, 12])
      entries.push({ minScore, minUniqueBuyers, maxPriceChangePct, maxTop10Pct });
  const maxHold = Math.floor(base.research.horizonSeconds / 60);
  const exits = [];
  for (const stopLossPct of [-4, -7, -12, -20]) for (const takeProfitPct of [0, 8, 15, 30])
    for (const trailingActivationPct of [5, 10, 20]) for (const trailingDistancePct of [3, 6, 10])
      for (const maxHoldMinutes of [0.5, 1, 2, 3, 5].filter((h) => h <= maxHold))
        for (const stallExitSeconds of [0, 20, 45])
          exits.push({ stopLossPct, takeProfitPct, trailingActivationPct, trailingDistancePct, maxHoldMinutes, stallExitSeconds });
  return { entries, exits };
}

// Net result of one candidate under exit rule r, in % of the SOL spent (fees + priority fee + latency included).
function tradePct(rec, buy, r, ex) {
  const sim = S.simulateExit(rec.path, rec.endDt, r, ex.delayMs);
  if (!sim) return NaN;
  const proceeds = S.quoteSell(sim.S, sim.T, buy.tokens, buy.solNet, ex.feePct) - ex.priorityFeeSol;
  return ((proceeds - buy.cost) / buy.cost) * 100;
}

function stats(vals) {
  let n = 0, sum = 0, sq = 0, wins = 0, voided = 0;
  for (const v of vals) { if (v !== v) { voided++; continue; } n++; sum += v; sq += v * v; if (v > 0) wins++; }
  const avg = n ? sum / n : 0, sd = n > 1 ? Math.sqrt(Math.max(0, (sq - n * avg * avg) / (n - 1))) : 0;
  // t: how many standard errors the average trade is above zero (≥ 1 ≈ 84 % confidence it is not luck)
  return { n, voided, sumPct: sum, avgPct: avg, winRate: n ? wins / n : 0, t: sd > 0 ? avg / (sd / Math.sqrt(n)) : 0 };
}

function optimize(base, live) {
  const o = base.optimizer, ex = base.executor;
  const recs = loadCandidates(o.lookbackHours).slice(-3000);
  const report = { at: Date.now(), candidates: recs.length, minTrades: o.minTrades };
  if (recs.length < o.minTrades) return { ...report, status: 'insufficient', reason: `Zu wenig Daten: ${recs.length}/${o.minTrades} Kandidaten` };

  const hours = activeHours(recs);
  const N = recs.length, split = Math.floor(N * o.trainFraction);
  const buys = recs.map((r) => {
    const b = S.quoteBuy(r.path[0][1], r.path[0][2], r.refSol, ex.feePct);
    return { ...b, cost: r.refSol + ex.priorityFeeSol };
  });
  const { entries, exits } = grid(base);
  const E = exits.length;
  const out = new Float32Array(E * N);
  for (let e = 0; e < E; e++) for (let i = 0; i < N; i++) out[e * N + i] = tradePct(recs[i], buys[i], exits[e], ex);

  const pass = (a) => { const idx = []; recs.forEach((r, i) => { if (!S.entryCheck(r.features, r.score, a)) idx.push(i); }); return idx; };
  const minPerHour = o.minTradesPerHour;
  let best = null;
  for (const a of entries) {
    const idx = pass(a);
    if (idx.length < o.minTrades) continue;
    for (let e = 0; e < E; e++) {
      let n = 0, trainSum = 0, trainN = 0;
      const off = e * N;
      for (const i of idx) { const v = out[off + i]; if (v !== v) continue; n++; if (i < split) { trainSum += v; trainN++; } }
      if (n < o.minTrades || n / hours < minPerHour || trainN < 5) continue;
      if (!best || trainSum > best.trainSum) best = { trainSum, a, e, idx };
    }
  }

  const sizeSol = (ex.positionSizePct / 100) * base.startCapital;
  const trainHours = activeHours(recs.slice(0, split)), testHours = activeHours(recs.slice(split));
  const describe = (vals, h) => { const s = stats(vals); return { ...s, perHour: s.n / h, solAt8pct: (s.sumPct / 100) * sizeSol }; };
  const evalParams = (a, r) => {
    const idx = pass(a), tr = [], te = [];
    for (const i of idx) (i < split ? tr : te).push(tradePct(recs[i], buys[i], r, ex));
    return { train: describe(tr, trainHours), test: describe(te, testHours), all: describe([...tr, ...te], hours) };
  };
  const current = evalParams(live.analyst, live.risk);
  Object.assign(report, { status: 'ok', hours, current });
  if (!best) return { ...report, status: 'no-valid', reason: `Keine Einstellung schafft ≥ ${o.minTrades} Trades und ≥ ${minPerHour} Trades/h` };

  const params = { analyst: best.a, risk: exits[best.e] };
  const res = evalParams(params.analyst, params.risk);
  // Many combinations are tried, so some look good by pure luck. Only accept parameters whose profit
  // also shows up clearly in the later test period they were NOT chosen on.
  const tt = res.test.t.toFixed(1);
  const ok = res.test.n >= 10 && res.test.avgPct > 0 && res.test.t >= o.minTestT && res.all.sumPct > current.all.sumPct;
  return {
    ...report, best: { params, ...res }, recommended: ok,
    reason: ok ? `Besser als aktuell und im Test-Zeitraum deutlich profitabel (t=${tt})`
      : res.test.n < 10 ? `Zu wenige Trades im Test-Zeitraum (${res.test.n}/10)`
        : res.test.avgPct <= 0 ? 'Im Test-Zeitraum nicht profitabel – Zufallstreffer'
          : res.test.t < o.minTestT ? `Im Test-Zeitraum nur knapp im Plus (t=${tt} < ${o.minTestT}) – kann Zufall sein`
            : 'Nicht besser als die aktuelle Einstellung',
  };
}

function loadConfigs() {
  const cfgPath = process.env.CONFIG ? path.resolve(process.env.CONFIG) : path.join(root, 'config.json');
  const base = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  let tuned = null;
  try { tuned = JSON.parse(fs.readFileSync(path.join(dataDir, 'tuned.json'), 'utf8')); } catch {}
  return { base, live: S.mergeConfig(base, tuned) };
}

function saveTuned(rep) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'tuned.json'), JSON.stringify({ at: rep.at, params: rep.best.params, test: rep.best.test, all: rep.best.all }, null, 2));
}

if (require.main === module) {
  const { base, live } = loadConfigs();
  const t0 = Date.now();
  const rep = optimize(base, live);
  rep.runtimeMs = Date.now() - t0;
  if (process.argv.includes('--json')) { process.stdout.write(JSON.stringify(rep)); process.exit(0); }
  const f = (s) => `${String(s.n).padStart(4)} Trades | ${s.perHour.toFixed(1).padStart(5)}/h | Ø ${s.avgPct.toFixed(2).padStart(6)}% | Win ${(s.winRate * 100).toFixed(0).padStart(3)}% | Summe ≈ ${s.solAt8pct.toFixed(3)} SOL`;
  console.log(`Kandidaten: ${rep.candidates}${rep.hours ? `, aktive Zeit ${rep.hours.toFixed(1)} h` : ''}`);
  if (rep.status !== 'ok') { console.log(rep.reason); process.exit(0); }
  console.log('\nAKTUELL   alle:', f(rep.current.all));
  console.log('          Test:', f(rep.current.test));
  console.log('\nOPTIMIERT alle:', f(rep.best.all));
  console.log('          Test:', f(rep.best.test));
  console.log('\nParameter:', JSON.stringify(rep.best.params));
  console.log(`\nEmpfehlung: ${rep.recommended ? 'ÜBERNEHMEN' : 'nicht übernehmen'} – ${rep.reason} (${rep.runtimeMs} ms)`);
  if (process.argv.includes('--apply')) {
    if (rep.recommended) { saveTuned(rep); console.log('→ data/tuned.json geschrieben, wird beim nächsten Start geladen.'); }
    else console.log('→ Nichts geschrieben.');
  }
}
module.exports = { optimize, loadConfigs, saveTuned };
