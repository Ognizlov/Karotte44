// Self-test of the free Solana data feed:  npm run check   (takes about 45 seconds)
const fs = require('fs');
const path = require('path');
const SolanaFeed = require('./solanafeed');

const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG || path.join(__dirname, '..', 'config.json'), 'utf8'));
const secs = Number(process.argv[2]) || 45;
const logger = { log: (m, msg) => console.log(`  [${m}] ${msg}`) };
const feed = new SolanaFeed(cfg.solana, logger);
let creates = 0, trades = 0, invalid = 0, priceBad = 0;
const chains = new Map(); // mint -> { posts:Set, pres:[] } (vSol in lamports)

console.log(`Teste kostenlose Solana-Daten (${feed.urls.join(', ')}) für ${secs} s …`);
feed.on('create', (m) => {
  creates++; feed.watch(m.mint);
  if (creates <= 3) console.log(`  Neuer Token: ${m.symbol} (${m.mint.slice(0, 8)}…) Dev-Kauf ${(m.initialBuy / 1e7).toFixed(2)}%`);
  chains.set(m.mint, { posts: new Set([Math.round(m.vSolInBondingCurve * 1e9)]), pres: [] });
});
feed.on('invalid', () => { invalid++; });
feed.on('trade', (m) => {
  trades++;
  const c = chains.get(m.mint), post = m.tradeVSol;
  if (!(post > 1 && post < 1000)) priceBad++;
  if (!c) return;
  c.posts.add(Math.round(post * 1e9));
  c.pres.push(Math.round((post + (m.txType === 'buy' ? -m.solAmount : m.solAmount)) * 1e9));
});
feed.connect();
setTimeout(() => {
  const i = feed.info();
  // A trade is "linked" if the state before it is the state after another trade we saw (or the start).
  let dirOk = 0, dirBad = 0;
  for (const c of chains.values()) for (const p of c.pres) (c.posts.has(p) ? dirOk++ : dirBad++);
  const checks = [
    ['Verbindung zur Solana-Blockchain', i.coverage > 0.5, `Abdeckung ${(i.coverage * 100).toFixed(1)}%, ${i.drops} Abbrüche`],
    ['Neue (simulierbare) Pump.fun-Tokens erkannt', creates > 0, `${creates} in ${secs} s (≈ ${Math.round(creates / secs * 3600)}/h)`],
    ['Trades der neuen Tokens empfangen', trades > 0, `${trades} Trades`],
    ['Kurswerte plausibel', priceBad === 0, `${priceBad} unplausible`],
    ['Trades lückenlos erfasst', dirOk + dirBad > 0 && dirOk / (dirOk + dirBad) >= 0.6, `${dirOk + dirBad ? (dirOk / (dirOk + dirBad) * 100).toFixed(0) : 0}% vollständig verkettet (${dirBad} Lücken), ${i.reordered} vertauschte Reihenfolgen korrigiert`],
    ['Abos pro Token', !feed.perToken || i.tokenSubs > 0, `${i.tokenSubs} aktiv, ${i.tokenSubErrors} Fehler`],
  ];
  console.log('');
  for (const [name, ok, detail] of checks) console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`);
  console.log(`  (alle Pump.fun-Trades: ${i.tradesPerSec.toFixed(1)}/s · übersprungen: ${i.skippedNonSol} nicht in SOL, ${i.skippedMayhem} Mayhem, ${i.nonStandard} Nicht-Standard · Datenverkehr ≈ ${i.trafficGBperHour.toFixed(2)} GB/h)`);
  const pass = checks.every((c) => c[1]);
  console.log(pass ? '\nALLES OK – der Bot kann kostenlos laufen.' : '\nPROBLEM – bitte diese Ausgabe an Claude schicken.');
  process.exit(pass ? 0 : 1);
}, secs * 1000);
