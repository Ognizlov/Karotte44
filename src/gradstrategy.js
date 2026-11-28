// "Graduation" strategy: trade older pump.fun tokens whose standard SOL bonding curve already holds real SOL,
// when buying momentum is strong. Shared by the live scanner and the optimizer replay (identical logic).
const OFFSET = 30;              // standard curve: virtual SOL = real SOL + 30
const CURVE_TOKENS0 = 1073000000; // standard curve: virtual tokens at creation
const SUPPLY = 1000000000;
const isStandard = (e) => e.vSol > 0 && e.realSol !== null && e.realSol !== undefined && Math.abs(e.vSol - e.realSol - OFFSET) < 1e-6;

// holders: Map(wallet -> token balance) when the token was seen from its creation, otherwise undefined (unknown).
// firstBuy: Map(wallet -> ms after creation of its first buy) – early buyers (snipers / bundles) are a rug risk.
function newState(mint, bornSeen = false, createdAt = null, dev = null) {
  return { mint, S: 0, T: 0, real: 0, slot: 0, buf: [], lastTrade: 0, entered: false,
    holders: bornSeen ? new Map() : undefined, firstBuy: bornSeen ? new Map() : undefined, createdAt, dev,
    ageRefAt: createdAt, ageRefMs: 0 }; // age(now) >= now - ageRefAt + ageRefMs (exact if seen from creation)
}
// Token age lower bound in ms (seen from creation: exact; otherwise at least the time since the bot started).
function ageMs(st, now) { return st.ageRefAt === null || st.ageRefAt === undefined ? 0 : now - st.ageRefAt + (st.ageRefMs || 0);
}

// e: { isBuy, sol, tokens, user, vSol, vTokens, slot }. Curve state follows the newest slot; the buffer keeps recent trades.
function apply(st, e, now, keepMs, updateHolders = true) {
  if (!st.slot || !e.slot || e.slot >= st.slot) { st.S = e.vSol; st.T = e.vTokens; st.real = e.vSol - OFFSET; if (e.slot) st.slot = e.slot; }
  if (updateHolders && st.holders && e.tokens !== undefined) {
    st.holders.set(e.user, (st.holders.get(e.user) || 0) + (e.isBuy ? e.tokens : -e.tokens));
    if (e.isBuy && st.firstBuy && !st.firstBuy.has(e.user) && st.createdAt !== null) st.firstBuy.set(e.user, now - st.createdAt);
  }
  st.buf.push([now, e.isBuy ? 1 : 0, e.sol, e.user, e]);
  let i = 0; const cut = now - keepMs;
  while (i < st.buf.length && st.buf[i][0] < cut) i++;
  if (i) st.buf.splice(0, i);
  st.lastTrade = now;
}

// Wallet concentration (whale check). topPct: largest single wallet in % of supply.
// unknownPct: tokens sold by the curve that we cannot attribute to a wallet we saw (missed trades) – could be one whale.
function holderStats(st, earlyMs = 3000) {
  if (!st.holders) return null;
  let top = 0, known = 0, early = 0; const bals = [];
  for (const [u, v] of st.holders) {
    if (v <= 0) continue;
    known += v; bals.push(v); if (v > top) top = v;
    const fb = st.firstBuy && st.firstBuy.get(u);
    if (fb !== undefined && fb <= earlyMs) early += v;
  }
  bals.sort((a, b) => b - a);
  const top10 = bals.slice(0, 10).reduce((a, b) => a + b, 0), sold = CURVE_TOKENS0 - st.T;
  const pct = (x) => (x / SUPPLY) * 100;
  return { topPct: pct(top), top10Pct: pct(top10), unknownPct: pct(Math.max(0, sold - known)),
    earlyPct: st.firstBuy && st.createdAt !== null ? pct(early) : null,   // held by wallets that bought in the first 3 s
    devPct: st.dev ? pct(Math.max(0, st.holders.get(st.dev) || 0)) : null };
}

function momentum(st, now, lookbackMs) {
  let net = 0, buys = 0, sells = 0, buySol = 0; const perBuyer = new Map();
  for (const [t, b, sol, u] of st.buf) {
    if (t < now - lookbackMs) continue;
    if (b) { net += sol; buys++; buySol += sol; perBuyer.set(u, (perBuyer.get(u) || 0) + sol); } else { net -= sol; sells++; }
  }
  let top = 0; for (const v of perBuyer.values()) if (v > top) top = v;
  // topShare: share of the buying that came from the single largest buyer (one wallet pumping = dump risk)
  return { net, buys, sells, buyers: perBuyer.size, topShare: buySol > 0 ? top / buySol : 0 };
}

// Entry: curve progress within [minRealSol, maxRealSol], strong recent buying, and (optionally) no whales.
function signal(st, now, en) {
  if (st.entered || st.real < en.minRealSol || st.real > en.maxRealSol) return null;
  const m = momentum(st, now, en.lookbackSeconds * 1000);
  if (m.net < en.minNetSol || m.buyers < en.minBuyers) return null;
  // only buys and no sells at all is typical for a coordinated pump right before a dump
  if (en.minSells > 0 && m.sells < en.minSells) return null;
  if (en.maxTopBuyerShare > 0 && m.topShare > en.maxTopBuyerShare) return null;
  // only tokens whose wallets the bot has followed since their creation (most rugs come from unknown histories)
  if (en.requireKnown && !st.holders) return null;
  if (en.minAgeSeconds > 0 && ageMs(st, now) < en.minAgeSeconds * 1000) return null;
  if (en.maxTopHolderPct > 0 || en.maxUnknownPct > 0 || en.maxEarlyPct > 0 || en.maxDevPct > 0) {
    const h = holderStats(st);
    if (!h) return null; // token not seen from creation: wallet distribution unknown -> skip (conservative)
    if (en.maxTopHolderPct > 0 && h.topPct > en.maxTopHolderPct) return null;
    if (en.maxUnknownPct > 0 && h.unknownPct > en.maxUnknownPct) return null;
    // wallets that bought in the first 3 s (snipers / bundles) still holding a lot = they can dump on us
    if (en.maxEarlyPct > 0 && (h.earlyPct === null || h.earlyPct > en.maxEarlyPct)) return null;
    // the creator still holding a large bag can dump it at any time
    if (en.maxDevPct > 0 && (h.devPct === null || h.devPct > en.maxDevPct)) return null;
    m.holders = h;
  }
  return m;
}
function describeSignal(st, m, en) {
  const h = m.holders || holderStats(st);
  return `${st.real.toFixed(1)} SOL in der Kurve, letzte ${en.lookbackSeconds}s: netto ${m.net >= 0 ? '+' : ''}${m.net.toFixed(2)} SOL, ${m.buyers} Käufer, `
    + `${m.buys}/${m.sells} Käufe/Verkäufe, größter Käufer ${(m.topShare * 100).toFixed(0)}%`
    + (h ? `, größte Wallet ${h.topPct.toFixed(1)}%, unbekannt ${h.unknownPct.toFixed(1)}%` + (h.earlyPct !== null ? `, Frühkäufer ${h.earlyPct.toFixed(0)}%` : '')
      + (h.devPct !== null ? `, Dev ${h.devPct.toFixed(1)}%` : '') : ', Wallets unbekannt')
    + `, Alter ≥ ${Math.round(ageMs(st, st.lastTrade) / 1000)}s`;
}

// ---- Replay of a recorded token ----
// g2: { users, trades: [[dt, isBuy, sol, userIdx, vSol, vTokens, slot, tokens]], trackDt, bufN, holders: [[userIdx, balance]] | null, events, endDt }
// (g1 records have no token amounts / holders: whale filters treat them as unknown)
const evOf = (rec, tr) => ({ isBuy: tr[1] === 1, sol: tr[2], user: rec.users[tr[3]], vSol: tr[4], vTokens: tr[5], slot: tr[6], tokens: tr[7] });
const firstEvent = (rec) => (rec.events || []).reduce((m, e) => Math.min(m, e[0]), Infinity);

function replayState(rec) {
  const st = newState(rec.mint);
  if (rec.ageAtStartMs !== undefined) { st.ageRefAt = 0; st.ageRefMs = rec.ageAtStartMs; } // record time base: ms after startAt
  // holders snapshot was taken after the buffered trades (incl. the one that started tracking)
  if (rec.holders) {
    st.holders = new Map(rec.holders.map(([u, b]) => [rec.users[u], b]));
    if (rec.createdDt !== undefined && rec.createdDt !== null) {
      st.createdAt = rec.createdDt; // record time base (ms relative to startAt)
      st.firstBuy = new Map(rec.holders.filter((h) => h[2] !== undefined && h[2] !== null).map(([u, , fb]) => [rec.users[u], fb]));
      st.dev = rec.dev !== undefined && rec.dev !== null ? rec.users[rec.dev] : null;
    }
  }
  return st;
}

function replayEntry(rec, en, keepMs) {
  const st = replayState(rec), stop = firstEvent(rec), bufN = rec.bufN || 0;
  for (let i = 0; i < rec.trades.length; i++) {
    const tr = rec.trades[i];
    if (tr[0] >= stop) break;
    apply(st, evOf(rec, tr), tr[0], keepMs, i >= bufN);
    if (i < bufN - 1 || tr[0] < rec.trackDt) continue; // live checks signals only once the token is tracked
    const m = signal(st, tr[0], en);
    if (m) return { dt: tr[0], m, real: st.real };
  }
  return null;
}
// Fast optimizer path: replay a record ONCE and keep, for every moment a signal could be checked, the inputs
// signal() looks at. firstSignal() then finds the entry for any parameter set with plain comparisons.
// Must stay equivalent to replayEntry() (checked by the optimizer self-test).
function signalRows(rec, keepMs, lookbacks, realMin, realMax) {
  const st = replayState(rec), stop = firstEvent(rec), bufN = rec.bufN || 0, rows = [];
  for (let i = 0; i < rec.trades.length; i++) {
    const tr = rec.trades[i];
    if (tr[0] >= stop) break;
    apply(st, evOf(rec, tr), tr[0], keepMs, i >= bufN);
    if (i < bufN - 1 || tr[0] < rec.trackDt) continue;
    if (st.real < realMin || st.real > realMax) continue;
    const mom = {};
    for (const L of lookbacks) mom[L] = momentum(st, tr[0], L * 1000);
    rows.push({ dt: tr[0], real: st.real, mom, known: !!st.holders, h: holderStats(st), age: ageMs(st, tr[0]) });
  }
  return rows;
}
function firstSignal(rows, en) {
  const whale = en.maxTopHolderPct > 0 || en.maxUnknownPct > 0 || en.maxEarlyPct > 0 || en.maxDevPct > 0;
  for (const r of rows) {
    if (r.real < en.minRealSol || r.real > en.maxRealSol) continue;
    const m = r.mom[en.lookbackSeconds];
    if (m.net < en.minNetSol || m.buyers < en.minBuyers) continue;
    if (en.minSells > 0 && m.sells < en.minSells) continue;
    if (en.maxTopBuyerShare > 0 && m.topShare > en.maxTopBuyerShare) continue;
    if (en.requireKnown && !r.known) continue;
    if (en.minAgeSeconds > 0 && r.age < en.minAgeSeconds * 1000) continue;
    if (whale) {
      const h = r.h;
      if (!h) continue;
      if (en.maxTopHolderPct > 0 && h.topPct > en.maxTopHolderPct) continue;
      if (en.maxUnknownPct > 0 && h.unknownPct > en.maxUnknownPct) continue;
      if (en.maxEarlyPct > 0 && (h.earlyPct === null || h.earlyPct > en.maxEarlyPct)) continue;
      if (en.maxDevPct > 0 && (h.devPct === null || h.devPct > en.maxDevPct)) continue;
    }
    return { dt: r.dt };
  }
  return null;
}

// Curve path after a fill at fillDt (path[0] = state at the fill), with the same slot ordering as live.
function pathAfter(rec, fillDt, keepMs) {
  const st = newState(rec.mint), stop = firstEvent(rec), path = [];
  let started = false;
  for (const tr of rec.trades) {
    if (tr[0] > stop) break;
    if (tr[0] > fillDt && !started) { started = true; path.push([0, st.S, st.T]); }
    const before = st.S;
    apply(st, evOf(rec, tr), tr[0], keepMs, false);
    if (started && (st.S !== before || path.length === 1)) path.push([tr[0] - fillDt, st.S, st.T]);
  }
  if (!started) path.push([0, st.S, st.T]);
  if (fillDt >= stop) return null;
  const end = Math.min(rec.endDt, stop);
  if (end <= fillDt) return null; // recording ended before the fill (e.g. bot stopped right after the signal)
  return { path: path.filter((p) => p[0] <= end - fillDt), endDt: end - fillDt, forced: stop < Infinity && stop <= rec.endDt };
}

module.exports = { OFFSET, isStandard, newState, ageMs, apply, holderStats, momentum, signal, describeSignal, replayState, evOf, replayEntry,
  signalRows, firstSignal, pathAfter };
