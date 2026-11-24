// Single shared PumpPortal WebSocket connection (with reconnect + resubscribe).
const WebSocket = require('ws');
const { EventEmitter } = require('events');

class Feed extends EventEmitter {
  constructor(url, logger) {
    super();
    this.url = url; this.logger = logger;
    this.mints = new Set();
    this.connected = false; this.backoff = 1000;
    this.msgCount = 0;
    this.tradesBlocked = false;
  }
  agent() {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (!proxy) return undefined;
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(proxy);
  }
  connect() {
    const key = process.env.PUMPPORTAL_API_KEY;
    const url = key ? `${this.url}?api-key=${encodeURIComponent(key)}` : this.url;
    const ws = new WebSocket(url, { agent: this.agent() });
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true; this.backoff = 1000;
      this.logger.log('feed', 'WebSocket verbunden');
      this.send({ method: 'subscribeNewToken' });
      if (this.mints.size) this.send({ method: 'subscribeTokenTrade', keys: [...this.mints] });
      this.emit('status');
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      this.msgCount++;
      if (m.message) {
        if (/api key/i.test(m.message)) {
          if (!this.warnedKey) this.logger.log('feed', `PumpPortal: ${m.message} → PUMPPORTAL_API_KEY setzen, sonst keine Trade-Daten`, 'error');
          this.warnedKey = true; this.tradesBlocked = true; this.emit('status');
        }
        return;
      }
      if (m.txType === 'create') this.emit('create', m);
      else if (m.txType === 'buy' || m.txType === 'sell') this.emit('trade', m);
    });
    // Keepalive / dead-connection detection
    clearInterval(this.pingTimer);
    this.lastPong = Date.now();
    ws.on('pong', () => { this.lastPong = Date.now(); });
    this.pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPong > 60000) { this.logger.log('feed', 'Keine Pong-Antwort – reconnect', 'warn'); ws.terminate(); return; }
      ws.ping();
    }, 20000);
    ws.on('close', () => {
      this.connected = false; this.emit('status');
      clearInterval(this.pingTimer);
      this.logger.log('feed', `Verbindung getrennt – reconnect in ${this.backoff / 1000}s`, 'warn');
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    });
    ws.on('error', (e) => this.logger.log('feed', `WS-Fehler: ${e.message}`, 'error'));
  }
  send(obj) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }
  watch(mint) { if (!this.mints.has(mint)) { this.mints.add(mint); this.send({ method: 'subscribeTokenTrade', keys: [mint] }); } }
  unwatch(mint) { if (this.mints.delete(mint)) this.send({ method: 'unsubscribeTokenTrade', keys: [mint] }); }
}
module.exports = Feed;
