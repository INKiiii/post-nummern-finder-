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
| 2 | 3D-Szene statisch, Klick-Panels | fertig |
| 3 | Datenquellen-Schicht: Scan-Ereignisse, Lagebild, Fahrergerät, Seite „Datenquellen“ | fertig |
| 4 | Animation (Beladen, Spuren, Häuser leuchten), Zeitsteuerung verfeinern | offen |
| 5 | Umplanen, Vorschläge, Ersparnis mit Rechenweg (in 3D) | offen |
| 6 | Fahrer-Ansicht: Benachrichtigungen bei Umplanung | offen |
| 7 | Szenarien | offen |
| 8 | Demo-Modus, „Idee in Zahlen“, GitHub Pages | offen |

## Schnellstart

```bash
cd leitstand
npm install
npm run dev          # http://localhost:5173 (auch im WLAN erreichbar, z. B. fürs iPhone)
npm test             # Rechenmodell, Optimierer, Demo-Welt
npm run build        # Typprüfung + Produktions-Build nach dist/
npm run test:browser # nach dem Build: Laptop- und iPhone-Größe, Konsolenfehler, Bildschirmfotos
```

Die Startseite ist der **3D-Leitstand**. Die Prüfansicht des Rechenkerns (2D-Karte, Touren,
Vorschläge, Annahmen) liegt unter `#/kern` (Menü ☰ → „Rechenkern“).

### Bedienung der 3D-Szene

| | Laptop | iPhone |
|---|---|---|
| Verschieben | linke Maustaste ziehen | ein Finger |
| Drehen/Neigen | rechte Maustaste ziehen | zwei Finger drehen/schieben |
| Zoomen | Mausrad (zum Mauszeiger hin) | zwei Finger spreizen |
| Auswählen | Klick auf Fahrzeug, Behälter oder Haus | Tippen |

* **3D / Draufsicht** schaltet die Ansicht um, **Basis zeigen** fliegt zu den Rampen.
* Klick auf ein Objekt (oder eine Tour in der Liste) fliegt sanft dorthin und öffnet das Panel:
  *Fahrzeug* (Pseudonym, Ladung, Route mit Stopps, Fortschritt, nächster Stopp, Rückkehr,
  Auslastung), *Behälter* (Inhalt, Ziel, Tour, Rampe, Gangfolge-Position, Status),
  *Bezirk* (Klick auf ein Haus) und *Basis* (Klick aufs Hallendach).
* Die Dächer der Häuser zeigen die Farbe ihrer Tour (abschaltbar im Menü).
* Auf dem Handy rechnet die Szene sparsamer (weniger Schatten und Bäume); im Menü umschaltbar.
* Escape hebt die Auswahl auf, Strg+Z / Strg+Umschalt+Z = Rückgängig / Wiederholen.

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
    quellen.ts      Schnittstellen TourDataSource, ScanQuelle, VehiclePositionSource, FahrerGeraet
    scan.ts         Scan-Ereignisse (Arten, Herkunft)
    simulation.ts   Adapter „SimulierteScanner“: erzeugt nur Scan-Ereignisse
    lagebild.ts     Lage aus dem Ereignisstrom: Positionen, Behälter, Fortschritt, Prognosen
    route.ts        Routengeometrie und Zeitpläne entlang der Route
    sendungen.ts    Pakete je Stopp, Briefe geschätzt nach Haushalten, erfundene Adressen
  worker/           Optimierung im Web Worker
  state/            Zustand (zustand): Plan, Annahmen, Verlauf; Auswahl und Kamera
  szene/            3D-Szene (three.js über @react-three/fiber): Gelände, Straßen,
                    Häuser und Behälter per Instancing, Basis, Fahrzeuge, Kamera, Licht
  geraet/           Übertragung zum Fahrergerät (BroadcastChannel)
  ui/               Oberfläche: Leitstand, Panels, Ereignisstrom, Datenquellen,
                    Geräte-Ansicht (fahrer/), Beschriftungen, Prüfansicht
tests/              Vitest
```

## Datenquellen: nur Scans, keine neue Hardware

Der Leitstand nutzt nur Daten, die bei der Arbeit ohnehin entstehen. Alles, was er zeigt
(3D-Welt, Fortschritt, Restzeiten, Vorschläge), berechnet er aus **einem Ereignisstrom**:

| Ereignis | entsteht bei |
|---|---|
| `PAKET_EINGANG_BASIS` | Eingangsscan in der Basis (Paket → Behälter, Adresse) |
| `BEHAELTER_VERLADEN` | Verladescan (Behälter-Barcode, Fahrzeug, Zeit) – nur mit optionalem Etikett |
| `PAKET_IN_FAHRZEUG` | Beladescan am Handscanner |
| `TOUR_START` / `TOUR_ENDE` | An- und Abmeldung am Handscanner |
| `POSITION` | Standort des fahrzeuggebundenen Handscanners, ungefähr, alle 60 s, nur während der Tour |
| `ZUSTELLUNG` / `NICHT_ZUGESTELLT` | Zustellscan mit Zeit und Ort (bzw. Grund) |

* **Adapter „SimulierteScanner“** (`src/core/simulation.ts`) spielt einen erfundenen Tag ab und
  erzeugt nur diese Ereignisse. Der Ist-Ablauf weicht leicht vom Plan ab (Tempo je Tour,
  streuende Halte- und Fahrzeiten, einzelne nicht zustellbare Pakete). Ein echter Adapter könnte
  denselben Strom liefern (`ScanQuelle` in `src/core/scan.ts`).
* **Lagebild** (`src/core/lagebild.ts`) berechnet daraus die Lage: Positionen werden auf die
  geplante Route abgebildet und zwischen den Minutenmeldungen interpoliert (Anzeige eine Minute
  verzögert). **Behälter** haben keinen eigenen Tracker, ihre Position ist die ihres Fahrzeugs
  (per Verladescan oder abgeleitet aus den Paketscans). **Briefe** werden nicht gescannt; ihr
  Fortschritt wird aus Position und Gangfolge **geschätzt** und im UI so gekennzeichnet.
  Prognosen (Restzeit, Rückkehr) kommen aus dem Plan und dem beobachteten Tempo.
* **Vorschläge ab jetzt** nutzen Startzustände aus dem Lagebild (wo ist jedes Fahrzeug, was ist
  an Bord, was ist erledigt). Umplanungen gelten unterwegs ab einem sicheren Punkt (Ende des
  laufenden Bezirks bzw. nächste Kreuzung voraus), den der Leitstand festlegt.
* **FahrerGeraet** (`src/core/quellen.ts`): Nachrichten an das Gerät der Tour und Bestätigungen
  zurück. Im Prototyp eine Ansicht im Stil einer einfachen Scanner-App (`#/fahrer`), verbunden
  über BroadcastChannel (zwei Fenster nebeneinander).
* Die Seite **„Datenquellen“** (`#/datenquellen`) zeigt Bedarf | heute vorhanden über | neu
  nötig. Ergebnis: keine neue Hardware, nur eine Schnittstelle und optional ein Barcode-Etikett
  am Rollbehälter.

### So testest du Phase 3

1. `npm run dev`, im Leitstand ▶ drücken (Tempo z. B. 60×) oder die Zeitleiste ziehen.
2. Um 07:00 beginnt das Beladen: Behälter verschwinden aus der Halle, sobald ein Verladescan
   kommt; ab etwa 07:30 fahren die Fahrzeuge los. Unten links läuft der **Ereignisstrom** mit
   (Knopf „Ereignisse“ blendet ihn aus).
3. Tour anklicken: Panel mit Werten „aus Scans“ und „geschätzt“, Prognose der Rückkehr, Route.
   Die Kamera folgt dem Fahrzeug.
4. Menü → „Geräte-Ansicht (Fahrer)“ öffnet ein zweites Fenster; Tour wählen. Im Leitstand im
   Fahrzeug-Panel „Bitte melden“ senden → auf dem Gerät „Verstanden“ → im Leitstand steht
   „verstanden 10:03“.
5. Menü → „Datenquellen“; dort lässt sich das Barcode-Etikett am Behälter ab- und anschalten.

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
  (vor allem `ScanQuelle` für den Ereignisstrom und `FahrerGeraet` für Nachrichten)

## Datenschutz by Design

Ortung von Beschäftigten ist mitbestimmungspflichtig (§ 87 Abs. 1 Nr. 6 BetrVG). Der Prototyp
ist deshalb so angelegt:

* Ortung nur während der Schicht und nur auf Fahrzeugebene
* Pseudonyme statt Namen, keine Ranglisten oder Leistungsvergleiche einzelner Zusteller/innen
* Positionsdaten nach Schichtende löschen, nur zusammengefasste Kennzahlen behalten
* Einführung nur mit Betriebsrat und Datenschutzbeauftragten

(Eine eigene Info-Seite dazu folgt im Prototyp.)
