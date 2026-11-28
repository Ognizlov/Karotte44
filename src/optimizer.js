// Optimizer: replays the recorded tokens (full trade history from creation) and grid-searches
// the observation window (entry after 5/10/15/20/30 s), entry thresholds and exit rules.
// Walk-forward check: parameters are chosen on the older 70 % of the tokens and must also make a clear
// profit on the newer 30 % (which they were not chosen on) before they are recommended.
//   node src/optimizer.js            -> report
//   node src/optimizer.js --apply    -> report + write data/tuned.json (picked up on next start)
//   node src/optimizer.js --json     -> machine-readable (used by the bot's auto-optimizer)
const fs = require('fs');
const path = require('path');
const S = require('./strategy');
const G = require('./gradstrategy');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');

function loadTokens(lookbackHours) {
  const since = Date.now() - lookbackHours * 3600000, out = [];
  if (!fs.existsSync(dataDir)) return out;
  for (const f of fs.readdirSync(dataDir).filter((x) => /^tokens-.*\.jsonl$/.test(x)).sort()) {
    for (const line of fs.readFileSync(path.join(dataDir, f), 'utf8').split('\n')) {
      if (!line) continue;
      try { const r = JSON.parse(line); if (r.v === 2 && r.createdAt >= since) out.push(r); } catch {}
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt).slice(-3000);
}

// Active trading time: gaps between tokens longer than 15 min count as "bot was off".
function activeHours(times) {
  let ms = 0;
  for (let i = 1; i < times.length; i++) ms += Math.min(times[i] - times[i - 1], 15 * 60000);
  return Math.max(ms / 3600000, 0.25);
}

function windowsOf(base, live) {
  return [...new Set([...(base.research.observeWindows || [5, 10, 15, 20, 30]), live.filter.observeSeconds])].sort((a, b) => a - b);
}

// Every (token, window) where the token would reach the Analyst with score >= research.minScore.
function buildCandidates(recs, base, windows) {
  const ex = base.executor, minScore = base.research.minScore ?? base.analyst.minScore, out = [];
  recs.forEach((rec, ti) => {
    for (const W of windows) {
      const fillMs = W * 1000 + ex.delayMs;
      if (rec.endDt < fillMs) continue; // recording stopped before this entry could happen
      const e = S.entryAt(rec, W, base);
      if (!e || e.score < minScore) continue;
      const p = S.pathAfter(rec, fillMs);
      if (!p) continue;
      const refSol = rec.refSol || (ex.positionSizePct / 100) * base.startCapital;
      const buy = S.quoteBuy(p.path[0][1], p.path[0][2], refSol, ex.feePct);
      out.push({ ti, W, f: e.f, score: e.score, ...p, buy: { ...buy, cost: refSol + ex.priorityFeeSol } });
    }
  });
  return out;
}

function grid(base, windows) {
  const lo = base.research.minScore ?? base.analyst.minScore, scores = [];
  for (let s = lo; s <= 0.951; s += 0.05) scores.push(+s.toFixed(2));
  const entries = [];
  for (const observeSeconds of windows) for (const minScore of scores) for (const minUniqueBuyers of [0, 8, 15])
    for (const maxPriceChangePct of [0, 150, 60]) for (const maxTop10Pct of [0, 20, 12])
      entries.push({ observeSeconds, analyst: { minScore, minUniqueBuyers, maxPriceChangePct, maxTop10Pct } });
  const maxHold = Math.floor(base.research.horizonSeconds / 60);
  const exits = [];
  for (const stopLossPct of [-4, -7, -12, -20]) for (const takeProfitPct of [0, 8, 15, 30])
    for (const trailingActivationPct of [5, 10, 20]) for (const trailingDistancePct of [3, 6, 10])
      for (const maxHoldMinutes of [0.5, 1, 2, 3, 5].filter((h) => h <= maxHold))
        for (const stallExitSeconds of [0, 20, 45])
          exits.push({ stopLossPct, takeProfitPct, trailingActivationPct, trailingDistancePct, maxHoldMinutes, stallExitSeconds });
  return { entries, exits };
}

// Net result in % of the SOL spent (fees, priority fee and latency included). NaN = not covered by the data.
function tradePct(c, r, ex) {
  let sim = S.simulateExit(c.path, c.endDt, r, ex.delayMs);
  if (!sim) {
    if (!c.forced) return NaN;
    const last = c.path[c.path.length - 1]; // curve completed / token invalid: live bot sells at the last curve price
    sim = { S: last[1], T: last[2] };
  }
  const proceeds = S.quoteSell(sim.S, sim.T, c.buy.tokens, c.buy.solNet, ex.feePct) - ex.priorityFeeSol;
  return ((proceeds - c.buy.cost) / c.buy.cost) * 100;
}

function stats(vals) {
  let n = 0, sum = 0, sq = 0, wins = 0, voided = 0;
  for (const v of vals) { if (v !== v) { voided++; continue; } n++; sum += v; sq += v * v; if (v > 0) wins++; }
  const avg = n ? sum / n : 0, sd = n > 1 ? Math.sqrt(Math.max(0, (sq - n * avg * avg) / (n - 1))) : 0;
  // t: how many standard errors the average trade is above zero (>= 1 ~ 84 % confidence it is not luck)
  return { n, voided, sumPct: sum, avgPct: avg, winRate: n ? wins / n : 0, t: sd > 0 ? avg / (sd / Math.sqrt(n)) : 0 };
}

function optimize(base, live) {
  const o = base.optimizer, ex = base.executor;
  const recs = loadTokens(o.lookbackHours);
  const windows = windowsOf(base, live);
  const cands = buildCandidates(recs, base, windows);
  const report = { at: Date.now(), tokens: recs.length, candidates: cands.length, minTrades: o.minTrades };
  const liveW = cands.filter((c) => c.W === live.filter.observeSeconds).length;
  if (liveW < o.minTrades) return { ...report, status: 'insufficient', reason: `Zu wenig Daten: ${liveW}/${o.minTrades} Kandidaten (${recs.length} Tokens aufgezeichnet)` };

  const hours = activeHours(recs.map((r) => r.createdAt));
  const splitTi = Math.floor(recs.length * o.trainFraction);
  const trainHours = activeHours(recs.slice(0, splitTi).map((r) => r.createdAt)), testHours = activeHours(recs.slice(splitTi).map((r) => r.createdAt));
  const { entries, exits } = grid(base, windows);
  const N = cands.length, E = exits.length;
  const out = new Float32Array(E * N);
  for (let e = 0; e < E; e++) for (let i = 0; i < N; i++) out[e * N + i] = tradePct(cands[i], exits[e], ex);

  const pass = (W, a) => { const idx = []; cands.forEach((c, i) => { if (c.W === W && !S.entryCheck(c.f, c.score, a)) idx.push(i); }); return idx; };
  let best = null;
  const byWindow = {}; // per observation window: best average on all data (diagnostics only)
  for (const W of windows) byWindow[W] = null;
  for (const en of entries) {
    const idx = pass(en.observeSeconds, en.analyst);
    if (idx.length < o.minTrades) continue;
    for (let e = 0; e < E; e++) {
      let n = 0, sum = 0, trainSum = 0, trainN = 0;
      const off = e * N;
      for (const i of idx) { const v = out[off + i]; if (v !== v) continue; n++; sum += v; if (cands[i].ti < splitTi) { trainSum += v; trainN++; } }
      if (n < o.minTrades || n / hours < o.minTradesPerHour) continue;
      const bw = byWindow[en.observeSeconds];
      if (!bw || sum / n > bw.avgPct) byWindow[en.observeSeconds] = { avgPct: sum / n, n };
      if (trainN < 5) continue;
      if (!best || trainSum > best.trainSum) best = { trainSum, en, e };
    }
  }

  const sizeSol = (ex.positionSizePct / 100) * base.startCapital;
  const describe = (vals, h) => { const s = stats(vals); return { ...s, perHour: s.n / h, solAt8pct: (s.sumPct / 100) * sizeSol }; };
  const evalParams = (W, a, r) => {
    const tr = [], te = [];
    for (const i of pass(W, a)) (cands[i].ti < splitTi ? tr : te).push(tradePct(cands[i], r, ex));
    return { train: describe(tr, trainHours), test: describe(te, testHours), all: describe([...tr, ...te], hours) };
  };
  const current = evalParams(live.filter.observeSeconds, live.analyst, live.risk);
  Object.assign(report, { status: 'ok', hours, current });
  if (!best) return { ...report, byWindow, status: 'no-valid', reason: `Keine Einstellung schafft ≥ ${o.minTrades} Trades und ≥ ${o.minTradesPerHour} Trades/h` };

  const params = { filter: { observeSeconds: best.en.observeSeconds }, analyst: best.en.analyst, risk: exits[best.e] };
  const res = evalParams(best.en.observeSeconds, params.analyst, params.risk);
  // Many combinations are tried, so some look good by pure luck. Only accept parameters whose profit
  // also shows up clearly in the later test period they were NOT chosen on.
  const tt = res.test.t.toFixed(1);
  const ok = res.test.n >= 10 && res.test.avgPct > 0 && res.test.t >= o.minTestT && res.all.sumPct > current.all.sumPct;
  return {
    ...report, best: { params, ...res }, byWindow, recommended: ok,
    reason: ok ? `Besser als aktuell und im Test-Zeitraum deutlich profitabel (t=${tt})`
      : res.test.n < 10 ? `Zu wenige Trades im Test-Zeitraum (${res.test.n}/10)`
        : res.test.avgPct <= 0 ? 'Im Test-Zeitraum nicht profitabel – Zufallstreffer'
          : res.test.t < o.minTestT ? `Im Test-Zeitraum nur knapp im Plus (t=${tt} < ${o.minTestT}) – kann Zufall sein`
            : 'Nicht besser als die aktuelle Einstellung',
  };
}

// ---------------- Graduation strategy (older tokens) ----------------
function loadGrad(lookbackHours) {
  const since = Date.now() - lookbackHours * 3600000, out = [];
  if (!fs.existsSync(dataDir)) return out;
  for (const f of fs.readdirSync(dataDir).filter((x) => /^grad-.*\.jsonl$/.test(x)).sort()) {
    for (const line of fs.readFileSync(path.join(dataDir, f), 'utf8').split('\n')) {
      if (!line) continue;
      try { const r = JSON.parse(line); if ((r.v === 'g1' || r.v === 'g2') && r.startAt >= since) out.push(r); } catch {}
    }
  }
  return out.sort((a, b) => a.startAt - b.startAt).slice(-2500);
}

function optimizeGrad(base, live) {
  const o = base.optimizer, ex = base.executor, g = base.graduation, keep = g.bufferSeconds * 1000;
  const recs = loadGrad(o.lookbackHours);
  const report = { at: Date.now(), tokens: recs.length, minTrades: o.minTrades, strategy: 'graduation' };
  // entry grid; every (token, entry rule) gives at most one entry, identical entries are simulated once
  const entries = [];
  for (const minRealSol of [25, 35, 45]) for (const lookbackSeconds of [30, 60]) for (const minNetSol of [2, 5])
    for (const minAgeSeconds of [0, 300])                                                       // token age
      for (const maxTopHolderPct of [0, 15, 10]) for (const maxEarlyPct of [0, 20]) for (const maxDevPct of [0, 6]) {
        // whale / bundle / dev filters need the wallet history anyway -> only "known history" variants then
        const filtered = maxTopHolderPct > 0 || maxEarlyPct > 0 || maxDevPct > 0;
        for (const requireKnown of filtered ? [true] : [false, true])
          entries.push({ minRealSol, maxRealSol: minRealSol + 25, lookbackSeconds, minNetSol, minBuyers: 0, minSells: 0, maxTopBuyerShare: 0,
            minAgeSeconds, requireKnown, maxTopHolderPct, maxUnknownPct: 0, maxEarlyPct, maxDevPct });
      }
  const allEntries = [...entries, live.graduation.entry];
  const cands = [], key = new Map(), idxOf = allEntries.map(() => []);
  const lookbacks = [...new Set(allEntries.map((e) => e.lookbackSeconds))];
  const realMin = Math.min(...allEntries.map((e) => e.minRealSol)), realMax = Math.max(...allEntries.map((e) => e.maxRealSol));
  recs.forEach((rec, ti) => {
    const rows = G.signalRows(rec, keep, lookbacks, realMin, realMax); // replay once, then compare per parameter set
    allEntries.forEach((en, ei) => {
      const hit = G.firstSignal(rows, en);
      if (!hit) return;
      const k = `${ti}:${hit.dt}`;
      let ci = key.get(k);
      if (ci === undefined) {
        const p = G.pathAfter(rec, hit.dt + ex.delayMs, keep);
        if (!p || !p.path.length) return;
        const refSol = rec.refSol || (ex.positionSizePct / 100) * base.startCapital;
        const buy = S.quoteBuy(p.path[0][1], p.path[0][2], refSol, ex.feePct);
        ci = cands.length; key.set(k, ci);
        cands.push({ ti, ...p, buy: { ...buy, cost: refSol + ex.priorityFeeSol } });
      }
      idxOf[ei].push(ci);
    });
  });
  report.candidates = cands.length;
  const liveN = idxOf[allEntries.length - 1].length;
  if (Math.max(...idxOf.map((x) => x.length)) < o.minTrades) return { ...report, status: 'insufficient', reason: `Zu wenig Daten: höchstens ${Math.max(0, ...idxOf.map((x) => x.length))}/${o.minTrades} Trades möglich (${recs.length} Tokens aufgezeichnet, aktuell ${liveN})` };

  const times = recs.map((r) => r.startAt), splitTi = Math.floor(recs.length * o.trainFraction);
  const hours = activeHours(times), trainHours = activeHours(times.slice(0, splitTi)), testHours = activeHours(times.slice(splitTi));
  const exits = [];
  for (const stopLossPct of [-5, -10, -15, -25]) for (const takeProfitPct of [0, 10, 20, 40])
    for (const trailingActivationPct of [5, 10, 20]) for (const trailingDistancePct of [3, 6, 10])
      for (const maxHoldMinutes of [1, 3, 10]) for (const stallExitSeconds of [0, 60]) for (const exitRealSol of [0, 75])
        exits.push({ stopLossPct, takeProfitPct, trailingActivationPct, trailingDistancePct, maxHoldMinutes, stallExitSeconds, exitRealSol });
  const N = cands.length, E = exits.length, out = new Float32Array(E * N);
  for (let e = 0; e < E; e++) for (let i = 0; i < N; i++) out[e * N + i] = tradePct(cands[i], exits[e], ex);

  let best = null; const byLevel = {};
  entries.forEach((en, ei) => {
    const idx = idxOf[ei];
    if (idx.length < o.minTrades) return;
    for (let e = 0; e < E; e++) {
      let n = 0, sum = 0, trainSum = 0, trainN = 0; const off = e * N;
      for (const i of idx) { const v = out[off + i]; if (v !== v) continue; n++; sum += v; if (cands[i].ti < splitTi) { trainSum += v; trainN++; } }
      if (n < o.minTrades || n / hours < o.minTradesPerHour) continue;
      const bl = byLevel[en.minRealSol];
      if (!bl || sum / n > bl.avgPct) byLevel[en.minRealSol] = { avgPct: sum / n, n };
      if (trainN >= 5 && (!best || trainSum > best.trainSum)) best = { trainSum, ei, e };
    }
  });
  const sizeSol = (ex.positionSizePct / 100) * base.startCapital;
  const describe = (vals, h) => { const st = stats(vals); return { ...st, perHour: st.n / h, solAt8pct: (st.sumPct / 100) * sizeSol }; };
  const evalIdx = (idx, r) => { const tr = [], te = []; for (const i of idx) (cands[i].ti < splitTi ? tr : te).push(tradePct(cands[i], r, ex)); return { train: describe(tr, trainHours), test: describe(te, testHours), all: describe([...tr, ...te], hours) }; };
  const current = evalIdx(idxOf[allEntries.length - 1], live.graduation.risk);
  Object.assign(report, { status: 'ok', hours, current, byWindow: byLevel });
  if (!best) return { ...report, status: 'no-valid', reason: `Keine Einstellung schafft ≥ ${o.minTrades} Trades und ≥ ${o.minTradesPerHour} Trades/h` };
  const params = { graduation: { entry: entries[best.ei], risk: exits[best.e] } };
  const res = evalIdx(idxOf[best.ei], exits[best.e]);
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
  fs.writeFileSync(path.join(dataDir, 'tuned.json'), JSON.stringify({ at: rep.at, strategyVersion: S.STRATEGY_VERSION, params: rep.best.params, test: rep.best.test, all: rep.best.all }, null, 2));
}

if (require.main === module) {
  const { base, live } = loadConfigs();
  const t0 = Date.now();
  const grad = base.strategy !== 'newTokens';
  const rep = grad ? optimizeGrad(base, live) : optimize(base, live);
  rep.runtimeMs = Date.now() - t0;
  if (process.argv.includes('--json')) { process.stdout.write(JSON.stringify(rep)); process.exit(0); }
  const f = (s) => `${String(s.n).padStart(4)} Trades | ${s.perHour.toFixed(1).padStart(5)}/h | Ø ${s.avgPct.toFixed(2).padStart(6)}% | Win ${(s.winRate * 100).toFixed(0).padStart(3)}% | Summe ≈ ${s.solAt8pct.toFixed(3)} SOL`;
  console.log(`Tokens: ${rep.tokens}, Kandidaten: ${rep.candidates}${rep.hours ? `, aktive Zeit ${rep.hours.toFixed(1)} h` : ''}`);
  if (rep.status !== 'ok') { console.log(rep.reason); process.exit(0); }
  const label = grad ? (p) => `ab ${p.graduation.entry.minRealSol} SOL` : (p) => `Einstieg nach ${p.filter.observeSeconds} s`;
  console.log(`\nAKTUELL   (${grad ? 'ab ' + live.graduation.entry.minRealSol + ' SOL' : 'Einstieg nach ' + live.filter.observeSeconds + ' s'}) alle:`, f(rep.current.all));
  console.log('          Test:', f(rep.current.test));
  console.log(`\nOPTIMIERT (${label(rep.best.params)}) alle:`, f(rep.best.all));
  console.log('          Test:', f(rep.best.test));
  console.log(`\nBestes Ø-Ergebnis je ${grad ? 'SOL-Stufe beim Einstieg' : 'Einstiegszeitpunkt'}:`, Object.entries(rep.byWindow).map(([w, b]) => `${w}${grad ? ' SOL' : 's'}: ${b ? b.avgPct.toFixed(2) + '% (' + b.n + ')' : '-'}`).join(' · '));
  console.log('\nParameter:', JSON.stringify(rep.best.params));
  console.log(`\nEmpfehlung: ${rep.recommended ? 'ÜBERNEHMEN' : 'nicht übernehmen'} – ${rep.reason} (${rep.runtimeMs} ms)`);
  if (process.argv.includes('--apply')) {
    if (rep.recommended) { saveTuned(rep); console.log('→ data/tuned.json geschrieben, wird beim nächsten Start geladen.'); }
    else console.log('→ Nichts geschrieben.');
  }
}
module.exports = { optimize, optimizeGrad, loadConfigs, saveTuned };
