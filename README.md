# Karotte44 – Pump.fun Paper-Trading-Bot

**Nur Simulation.** Kein Wallet-Zugriff, kein Private Key, es werden keine Transaktionen gesendet.
Das Startkapital (2 SOL) ist Spielgeld. Kein Backtest und keine Simulation garantiert echte Gewinne.

## Start (Windows)
- Doppelklick auf **`start.bat`** – oder in PowerShell im Ordner: `npm.cmd start`
- Dashboard: http://localhost:3000 · Beenden: Strg + C
- Update: Bot beenden, `git pull`, neu starten.
- **Selbsttest der Datenquelle:** `npm.cmd run check` (45 s) – zeigt, ob alles ankommt.

Weitere Befehle: `npm.cmd run mock` (synthetische Testdaten), `npm.cmd run optimize` (Optimizer-Bericht).

## Datenquelle: kostenlos direkt von der Solana-Blockchain (Standard)
`src/solanafeed.js` abonniert die Logs des Pump.fun-Programms über den öffentlichen Solana-RPC
(`wss://api.mainnet-beta.solana.com`) und entschlüsselt die Ereignisse selbst (`src/pumpdecode.js`).
Kein API-Key, keine Gebühren.
- Zwei Abos: eines für das ganze Pump.fun-Programm (neue Tokens + Trades) und eines pro beobachtetem Token
  (fängt Trades, die über andere Programme laufen). Doppelte werden aussortiert, die Reihenfolge wird über
  Blocknummer und Reserven-Verkettung korrigiert, Verbindungsabbrüche werden sofort neu aufgebaut.
- Tokens, die nicht gegen SOL gehandelt werden (Pump.fun erlaubt inzwischen andere Währungen), werden übersprungen.
- **Datenverkehr ca. 1,5–2 GB pro Stunde** (der öffentliche Server schickt alle Pump.fun-Transaktionen) –
  nur mit Internet-Flatrate betreiben, nicht über mobile Daten.
- Eigener RPC-Zugang (optional): in `.env` z. B. `SOLANA_WS_URL=wss://…` eintragen – wird dann zuerst verwendet.
- Der Top-10-Holder-Filter zählt Token-Bestände, die keinem gesehenen Trade zugeordnet werden können, vorsichtshalber als einen Holder.

Alternative (kostenpflichtig): `"source": "pumpportal"` in `config.json` – PumpPortal berechnet 0,01 SOL pro
10.000 Trade-Nachrichten und verlangt ≥ 0,02 SOL Guthaben auf der Wallet des API-Keys. Dafür gilt das Budget `dataCost.maxSolPerDay`.

## Strategien (`config.json` → `strategy`)
- **`graduation` (Standard): ältere Tokens.** Ein Scanner verfolgt alle laufenden Pump.fun-Kurven (nur Standard-SOL-Kurven).
  Ab `trackRealSol` (20 SOL echtes SOL in der Kurve) wird ein Token beobachtet und aufgezeichnet (`data/grad-*.jsonl`).
  Kauf, wenn die Kurve zwischen `minRealSol` und `maxRealSol` liegt **und** in den letzten `lookbackSeconds` starker Kaufdruck
  herrscht (Netto-Zufluss ≥ `minNetSol`, ≥ `minBuyers` Käufer, optional ≥ `minSells` Verkäufe gegen abgesprochene Pumps).
  Ausstieg: Stop-Loss, Take-Profit, Trailing-Stop, Haltezeit, keine Trades mehr, und Verkauf vor der Migration ab `exitRealSol`.
  Regeln in `src/gradstrategy.js`, Parameter unter `graduation` in `config.json`.
- **`newTokens`: brandneue Tokens** in den ersten Sekunden (Pipeline unten).

Der Optimizer arbeitet für die aktive Strategie: Er spielt die aufgezeichneten Tokens mit exakt der Live-Logik nach.

## Pipeline für neue Tokens (`src/bot.js`, Regeln in `src/strategy.js`)
1. **Scout** – neue Tokens
2. **Filter** – 30 s beobachten; verwerfen bei Dev-Initialbuy > 8 %, Dev-Verkauf, Top-10-Holder > 30 %
3. **Analyst** – Score 0–1 (Käufer, Buy/Sell, Volumen, Preisänderung); Kauf ab `minScore`.
   Optional: `minUniqueBuyers`, `maxPriceChangePct` (nicht zu spät einsteigen), 0 = aus
4. **Executor** – 8 % der Equity, Bonding-Curve (vSol/vTokens), 1 % Fee, Priority-Fee, 1,5 s Verzögerung
5. **Risk** – Stop-Loss, Take-Profit, Trailing-Stop, Exit wenn keine Trades mehr kommen, max. Haltezeit,
   Verkauf bei Abschluss der Bonding-Curve. Schwellen beziehen sich auf den Kurven-Preis; der PnL ist netto inkl. Gebühren.
6. **Logger** – jede Entscheidung mit Grund in `trades.csv` und `log.txt`

## Optimizer (`src/optimizer.js`)
- Der Bot zeichnet von jedem neuen Token den **kompletten Trade-Verlauf ab der Erstellung** auf (`data/tokens-*.jsonl`) –
  egal ob er ihn kauft. Behalten werden Tokens, die in irgendeinem Einstiegsfenster Score ≥ `research.minScore` hätten.
- Der Optimizer spielt jeden Token mit derselben Logik wie live nach – so, als wäre der Bot nach
  5, 10, 15, 20 oder 30 Sekunden (`research.observeWindows`) eingestiegen – und testet dazu tausende Kombinationen aus
  Einstiegs-Schwellen (Score, Käufer, Preisanstieg, Top-10-Holder) und Exit-Regeln, inkl. Gebühren und 1,5 s Verzögerung.
- Ausgewählt wird auf den älteren 70 % der Tokens; übernommen wird nur, wenn die Einstellung auch auf den
  neueren 30 % **deutlich** im Plus ist (t ≥ 1) und besser als die aktuelle ist. Sonst bleibt alles, wie es ist.
- Übernommene Werte (auch die Beobachtungszeit) stehen in `data/tuned.json` und überschreiben `config.json`. Zurücksetzen: Datei löschen.
- `npm.cmd run optimize` zeigt den Bericht inkl. bestem Ergebnis je Einstiegszeitpunkt, `npm.cmd run report` fasst die bisherigen Trades zusammen.
- Kein Backtest garantiert zukünftige Gewinne.
