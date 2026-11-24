# Karotte44 – Pump.fun Paper-Trading-Bot

**Nur Simulation.** Kein Wallet, kein Private Key, es werden keine Transaktionen gesendet.

## Start
```bash
npm install
npm start                         # Live-Daten von PumpPortal
PUMPPORTAL_API_KEY=xxx npm start  # nötig für Trade-Daten (siehe unten)
npm run mock                      # synthetischer Test-Feed (keine echten Marktdaten)
```
Dashboard: http://localhost:3000 (Port in `config.json`).

## Wichtig: PumpPortal API-Key
PumpPortal liefert `subscribeTokenTrade` nur mit API-Key, dessen Wallet mit ≥ 0,02 SOL aufgeladen ist.
Ohne Key kommen nur `subscribeNewToken`-Events: der Filter sieht keine Trades und der Analyst lehnt jeden Token mit Score 0 ab.
Das Dashboard zeigt dann „Trades gesperrt: API-Key fehlt“. Den Key per Umgebungsvariable setzen (nicht in config.json committen).
Der Bot benutzt den Key nur zum Lesen des Datenfeeds.

## Pipeline (`src/bot.js`)
1. **Scout** – neue Tokens über eine einzige WebSocket-Verbindung (`src/feed.js`, Reconnect + Resubscribe)
2. **Filter** – 30 s Beobachtung; verwirft bei Dev-Initialbuy > `maxDevInitialBuyPct`, Dev-Verkauf (sofort), Top-10-Holder > 30 % (aus `newTokenBalance` der Trades)
3. **Analyst** – Score 0–1 (gewichtete Unique Buyers, Buy/Sell, Volumen, Preisänderung, Zielwerte in config); ≥ 0,6 geht weiter
4. **Executor** – 8 % der Equity, Constant-Product auf vSol/vTokens, 1 % Fee, Priority-Fee, 1,5 s Verzögerung (Preis nach der Verzögerung), Verkauf genauso
5. **Risk** – Stop-Loss −6 %, Trailing-Stop ab +12 % (Abstand `trailingDistancePct`), max. 10 min; Trigger auf Kurven-Preis, PnL netto inkl. Fees
6. **Logger** – jede Entscheidung mit Grund in `trades.csv` und `log.txt`
