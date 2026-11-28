// Pure strategy logic shared by the live bot and the optimizer, so both use exactly the same rules and maths.
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Snapshot of what the Filter/Analyst look at after the observation window.
function features(t, totalSupply) {
  const price = t.vSol / t.vTokens;
  // Tokens sold by the curve that we cannot attribute to a wallet we saw (missed trades) count as ONE
  // holder – conservative: unknown holdings could belong to a single sniper.
  const bals = [...t.balances.values()].filter((x) => x > 0);
  const known = bals.reduce((s, x) => s + x, 0);
  const unknown = t.curveTokens0 ? Math.max(0, t.curveTokens0 - t.vTokens - known) : 0;
  if (unknown > 0) bals.push(unknown);
  const top10 = bals.sort((a, b) => b - a).slice(0, 10).reduce((s, x) => s + x, 0);
  return {
    buyers: t.buyers.size, buys: t.buys, sells: t.sells,
    ratio: t.sells === 0 ? t.buys : t.buys / t.sells,
    volumeSol: t.volumeSol,
    priceChgPct: (price / t.startPrice - 1) * 100,
    devPct: (t.initialBuy / totalSupply) * 100,
    top10Pct: (top10 / totalSupply) * 100,
    unknownPct: (unknown / totalSupply) * 100,
    devSold: t.devSold,
  };
}

function filterCheck(f, fc) {
  if (f.devPct > fc.maxDevInitialBuyPct) return `Dev-Initialbuy ${f.devPct.toFixed(2)}% > ${fc.maxDevInitialBuyPct}%`;
  if (fc.rejectIfDevSells && f.devSold) return 'Dev hat verkauft';
  if (f.top10Pct > fc.maxTop10HolderPct) return `Top-10-Holder ${f.top10Pct.toFixed(1)}% > ${fc.maxTop10HolderPct}%`;
  return null;
}

function score(f, a) {
  const w = a.weights, g = a.targets;
  const sum = w.uniqueBuyers + w.buySellRatio + w.volume + w.priceChange;
  return (w.uniqueBuyers * clamp01(f.buyers / g.uniqueBuyers) + w.buySellRatio * clamp01(f.ratio / g.buySellRatio) +
    w.volume * clamp01(f.volumeSol / g.volumeSol) + w.priceChange * clamp01(f.priceChgPct / g.priceChangePct)) / sum;
}

// Entry thresholds on top of the score (these are what the optimizer tunes). 0 = rule off.
function entryCheck(f, s, a) {
  if (s < a.minScore) return `Score ${s.toFixed(2)} < ${a.minScore}`;
  if (a.minUniqueBuyers > 0 && f.buyers < a.minUniqueBuyers) return `Buyers ${f.buyers} < ${a.minUniqueBuyers}`;
  if (a.maxPriceChangePct > 0 && f.priceChgPct > a.maxPriceChangePct) return `Preis schon +${f.priceChgPct.toFixed(0)}% > ${a.maxPriceChangePct}% (zu spät)`;
  if (a.maxTop10Pct > 0 && f.top10Pct > a.maxTop10Pct) return `Top-10-Holder ${f.top10Pct.toFixed(1)}% > ${a.maxTop10Pct}% (Dump-Risiko)`;
  return null;
}

// ---- Bonding curve (constant product on virtual reserves) ----
function quoteBuy(S, T, solIn, feePct) {
  const solNet = solIn * (1 - feePct / 100);
  return { solNet, tokens: T - (S * T) / (S + solNet) };
}
// Sell against the observed reserves with our own earlier buy (solNet) added back in:
// a round trip without other trades then returns exactly what we put in, minus fees.
function quoteSell(S, T, tokens, solNet, feePct) {
  const k = S * T, S2 = S + solNet, T2 = k / S2;
  return Math.max(0, S2 - k / (T2 + tokens)) * (1 - feePct / 100);
}

// ---- Exit rules (thresholds refer to the curve price vs. the price at our fill) ----
function priceExit(pos, price, r, S) {
  if (price > pos.peakPrice) pos.peakPrice = price;
  // Graduation strategy: sell before the curve completes (virtual SOL = real SOL + 30 on standard curves)
  if (r.exitRealSol > 0 && S !== undefined && S - 30 >= r.exitRealSol) return 'GRAD';
  const chg = (price / pos.entryPrice - 1) * 100;
  if (!pos.trailing && (pos.peakPrice / pos.entryPrice - 1) * 100 >= r.trailingActivationPct) pos.trailing = true;
  if (chg <= r.stopLossPct) return 'SL';
  if (r.takeProfitPct > 0 && chg >= r.takeProfitPct) return 'TP';
  if (pos.trailing && price <= pos.peakPrice * (1 - r.trailingDistancePct / 100)) return 'TRAIL';
  return null;
}
function timeExit(heldMs, idleMs, r) {
  if (r.stallExitSeconds > 0 && idleMs >= r.stallExitSeconds * 1000) return 'STALL';
  if (heldMs >= r.maxHoldMinutes * 60000) return 'TIME';
  return null;
}
function describeExit(code, pos, price, r) {
  const chg = ((price / pos.entryPrice - 1) * 100).toFixed(1);
  const peak = ((pos.peakPrice / pos.entryPrice - 1) * 100).toFixed(1);
  return {
    SL: `Stop-Loss ${chg}% ≤ ${r.stopLossPct}%`,
    TP: `Take-Profit +${chg}% ≥ ${r.takeProfitPct}%`,
    TRAIL: `Trailing-Stop: ${r.trailingDistancePct}% unter Hoch (+${peak}%), aktuell ${chg}%`,
    STALL: `Kein Trade seit ${r.stallExitSeconds}s – Momentum weg (${chg}%)`,
    TIME: `Max. Haltezeit ${r.maxHoldMinutes} min (${chg}%)`,
    GRAD: `Kurve fast voll (≥ ${r.exitRealSol} SOL) – Verkauf vor der Migration (${chg}%)`,
  }[code];
}

// Replays an exit rule on a recorded path [[dtMs, vSol, vTokens], ...] (path[0] = curve at our fill).
// endDt = how long after the fill the path is known. Returns null if the data does not cover the exit.
function simulateExit(path, endDt, r, delayMs) {
  const p0 = path[0];
  const pos = { entryPrice: p0[1] / p0[2], peakPrice: p0[1] / p0[2], trailing: false };
  const hold = r.maxHoldMinutes * 60000;
  const stall = r.stallExitSeconds > 0 ? r.stallExitSeconds * 1000 : Infinity;
  let lastTrade = 0, trig, code = null, i = 1;
  for (;;) {
    const next = i < path.length ? path[i][0] : Infinity;
    const tTime = Math.min(hold, lastTrade + stall);
    if (tTime < next) {
      if (tTime > endDt) return null;
      trig = tTime; code = tTime === hold ? 'TIME' : 'STALL'; break;
    }
    const p = path[i++]; lastTrade = p[0];
    code = priceExit(pos, p[1] / p[2], r, p[1]);
    if (code) { trig = p[0]; break; }
  }
  // Order lands after the latency: use the curve state at trigger + delay.
  const ft = trig + delayMs;
  let j = Math.max(0, i - 1);
  while (j + 1 < path.length && path[j + 1][0] <= ft) j++;
  return { code, trig, S: path[j][1], T: path[j][2] };
}

// ---- Token state: one code path for the live bot and for replaying recorded tokens ----
function newToken(m, now) {
  const t = {
    mint: m.mint, symbol: m.symbol || '?', name: m.name || '', dev: m.traderPublicKey,
    createdAt: now, initialBuy: Number(m.initialBuy) || 0,
    vSol: Number(m.vSolInBondingCurve), vTokens: Number(m.vTokensInBondingCurve),
    balances: new Map(), buyers: new Set(), buys: 0, sells: 0, volumeSol: 0,
    devSold: false, stage: 'watching', lastTrade: now,
  };
  t.startPrice = t.vSol / t.vTokens;
  t.curveTokens0 = t.vTokens + t.initialBuy; // curve tokens before the dev buy
  if (t.initialBuy > 0) t.balances.set(t.dev, t.initialBuy);
  return t;
}
// Applies one trade message; returns true if it carried a valid curve state.
function applyTrade(t, m, now) {
  const vS = Number(m.vSolInBondingCurve), vT = Number(m.vTokensInBondingCurve);
  const curveOk = vS > 0 && vT > 0; // migrated / malformed updates carry no bonding-curve state
  if (curveOk) { t.vSol = vS; t.vTokens = vT; }
  t.lastTrade = now;
  t.volumeSol += Number(m.solAmount) || 0;
  if (m.newTokenBalance !== undefined) t.balances.set(m.traderPublicKey, Number(m.newTokenBalance));
  if (m.txType === 'buy') { t.buys++; t.buyers.add(m.traderPublicKey); }
  else { t.sells++; if (m.traderPublicKey === t.dev) t.devSold = true; }
  return curveOk;
}

// ---- Replay of a recorded token (data/tokens-*.jsonl, see recorder.js) ----
// Trades: [dtMs, userIdx, isBuy, sol, tokens, newBalance, vSol, vTokens]; events: [dtMs, 'invalid'|'complete'].
const tradeMsg = (rec, tr) => ({ txType: tr[2] ? 'buy' : 'sell', traderPublicKey: rec.users[tr[1]], solAmount: tr[3], tokenAmount: tr[4],
  newTokenBalance: tr[5] == null ? undefined : tr[5], vSolInBondingCurve: tr[6], vTokensInBondingCurve: tr[7] });
function firstEvent(rec) { return (rec.events || []).reduce((m, e) => Math.min(m, e[0]), Infinity); }
function replayAt(rec, atMs) {
  if (firstEvent(rec) <= atMs) return null; // invalid token or curve completed: the live bot drops it
  const c = rec.create;
  const t = newToken({ mint: rec.mint, symbol: rec.symbol, traderPublicKey: c.dev, initialBuy: c.initialBuy,
    vSolInBondingCurve: c.vSol, vTokensInBondingCurve: c.vTokens }, 0);
  for (const tr of rec.trades) { if (tr[0] > atMs) break; applyTrade(t, tradeMsg(rec, tr), tr[0]); }
  return t;
}
// What Filter + Analyst would see if the observation ended W seconds after creation (null = filtered out).
function entryAt(rec, W, cfg) {
  const t = replayAt(rec, W * 1000);
  if (!t) return null;
  const f = features(t, cfg.totalSupply);
  if (filterCheck(f, cfg.filter)) return null;
  return { f, score: score(f, cfg.analyst) };
}
// Curve path after a fill at fillMs (path[0] = state at the fill) and how long it is known.
function pathAfter(rec, fillMs) {
  let S0 = rec.create.vSol, T0 = rec.create.vTokens;
  const path = [];
  for (const tr of rec.trades) {
    if (!(tr[6] > 0 && tr[7] > 0)) continue;
    if (tr[0] <= fillMs) { S0 = tr[6]; T0 = tr[7]; } else path.push([tr[0] - fillMs, tr[6], tr[7]]);
  }
  const ev = firstEvent(rec);
  if (ev <= fillMs) return null;
  const end = Math.min(rec.endDt, ev);
  if (end <= fillMs) return null; // recording ended before the fill
  return { path: [[0, S0, T0], ...path.filter((p) => p[0] <= end - fillMs)], endDt: end - fillMs, forced: ev < Infinity && ev <= rec.endDt };
}

// Optimizer results are only valid for the strategy version they were found with.
const STRATEGY_VERSION = 5;
// config.json + optimizer overrides (data/tuned.json) -> live parameters
function mergeConfig(base, tuned) {
  if (tuned && tuned.strategyVersion !== STRATEGY_VERSION) tuned = null;
  const c = JSON.parse(JSON.stringify(base));
  const tp = (tuned && tuned.params) || {};
  for (const sec of ['filter', 'analyst', 'risk']) Object.assign(c[sec], tp[sec] || {});
  if (c.graduation && tp.graduation) for (const sec of ['entry', 'risk']) Object.assign(c.graduation[sec], tp.graduation[sec] || {});
  return c;
}

module.exports = { features, filterCheck, score, entryCheck, quoteBuy, quoteSell, priceExit, timeExit, describeExit, simulateExit,
  newToken, applyTrade, replayAt, entryAt, pathAfter, mergeConfig, STRATEGY_VERSION };
