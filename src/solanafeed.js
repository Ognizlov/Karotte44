// Free pump.fun market data straight from the Solana blockchain: one RPC WebSocket subscription to the
// logs of the pump.fun program, decoded locally (src/pumpdecode.js). No API key, no fees.
// Emits the same events as the PumpPortal feed ('create', 'trade') plus 'invalid' and 'complete'.
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { PUMP_PROGRAM, decodeLogs } = require('./pumpdecode');

const host = (u) => { try { return new URL(u).host; } catch { return u; } };
const saneCurve = (s, t) => s > 1 && s < 1000 && t > 1e7 && t < 2e9;
const EPS = 1e-6;

class SolanaFeed extends EventEmitter {
  constructor(cfg, logger) {
    super();
    this.logger = logger;
    this.urls = [...new Set([process.env.SOLANA_WS_URL, ...(cfg.wsUrls || [])].filter(Boolean))];
    this.nConn = Math.max(1, cfg.connections || 1);
    this.commitment = cfg.commitment || 'confirmed';
    this.billed = false; this.source = 'solana';
    this.connected = false; this.tradesBlocked = false; this.msgCount = 0;
    this.sockets = [];
    this.watched = new Map(); // mint -> Map(wallet -> token balance), rebuilt from the trades we see
    this.seen = new Map();    // signature -> time, de-duplicates redundant connections
    this.st = { startedAt: Date.now(), creates: 0, trades: 0, skippedNonSol: 0, skippedMayhem: 0, nonStandard: 0, drops: 0, bytes: 0, upMs: 0, upSince: null, lastEventAt: 0 };
    this.lastDropLog = 0; this.lastErrLog = 0;
    this.perToken = cfg.perTokenSubscriptions !== false;
    this.mintSock = null;
  }

  agent() {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (!proxy) return undefined;
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(proxy);
  }

  connect() {
    for (let i = 0; i < this.nConn; i++) setTimeout(() => this.open(i, 0), i * 4000);
    // Second stream: one subscription per watched token. Catches trades routed through other programs
    // (address lookup tables), which the program-wide subscription does not deliver.
    if (this.perToken) this.openMintSocket(0);
    setInterval(() => this.watchdog(), 5000);
    setInterval(() => { const cut = Date.now() - 60000; for (const [k, t] of this.seen) if (t < cut) this.seen.delete(k); }, 30000);
  }

  open(slot, attempt) {
    const url = this.urls[(slot + attempt) % this.urls.length];
    const ws = new WebSocket(url, { agent: this.agent(), handshakeTimeout: 10000 });
    const s = { ws, url, slot, subscribed: false, openedAt: Date.now(), lastMsg: Date.now() };
    this.sockets[slot] = s;
    ws.on('pong', () => { s.lastMsg = Date.now(); });
    ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
      params: [{ mentions: [PUMP_PROGRAM] }, { commitment: this.commitment }] })));
    ws.on('message', (raw) => this.onMessage(s, raw));
    ws.on('error', (e) => {
      if (Date.now() - this.lastErrLog > 60000) { this.lastErrLog = Date.now(); this.logger.log('feed', `Solana ${host(url)}: ${e.message}`, 'warn'); }
    });
    ws.on('close', () => {
      const wasUp = s.subscribed;
      s.subscribed = false; this.updateUp();
      if (wasUp) {
        this.st.drops++;
        if (Date.now() - this.lastDropLog > 60000) {
          this.lastDropLog = Date.now();
          this.logger.log('feed', `Verbindung zu ${host(url)} getrennt – sofort neu verbunden (${this.st.drops} Abbrüche, Abdeckung ${(this.coverage() * 100).toFixed(1)}%)`, 'warn');
        }
      }
      // A connection that worked is re-opened at once; failures back off and rotate through the URLs.
      const healthy = wasUp && Date.now() - s.openedAt > 3000;
      setTimeout(() => this.open(slot, healthy ? 0 : attempt + 1), healthy ? 0 : Math.min(500 * 2 ** attempt, 30000));
    });
  }

  watchdog() {
    const now = Date.now();
    const m = this.mintSock;
    if (m && m.ws.readyState === WebSocket.OPEN) {
      if (now - m.lastMsg > 45000) { this.logger.log('feed', `Token-Abos: keine Antwort seit 45 s – neu verbinden`, 'warn'); m.ws.terminate(); }
      else if (now - m.lastPing > 15000) { m.lastPing = now; m.ws.ping(); }
    } else if (m && m.ws.readyState === WebSocket.CONNECTING && now - m.openedAt > 20000) m.ws.terminate();
    for (const s of this.sockets) {
      if (!s) continue;
      const silent = s.subscribed ? now - s.lastMsg > 20000 : now - s.openedAt > 20000;
      if (silent && s.ws.readyState !== WebSocket.CLOSED) {
        this.logger.log('feed', `Keine Daten von ${host(s.url)} seit 20 s – neu verbinden`, 'warn');
        s.ws.terminate();
      }
    }
  }

  updateUp() {
    const up = this.sockets.some((s) => s && s.subscribed), now = Date.now();
    if (up && this.st.upSince === null) this.st.upSince = now;
    if (!up && this.st.upSince !== null) { this.st.upMs += now - this.st.upSince; this.st.upSince = null; }
    if (up !== this.connected) { this.connected = up; this.emit('status'); }
  }
  coverage() {
    const now = Date.now(), total = now - this.st.startedAt;
    return total > 0 ? (this.st.upMs + (this.st.upSince !== null ? now - this.st.upSince : 0)) / total : 0;
  }

  onMessage(s, raw) {
    s.lastMsg = Date.now();
    this.st.bytes += raw.length;
    const str = raw.toString();
    if (!s.subscribed) {
      let d; try { d = JSON.parse(str); } catch { return; }
      if (d.id !== 1) return;
      if (d.error) { this.logger.log('feed', `Solana-Abo abgelehnt: ${d.error.message}`, 'error'); s.ws.close(); return; }
      s.subscribed = true; s.openedAt = Date.now(); this.updateUp();
      if (!this.announced) { this.announced = true; this.logger.log('feed', `Solana verbunden (${host(s.url)}) – kostenlose Live-Daten`); }
      return;
    }
    if (str.indexOf('"err":null') === -1) return; // failed transaction (bot spam, ~80 %) – skip without parsing
    let r; try { r = JSON.parse(str).params.result; } catch { return; }
    if (!r || !r.value || r.value.err) return;
    this.acceptTx(r.value, r.context && r.context.slot);
  }

  acceptTx(v, slot) {
    if (this.seen.has(v.signature)) return; // same transaction from the other stream
    this.seen.set(v.signature, Date.now());
    this.msgCount++;
    this.sig = v.signature;
    this.handleTx(v.logs || [], slot || 0);
  }

  // Two streams deliver transactions in no guaranteed order. The curve state reported to the bot must
  // never jump back to an older state: use the slot, and inside a slot the chain of reserves
  // (a trade's state before = previous trade's state after).
  curveUpdate(c, e, slot) {
    const pre = e.vSol + (e.isBuy ? -e.sol : e.sol);
    const eq = (a, b) => Math.abs(a - b) < 1e-9;
    let newer;
    if (!c.slot || slot > c.slot) newer = true;
    else if (slot < c.slot) newer = false;
    else if (eq(pre, c.S)) newer = true;        // direct successor
    else if (eq(e.vSol, c.pre)) newer = false;  // direct predecessor
    else newer = true;                          // same slot, unrelated (gap) – assume newer
    if (newer) { c.slot = slot; c.S = e.vSol; c.T = e.vTokens; c.pre = pre; }
    else this.st.reordered = (this.st.reordered || 0) + 1;
  }

  openMintSocket(attempt) {
    const url = this.urls[attempt % this.urls.length];
    const ws = new WebSocket(url, { agent: this.agent(), handshakeTimeout: 10000 });
    const m = { ws, url, ready: false, openedAt: Date.now(), lastMsg: Date.now(), lastPing: Date.now(), nextId: 100,
      reqToMint: new Map(), mintToSub: new Map(), subErrors: 0 };
    this.mintSock = m;
    ws.on('open', () => { m.ready = true; m.lastMsg = Date.now(); for (const mint of this.watched.keys()) this.subMint(mint); });
    ws.on('pong', () => { m.lastMsg = Date.now(); });
    ws.on('message', (raw) => {
      m.lastMsg = Date.now(); this.st.bytes += raw.length;
      let d; try { d = JSON.parse(raw.toString()); } catch { return; }
      if (d.id !== undefined) {
        const mint = m.reqToMint.get(d.id); m.reqToMint.delete(d.id);
        if (d.error) { m.subErrors++; this.st.subErrors = (this.st.subErrors || 0) + 1; return; }
        if (typeof d.result !== 'number' || !mint) return;
        if (this.watched.has(mint)) m.mintToSub.set(mint, d.result);
        else ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.nextId++, method: 'logsUnsubscribe', params: [d.result] }));
        return;
      }
      const r = d.params && d.params.result;
      if (r && r.value && !r.value.err) this.acceptTx(r.value, r.context && r.context.slot);
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      const healthy = m.ready && Date.now() - m.openedAt > 3000;
      if (m.ready) this.st.mintDrops = (this.st.mintDrops || 0) + 1;
      m.ready = false;
      setTimeout(() => this.openMintSocket(healthy ? 0 : attempt + 1), healthy ? 0 : Math.min(500 * 2 ** attempt, 30000));
    });
  }
  subMint(mint) {
    const m = this.mintSock;
    if (!m || !m.ready || m.ws.readyState !== WebSocket.OPEN || m.mintToSub.has(mint)) return;
    const id = m.nextId++;
    m.reqToMint.set(id, mint);
    m.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [mint] }, { commitment: this.commitment }] }));
  }
  unsubMint(mint) {
    const m = this.mintSock;
    if (!m) return;
    const sub = m.mintToSub.get(mint);
    if (sub === undefined) return; // a pending subscription is cancelled when its confirmation arrives
    m.mintToSub.delete(mint);
    if (m.ws.readyState === WebSocket.OPEN) m.ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.nextId++, method: 'logsUnsubscribe', params: [sub] }));
  }

  handleTx(logs, slot) {
    const evs = decodeLogs(logs);
    if (!evs.length) return;
    this.st.lastEventAt = Date.now();
    let devBuy = null;
    for (const e of evs) {
      if (e.kind === 'create') {
        this.st.creates++;
        const dev = evs.find((x) => x.kind === 'trade' && x.mint === e.mint && x.isBuy && x.user === e.user);
        // Only standard SOL bonding curves can be simulated exactly. Skipped: tokens quoted in another
        // currency (e.g. USDC) and "Mayhem mode" tokens, whose virtual reserves are changed by the protocol.
        if (!e.quoteIsSol || (dev && !(dev.vSol > 0)) || (!dev && !saneCurve(e.vSol, e.vTokens))) { this.st.skippedNonSol++; continue; }
        if (e.mayhem) { this.st.skippedMayhem++; continue; }
        devBuy = dev || null;
        this.emit('create', { txType: 'create', mint: e.mint, traderPublicKey: e.user, symbol: e.symbol, name: e.name,
          initialBuy: dev ? dev.tokens : 0, vSolInBondingCurve: dev ? dev.vSol : e.vSol, vTokensInBondingCurve: dev ? dev.vTokens : e.vTokens });
        const w = this.watched.get(e.mint);
        if (w) {
          if (dev) w.bal.set(dev.user, dev.tokens);
          Object.assign(w.curve, { slot, S: dev ? dev.vSol : e.vSol, T: dev ? dev.vTokens : e.vTokens, pre: dev ? dev.vSol - dev.sol : e.vSol });
          // On a standard curve virtual SOL = real SOL + a constant (30 SOL); checked on every trade.
          w.offset = dev && dev.realSol !== null ? dev.vSol - dev.realSol : e.vSol;
        }
      } else if (e.kind === 'trade') {
        this.st.trades++;
        if (e === devBuy) continue; // already part of the create event
        const w = this.watched.get(e.mint);
        if (!w || w.invalid) continue;
        if (!(e.vSol > 0)) { w.invalid = true; this.emit('invalid', { mint: e.mint, reason: 'Token wird nicht gegen SOL gehandelt' }); continue; }
        if (e.realSol !== null) {
          if (w.offset === undefined) w.offset = e.vSol - e.realSol;
          else if (Math.abs(e.vSol - e.realSol - w.offset) > EPS) {
            w.invalid = true; this.st.nonStandard++;
            this.emit('invalid', { mint: e.mint, reason: 'Keine Standard-Bonding-Curve (Reserven werden vom Protokoll verändert)' });
            continue;
          }
        }
        const nb = Math.max(0, (w.bal.get(e.user) || 0) + (e.isBuy ? e.tokens : -e.tokens)); // order-independent
        w.bal.set(e.user, nb);
        this.curveUpdate(w.curve, e, slot);
        this.emit('trade', { txType: e.isBuy ? 'buy' : 'sell', mint: e.mint, traderPublicKey: e.user, solAmount: e.sol,
          tokenAmount: e.tokens, newTokenBalance: nb, vSolInBondingCurve: w.curve.S, vTokensInBondingCurve: w.curve.T,
          slot, tradeVSol: e.vSol, signature: this.sig });
      } else if (e.kind === 'complete' && this.watched.has(e.mint)) {
        this.emit('complete', { mint: e.mint });
      }
    }
  }

  watch(mint) { if (!this.watched.has(mint)) { this.watched.set(mint, { bal: new Map(), curve: {} }); if (this.perToken) this.subMint(mint); } }
  unwatch(mint) { if (this.watched.delete(mint) && this.perToken) this.unsubMint(mint); }

  info() {
    const el = Math.max(1, (Date.now() - this.st.startedAt) / 1000);
    const m = this.mintSock;
    return { source: 'solana', urls: this.urls.map(host), coverage: this.coverage(), drops: this.st.drops,
      reordered: this.st.reordered || 0, perToken: this.perToken, tokenSubs: m ? m.mintToSub.size : 0, tokenSubsUp: !!(m && m.ready), tokenSubErrors: this.st.subErrors || 0,
      tradesPerSec: this.st.trades / el, createsPerHour: (this.st.creates / el) * 3600, skippedNonSol: this.st.skippedNonSol,
      skippedMayhem: this.st.skippedMayhem, nonStandard: this.st.nonStandard,
      usableCreatesPerHour: ((this.st.creates - this.st.skippedNonSol - this.st.skippedMayhem) / el) * 3600,
      trafficGBperHour: (this.st.bytes / el) * 3600 / 1e9, lastEventAgoS: this.st.lastEventAt ? (Date.now() - this.st.lastEventAt) / 1000 : null };
  }
}
module.exports = SolanaFeed;
