# Zustell-Leitstand 3D (Prototyp)

Klickbarer Prototyp für eine Ideenmanagement-Einreichung: Ein Leitstand zeigt eine Zustellbasis
als animierte 3D-Welt, verfolgt Touren live, lässt per Klick umplanen und rechnet zu jeder
Änderung aus, was sie spart.

**Alle Daten sind erfunden.** Die Demo-Welt „Musterhausen“ mit ihren Ortsteilen, Straßen,
Mengen und Pseudonymen („Zusteller A“) hat keinen Bezug zu echten Adressen, Personen oder
Systemen. Das Design ist neutral, ohne Firmenlogo, Markenfarben oder Firmennamen.

## Stand

| Phase | Inhalt | Stand |
|---|---|---|
| 1 | Setup, Datenmodell, Demo-Welt, Rechenmodell, Optimierer, Tests | fertig |
| 2 | 3D-Szene statisch, Klick-Panels | offen |
| 3 | Simulation, Animation, Zeitsteuerung | offen |
| 4 | Umplanen, Vorschläge, Ersparnis mit Rechenweg (in 3D) | offen |
| 5 | Fahrer-Ansicht, Benachrichtigungen | offen |
| 6 | Szenarien | offen |
| 7 | Demo-Modus, „Idee in Zahlen“, GitHub Pages | offen |

## Schnellstart

```bash
cd leitstand
npm install
npm run dev          # http://localhost:5173 (auch im WLAN erreichbar, z. B. fürs iPhone)
npm test             # Rechenmodell, Optimierer, Demo-Welt
npm run build        # Typprüfung + Produktions-Build nach dist/
npm run test:browser # nach dem Build: Laptop- und iPhone-Größe, Konsolenfehler, Bildschirmfotos
```

Nach Phase 1 zeigt die Startseite eine **Prüfansicht des Rechenkerns** (2D-Karte, Touren,
Vorschläge, Annahmen). Die 3D-Szene folgt in Phase 2.

## Aufbau

```
src/
  glossar.ts        Alle Fachbegriffe (hier an die eigenen Begriffe anpassen)
  config.ts         Annahmen des Rechenmodells mit Standardwerten
  theme.ts          Farben (Tourfarben, UI, Szene)
  core/             Rechenkern, reines TypeScript ohne UI
    types.ts        Datenmodell
    welt.ts         Demo-Welt Musterhausen (deterministischer Seed)
    demo.ts         Demo-Tag: 6 Touren, 21 Behälter, Startplan
    graph.ts        Straßennetz, kürzeste Wege (Dijkstra), Sperrungen
    modell.ts       Rechenmodell: Zeit, km, Kosten, Übergaben, Vergleich
    optimierer.ts   Zuordnung Behälter → Tour und Reihenfolge
    vorschlaege.ts  Vorschläge und „Andere Tour“
    rechenweg.ts    „Wie kommt die Zahl zustande?“
    quellen.ts      Schnittstellen VehiclePositionSource, TourDataSource, NotificationSink
  worker/           Optimierung im Web Worker
  state/store.ts    Zustand (zustand): Plan, Annahmen, Rückgängig/Wiederholen
  ui/               Oberfläche
tests/              Vitest
```

## Rechenmodell

Alle Parameter stehen in `src/config.ts`, sind im UI als **Annahme** markiert und änderbar.

* **Zeit je Tour** = Beladen + Fahrzeit + Zustellzeit
  * Beladen: 30 Min
  * Fahrzeit zwischen den Gebieten mit 45 km/h (Basis → Bezirk → Bezirk → Basis, kürzeste Wege im Straßennetz)
  * Fahrzeit im Gebiet mit 18 km/h (Rundweg durch alle Stopps des Bezirks)
  * Zustellzeit: 1,2 Min je Paket, 3,6 Sek je Brief, 3 Sek je Zeitung
  * bei Umplanung im Tagesverlauf zusätzlich Übergaben (10 Min) und Wartezeit am Treffpunkt
* **Kosten je Tour und Tag** = Schicht × Stundensatz (volle Schicht wird bezahlt)
  \+ Überstunden × Stundensatz × (1 + Zuschlag) + km × €/km + Fahrzeug fix.
  Eine Tour ohne Behälter kostet 0.
* **Ersparnis** = Kosten alter Plan − Kosten neuer Plan; pro Jahr × Zustelltage.

| Annahme | Standard |
|---|---|
| Stundensatz | 28 €/h |
| Überstundenzuschlag | 25 % |
| Kosten je km | 0,30 €/km |
| Fahrzeug fix | 25 €/Tag |
| Schicht | 8 h |
| Zustelltage | 300 im Jahr |

Jede Euro-Zahl im UI ist anklickbar und zeigt den Rechenweg mit den eingesetzten Werten.

## Optimierer

Zuordnung Behälter → Tour plus Reihenfolge je Tour (kleines Vehicle-Routing-Problem):

1. **Cheapest Insertion** für offene Behälter (weit entfernte zuerst)
2. **Lokale Suche**: ganze Tour auflösen, Behälter verschieben, Behälter tauschen
3. **Reihenfolge** je Tour: Brute Force bis 7 Gebiete, darüber nächster Nachbar + 2-opt
4. **Harte Nebenbedingung**: keine Tour über Schichtlänge (Strafkosten von 1.000 € je
   Minute, höher als jede mögliche Ersparnis). Geht es nicht ohne Überstunden (Spitzentag),
   werden sie minimiert und angezeigt.

Beweglich sind nur Behälter in der Halle; sie können nur Touren bekommen, deren Fahrzeug noch an
der Rampe steht. Behälter an Bord eines abgefahrenen Fahrzeugs wechseln nur per Übergabe.

Vorschlagsarten: *Tour einsparen*, *Überlastung abbauen*, *Behälter umlegen*,
*Reihenfolge ändern*, *Ausfall auffangen* und *Gesamtplan optimieren*. Jeder Vorschlag zeigt
Δ km, Δ Arbeitszeit, Δ €/Tag, Δ €/Jahr und die betroffenen Touren.

## Demo-Welt Musterhausen

* 1 Zustellbasis (Halle, 8 Rampen, Bereitstellfläche, Parkplätze)
* 9 Ortsteile mit 21 Zustellbezirken, je Bezirk ein Behälter (z. B. „LI-S“ = Lindenau Süd)
* Fluss mit drei Brücken, Hauptstraße, Nord-, Süd- und Kreisstraße, Deichweg, Felder, Wäldchen
* 6 Touren mit E-Transportern, Pseudonyme „Zusteller A“ bis „Zusteller F“
* deterministischer Seed (`DEMO_SEED` in `src/core/welt.ts`)

Der Startplan ist bewusst „historisch gewachsen“: Tour 1 macht Überstunden, Tour 2 fährt im
Zickzack, Tour 6 ist schwach ausgelastet. Die Mengen sind so kalibriert, dass diese Schieflagen
mit den Standard-Annahmen sichtbar werden.

## Anpassen

* **Begriffe**: `src/glossar.ts` (z. B. „Rollbehälter“, „Zustellbezirk“, „Springer“)
* **Farben**: `src/theme.ts`
* **Annahmen**: `src/config.ts` oder direkt im UI
* **Echte Datenquellen**: die Schnittstellen in `src/core/quellen.ts` implementieren

## Datenschutz by Design

Ortung von Beschäftigten ist mitbestimmungspflichtig (§ 87 Abs. 1 Nr. 6 BetrVG). Der Prototyp
ist deshalb so angelegt:

* Ortung nur während der Schicht und nur auf Fahrzeugebene
* Pseudonyme statt Namen, keine Ranglisten oder Leistungsvergleiche einzelner Zusteller/innen
* Positionsdaten nach Schichtende löschen, nur zusammengefasste Kennzahlen behalten
* Einführung nur mit Betriebsrat und Datenschutzbeauftragten

(Eine eigene Info-Seite dazu folgt im Prototyp.)
