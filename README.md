# Karotte44 – Pump.fun Paper-Trading-Bot

**Nur Simulation.** Kein Wallet-Zugriff, kein Private Key, es werden keine Transaktionen gesendet.
Das Startkapital (2 SOL) ist Spielgeld.

## Start (Windows)
- Doppelklick auf **`start.bat`** – oder in PowerShell im Ordner: `npm.cmd start`
- Beim ersten Start fragt der Bot nach dem PumpPortal-API-Key und speichert ihn lokal in `.env` (wird nie committet).
- Dashboard: http://localhost:3000 · Beenden: Strg + C
- Update: Bot beenden, `git pull`, neu starten.

Weitere Befehle: `npm.cmd run mock` (synthetische Testdaten, keine Kosten), `npm.cmd run optimize` (Optimizer-Bericht).

## ⚠️ Echte Kosten der Trade-Daten
PumpPortal liefert Trade-Daten (`subscribeTokenTrade`) nur mit API-Key und berechnet dafür
**0,01 SOL pro 10.000 Nachrichten**, abgebucht von der Wallet des API-Keys. Die Wallet muss zudem
**mindestens 0,02 SOL** behalten, sonst kommen keine Trade-Daten mehr (Dashboard: „Keine Trade-Daten“).
- Das Dashboard zeigt die echten Datenkosten der letzten 24 h.
- `dataCost.maxSolPerDay` (Standard 0,05) ist ein Budget: ab 80 % stoppt die Aufzeichnung für den Optimizer,
  ab 100 % pausiert der Scan, bis das 24-h-Fenster wieder darunter liegt. `0` = kein Limit.

## Pipeline (`src/bot.js`, Regeln in `src/strategy.js`)
1. **Scout** – neue Tokens über eine einzige WebSocket-Verbindung (`src/feed.js`)
2. **Filter** – 30 s beobachten; verwerfen bei Dev-Initialbuy > 8 %, Dev-Verkauf, Top-10-Holder > 30 %
3. **Analyst** – Score 0–1 (Käufer, Buy/Sell, Volumen, Preisänderung); Kauf ab `minScore`.
   Optional: `minUniqueBuyers`, `maxPriceChangePct` (nicht zu spät einsteigen), 0 = aus
4. **Executor** – 8 % der Equity, Bonding-Curve (vSol/vTokens), 1 % Fee, Priority-Fee, 1,5 s Verzögerung
5. **Risk** – Stop-Loss, Take-Profit, Trailing-Stop, Exit wenn keine Trades mehr kommen, max. Haltezeit.
   Schwellen beziehen sich auf den Kurven-Preis; der angezeigte PnL ist netto inkl. Gebühren.
6. **Logger** – jede Entscheidung mit Grund in `trades.csv` und `log.txt`

## Optimizer (`src/optimizer.js`)
- Jeder Token, der die Schwellen aus `config.json` erfüllt, wird als „Kandidat“ aufgezeichnet –
  auch wenn der Bot ihn nicht kauft – mit dem Kursverlauf bis `research.horizonSeconds` nach dem Einstieg (`data/`).
- Alle 30 min (ab 40 Kandidaten) spielt der Optimizer alle Kandidaten mit tausenden Kombinationen aus
  Einstiegs-Schwellen und Exit-Regeln durch – mit derselben Logik wie der Live-Bot, inkl. Gebühren und Verzögerung.
- Ausgewählt wird auf den älteren 70 % der Daten; übernommen wird nur, wenn die Einstellung auch in den
  neueren 30 % **deutlich** im Plus ist (t ≥ 1) und besser als die aktuelle ist. Sonst bleibt alles, wie es ist.
- Übernommene Werte stehen in `data/tuned.json` und überschreiben `config.json`.
  Zurücksetzen: `data/tuned.json` löschen. Mindestens `optimizer.minTradesPerHour` Trades pro Stunde bleiben garantiert.
- Der Optimizer kann Einstiegs-Schwellen nur **verschärfen** (gegenüber `config.json`), weil für lockerere keine Daten existieren.

Kein Backtest garantiert zukünftige Gewinne – besonders nicht bei neuen Pump.fun-Tokens.
