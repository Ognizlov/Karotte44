# Ergebnisse der Paper-Trading-Läufe

Alle Zahlen sind Simulation (Spielgeld, 0,16 SOL fester Einsatz pro Trade, 1 % Fee je Richtung, Priority-Fee, 1,5 s Verzögerung).
„Trade-Ergebnis“ = netto in % des Einsatzes.

## Strategie „neue Tokens“ (V1/V2, Einstieg nach 30 s)
- Gewinnquote 7–14 %, Ø −5 bis −8 % pro Trade. Ursache: Einstieg auf dem Höhepunkt der Sniper-Pumps (Absturz im Mittel 20 s nach dem Kauf).
- Früherer Einstieg (5–20 s) getestet: ebenfalls kein profitables Setting gefunden.

## Strategie „ältere Tokens“ (Graduation)

### V3 – 385 Trades (Lauf des Nutzers, bis 28.11.2026)
| Ergebnis | Trades | Summe %-Punkte |
|---|---|---|
| ≤ −40 % | 40 | −3243,6 |
| −40 bis −10 % | 114 | −1847,3 |
| −10 bis 0 % | 57 | −264,8 |
| 0 bis +10 % | 50 | +246,3 |
| > +10 % | 124 | +3369,1 |

Ø −4,5 % pro Trade. 36 der 40 großen Verluste: Tokens mit **unbekannter Vorgeschichte** (Bot hatte die Erstellung nicht gesehen).
Wo Wallets bekannt: größte Wallet bei großen Verlierern Ø 24,0 % der Supply, sonst 8,8–11,1 %.
Bei 3 Rugs verkaufte eine einzelne Wallet 63–70 % der Supply auf einmal.

### V4 (Mindestalter 5 min) – 177 Trades (Lauf des Nutzers, 28.11.2026)
Aus den kumulierten Zahlen (V3+V4 = 562 Trades) herausgerechnet:
- Ø **−1,6 %** pro Trade (V3: −4,5 %), Anteil Rugs ≤ −40 % **4,5 %** (V3: 10,4 %).
- Kumuliert V3+V4, Merkmale beim Kauf (große Verlierer ≤ −40 % vs. andere Verlierer / Gewinner):
  - größte Wallet: 23,9 % vs 8,6 / 10,0 %
  - Top-10-Wallets: 47,4 % vs 36,1 / 37,4 %
  - Frühkäufer (erste 3 s) halten noch: 32,7 % vs 8,8 / 12,5 %
  - Entwickler hält noch: 11,1 % vs 2,5 / 4,2 %
  - Kursanstieg letzte 30 s: 65 % vs 98 / 95 %
- Stop-Loss-Exits (−10 % eingestellt) realisieren wegen Verzögerung/Gaps im Schnitt −22,9 % (inkl. Rugs).

### V5 (ab 28.11.2026)
Nur Tokens mit bekannter Wallet-Historie, Whale-Filter (größte Wallet ≤ 15 %). Optimizer testet zusätzlich
Dev-Bestand (≤ 6 %) und Frühkäufer-Bestand (≤ 20 %). Ergebnisse folgen.
