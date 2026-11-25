// Optional local .env (never committed) so the API key does not have to be typed on every start.
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function loadEnv(root) {
  const p = path.join(root, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function ensureApiKey(root, cfg) {
  // Only the paid PumpPortal source needs a key; the default Solana source is free.
  if (cfg.source !== 'pumpportal' || process.env.PUMPPORTAL_API_KEY || process.env.MOCK === '1' || !process.stdin.isTTY) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const key = await new Promise((res) => rl.question(
    'PumpPortal API-Key eingeben (wird nur lokal in .env gespeichert, Enter = ohne Key): ', (a) => { rl.close(); res(a.trim()); }));
  if (!key) return;
  fs.appendFileSync(path.join(root, '.env'), `PUMPPORTAL_API_KEY=${key}\n`);
  process.env.PUMPPORTAL_API_KEY = key;
  console.log('API-Key in .env gespeichert – beim nächsten Start nicht mehr nötig.');
}
module.exports = { loadEnv, ensureApiKey };
