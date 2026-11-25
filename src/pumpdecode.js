// Decodes pump.fun program events from Solana transaction logs ("Program data: <base64>", Anchor events).
// Only the stable leading fields are read; newer program versions append fields at the end.
const crypto = require('crypto');

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const disc = (name) => crypto.createHash('sha256').update(`event:${name}`).digest().subarray(0, 8).toString('hex');
const DISC = { [disc('TradeEvent')]: 'trade', [disc('CreateEvent')]: 'create', [disc('CompleteEvent')]: 'complete' };

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(buf) {
  const digits = [];
  for (const byte of buf) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const byte of buf) { if (byte !== 0) break; out += '1'; }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

const LAMPORTS = 1e9, TOKEN_UNITS = 1e6; // pump.fun tokens have 6 decimals
const u64 = (b, o) => Number(b.readBigUInt64LE(o));
function str(b, o) { const len = b.readUInt32LE(o); return [b.subarray(o + 4, o + 4 + len).toString('utf8'), o + 4 + len]; }

function decodeEvent(data) {
  if (data.length < 8) return null;
  const kind = DISC[data.subarray(0, 8).toString('hex')];
  if (!kind) return null;
  let o = 8;
  if (kind === 'trade') {
    if (data.length < 105) return null;
    return {
      kind, mint: base58(data.subarray(o, o + 32)),
      sol: u64(data, o + 32) / LAMPORTS, tokens: u64(data, o + 40) / TOKEN_UNITS, isBuy: data[o + 48] === 1,
      user: base58(data.subarray(o + 49, o + 81)),
      vSol: u64(data, o + 89) / LAMPORTS, vTokens: u64(data, o + 97) / TOKEN_UNITS,
      realSol: data.length >= 121 ? u64(data, o + 105) / LAMPORTS : null,
    };
  }
  if (kind === 'create') {
    let name, symbol;
    [name, o] = str(data, o); [symbol, o] = str(data, o); [, o] = str(data, o); // uri
    const mint = base58(data.subarray(o, o + 32)); o += 64; // mint, bonding curve
    const user = base58(data.subarray(o, o + 32)); o += 32 + 32 + 8; // user, creator, timestamp
    // initial virtual reserves (standard SOL curves: 1,073,000,000 tokens / 30 SOL)
    const ok = data.length >= o + 16;
    const ev = { kind, name, symbol, mint, user, vTokens: ok ? u64(data, o) / TOKEN_UNITS : 0, vSol: ok ? u64(data, o + 8) / LAMPORTS : 0,
      mayhem: false, quoteIsSol: true };
    // Newer program versions append: token program (32), is_mayhem_mode (1), flag (1), quote mint (32), ...
    // A quote mint of all zeros means the token is traded against SOL; otherwise e.g. against USDC.
    o += 32; // virtual token, virtual sol, real token, total supply
    if (data.length >= o + 32 + 34) {
      ev.mayhem = data[o + 32] === 1;
      ev.quoteIsSol = data.subarray(o + 34, o + 66).every((x) => x === 0);
      if (!ev.quoteIsSol) ev.quoteMint = base58(data.subarray(o + 34, o + 66));
    }
    return ev;
  }
  return { kind, user: base58(data.subarray(o, o + 32)), mint: base58(data.subarray(o + 32, o + 64)) };
}

// All pump.fun events of one successful transaction, in log order. Only data lines written while the
// pump.fun program itself is executing count: any other Anchor program with an event called "TradeEvent"
// produces the same discriminator.
function decodeLogs(logs) {
  const out = [], stack = [];
  for (const l of logs) {
    if (l.startsWith('Program data: ')) {
      if (stack[stack.length - 1] !== PUMP_PROGRAM) continue;
      try { const e = decodeEvent(Buffer.from(l.slice(14), 'base64')); if (e) out.push(e); } catch {}
      continue;
    }
    if (!l.startsWith('Program ') || l.startsWith('Program log:') || l.startsWith('Program return:')) continue;
    const parts = l.split(' ');
    if (parts[2] === 'invoke') stack.push(parts[1]);
    else if (parts[2] === 'success' || parts[2] === 'failed:' || parts[2] === 'failed') stack.pop();
  }
  return out;
}
module.exports = { PUMP_PROGRAM, decodeLogs, decodeEvent, base58 };
