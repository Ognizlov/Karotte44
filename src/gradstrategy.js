// "Graduation" strategy: trade older pump.fun tokens whose standard SOL bonding curve already holds real SOL,
// when buying momentum is strong. Shared by the live scanner and the optimizer replay (identical logic).
const OFFSET = 30; // standard curve: virtual SOL = real SOL + 30
const isStandard = (e) => e.vSol > 0 && e.realSol !== null && e.realSol !== undefined && Math.abs(e.vSol - e.realSol - OFFSET) < 1e-6;

function newState(mint) { return { mint, S: 0, T: 0, real: 0, slot: 0, buf: [], lastTrade: 0, entered: false }; }

// e: { isBuy, sol, user, vSol, vTokens, slot }. Curve state follows the newest slot; the buffer keeps recent trades.
function apply(st, e, now, keepMs) {
  if (!st.slot || !e.slot || e.slot >= st.slot) { st.S = e.vSol; st.T = e.vTokens; st.real = e.vSol - OFFSET; if (e.slot) st.slot = e.slot; }
  st.buf.push([now, e.isBuy ? 1 : 0, e.sol, e.user, e]);
  let i = 0; const cut = now - keepMs;
  while (i < st.buf.length && st.buf[i][0] < cut) i++;
  if (i) st.buf.splice(0, i);
  st.lastTrade = now;
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

// Entry: curve progress within [minRealSol, maxRealSol] and strong recent buying.
function signal(st, now, en) {
  if (st.entered || st.real < en.minRealSol || st.real > en.maxRealSol) return null;
  const m = momentum(st, now, en.lookbackSeconds * 1000);
  if (m.net < en.minNetSol || m.buyers < en.minBuyers) return null;
  // only buys and no sells at all is typical for a coordinated pump right before a dump
  if (en.minSells > 0 && m.sells < en.minSells) return null;
  if (en.maxTopBuyerShare > 0 && m.topShare > en.maxTopBuyerShare) return null;
  return m;
}
function describeSignal(st, m, en) {
  return `${st.real.toFixed(1)} SOL in der Kurve, letzte ${en.lookbackSeconds}s: netto ${m.net >= 0 ? '+' : ''}${m.net.toFixed(2)} SOL, ${m.buyers} Käufer, ${m.buys}/${m.sells} Käufe/Verkäufe, größter Käufer ${(m.topShare * 100).toFixed(0)}%`;
}

// ---- Replay of a recorded token: { users, trades: [[dt, isBuy, sol, userIdx, vSol, vTokens, slot]], trackDt, events, endDt }
const evOf = (rec, tr) => ({ isBuy: tr[1] === 1, sol: tr[2], user: rec.users[tr[3]], vSol: tr[4], vTokens: tr[5], slot: tr[6] });
const firstEvent = (rec) => (rec.events || []).reduce((m, e) => Math.min(m, e[0]), Infinity);

function replayEntry(rec, en, keepMs) {
  const st = newState(rec.mint), stop = firstEvent(rec);
  for (const tr of rec.trades) {
    if (tr[0] >= stop) break;
    apply(st, evOf(rec, tr), tr[0], keepMs);
    if (tr[0] < rec.trackDt) continue; // live checks signals only once the token is tracked
    const m = signal(st, tr[0], en);
    if (m) return { dt: tr[0], m, real: st.real };
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
    apply(st, evOf(rec, tr), tr[0], keepMs);
    if (started && (st.S !== before || path.length === 1)) path.push([tr[0] - fillDt, st.S, st.T]);
  }
  if (!started) path.push([0, st.S, st.T]);
  if (fillDt >= stop) return null;
  const end = Math.min(rec.endDt, stop);
  return { path: path.filter((p) => p[0] <= end - fillDt), endDt: end - fillDt, forced: stop < Infinity && stop <= rec.endDt };
}

module.exports = { OFFSET, isStandard, newState, apply, momentum, signal, describeSignal, replayEntry, pathAfter };
