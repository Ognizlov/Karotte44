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
function priceExit(pos, price, r) {
  if (price > pos.peakPrice) pos.peakPrice = price;
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
    code = priceExit(pos, p[1] / p[2], r);
    if (code) { trig = p[0]; break; }
  }
  // Order lands after the latency: use the curve state at trigger + delay.
  const ft = trig + delayMs;
  let j = Math.max(0, i - 1);
  while (j + 1 < path.length && path[j + 1][0] <= ft) j++;
  return { code, trig, S: path[j][1], T: path[j][2] };
}

// config.json + optimizer overrides (data/tuned.json) -> live parameters
function mergeConfig(base, tuned) {
  const c = JSON.parse(JSON.stringify(base));
  if (tuned) for (const sec of ['analyst', 'risk']) Object.assign(c[sec], (tuned.params || {})[sec] || {});
  return c;
}

module.exports = { features, filterCheck, score, entryCheck, quoteBuy, quoteSell, priceExit, timeExit, describeExit, simulateExit, mergeConfig };
