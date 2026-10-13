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
| 4 | Animation (Beladen, Spuren, Häuser leuchten), Zeitsteuerung verfeinern | fertig |
| 5 | Umplanen, Vorschläge, Ersparnis mit Rechenweg (in 3D), Übergaben am Treffpunkt | fertig |
| 6 | Fahrer-Ansicht: Benachrichtigungen bei Umplanung | fertig |
| 7 | Szenarien: Ausfall, Stau, Panne, Spitzentag | fertig |
| 8 | Demo-Modus, „Idee in Zahlen“, GitHub Pages | fertig |

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

| Adresse | Seite |
|---|---|
| `#/` | 3D-Leitstand |
| `?demo` | 3D-Leitstand, die geführte Demo startet sofort (für Aufnahmen) |
| `#/zahlen` | Idee in Zahlen (druckbar) |
| `#/datenquellen` | Datenquellen: was der Leitstand braucht |
| `#/fahrer` | Geräte-Ansicht der Fahrer/innen (eigenes Fenster) |
| `#/kern` | Prüfansicht des Rechenkerns |

### Online (GitHub Pages)

Der Workflow „Bauen und veröffentlichen“ (`.github/workflows/deploy.yml`) baut den
Leitstand bei jedem Push auf `main` mit und legt ihn unter **`/leitstand/`** neben die
Hausnummern-App, also `https://<Konto>.github.io/<Repository>/leitstand/` (Demo direkt:
`…/leitstand/?demo`). Auf anderen Zweigen prüft nur „Leitstand prüfen“ Typen, Tests und Build.

## Geführte Demo (gut 2 Minuten)

Oben **▶ Demo** (Handy: Menü ☰ → „Demo starten“) oder die Adresse mit `?demo`. Die Demo
benutzt dieselben Aktionen wie die Bedienung von Hand; Untertitel erklären jeden Schritt.

| # | Schritt | was man sieht |
|---|---|---|
| 1 | Überblick | normaler Tag, ganze Karte |
| 2 | 07:00 Beladen | Behälter rollen nach dem Verladescan in die Fahrzeuge |
| 3 | Unterwegs | Fahrzeuge mit Spuren, Häuser leuchten bei Zustellungen |
| 4 | 10:00 Prognose | Tour 1 kommt zu spät zurück (Überstunden) |
| 5 | Vorschlag | „Überlastung Tour 1 abbauen“ mit Übergabe, Vorschau in 3D |
| 6 | Rechenweg | „Wie kommt die Zahl zustande?“ |
| 7 | Übernehmen | Nachricht an beide Geräte, Bestätigung |
| 8 | Übergabe | beide Fahrzeuge am Treffpunkt, der Behälter wechselt |
| 9 | Panne | Tour 2 meldet eine Störung, „Panne auffangen“ mit Übergabe am Standort |
| 10 | Idee in Zahlen | Ersparnis eines normalen Tages, Szenarien |
| 11 | Datenschutz | keine neue Hardware, Mitbestimmung |

Bedienung: **❚❚/▶** oder Leertaste hält an (auch die Uhr), **⏭** oder → springt zum nächsten
Schritt, **✕** oder Esc beendet. Angehalten darf man sich umsehen und etwas antippen.
Die Demo setzt den Tag auf den Startplan zurück. Fürs Video: Browser im Vollbild, `?demo`.

## Idee in Zahlen (`#/zahlen`)

Eine Seite mit allen Kennzahlen, live aus dem Rechenmodell (im Web Worker) mit den aktuellen
Annahmen. Jede Euro-Zahl zeigt ihren Rechenweg. **Drucken / PDF** ergibt eine Einreichung
mit Rechenweg der Hauptzahl im Anhang.

* **Normaler Tag:** Startplan („historisch gewachsen“) gegen den Plan nach den Vorschlägen,
  aufgeteilt nach Kostenart (Schicht, Überstunden, Kilometer, Fahrzeug). Dazu die Rechnung,
  falls die frei gewordene Tour als Reserve im Dienst bleibt (nur Überstunden und Strecke).
* **Die einzelnen Vorschläge** (überschneiden sich, nicht addierbar).
* **Szenarien** je mit „ohne“ und „mit Leitstand“: Ausfall (auch gegen „Springer holen“),
  Panne, Stau (was der Umweg kostet und dass die Prognose es sofort weiß), Spitzentag.
  Sie zählen nicht zur Jahressumme.
* **Hochrechnung** mit der Annahme „Zustellbasen“ (Standard 1) und dem klaren Hinweis, dass
  Musterhausen erfunden ist und erst ein Pilot echte Werte liefert.
* Was es braucht, Datenschutz, Vorschlag für einen Pilot, alle Annahmen zum Ändern.

### Bedienung der 3D-Szene

| | Laptop | iPhone |
|---|---|---|
| Verschieben | linke Maustaste ziehen | ein Finger |
| Drehen/Neigen | rechte Maustaste ziehen | zwei Finger drehen/schieben |
| Zoomen | Mausrad (zum Mauszeiger hin; beim Verfolgen zum Fahrzeug) | zwei Finger spreizen |
| Auswählen | Klick auf Fahrzeug, Behälter oder Haus | Tippen |

* **3D / Draufsicht** schaltet die Ansicht um, **Basis zeigen** fliegt zu den Rampen.
* Klick auf ein Objekt (oder eine Tour in der Liste) fliegt sanft dorthin und öffnet das Panel:
  *Fahrzeug* (Pseudonym, Ladung, Route mit Stopps, Fortschritt, nächster Stopp, Rückkehr,
  Auslastung), *Behälter* (Inhalt, Ziel, Tour, Rampe, Gangfolge-Position, Status),
  *Bezirk* (Klick auf ein Haus) und *Basis* (Klick aufs Hallendach).
* Die Dächer der Häuser zeigen die Farbe ihrer Tour (abschaltbar im Menü).
* Auf dem Handy rechnet die Szene sparsamer (weniger Schatten und Bäume); im Menü umschaltbar.
* Escape hebt die Auswahl auf (bzw. schließt die Vorschau), Strg+Z / Strg+Umschalt+Z = Rückgängig / Wiederholen.

### Umplanen (mit Vorschau und Ersparnis)

* **Vorschläge** (Knopf oben, auf dem Handy Reiter im Blatt): Tour einsparen, Überlastung
  abbauen, Behälter umlegen, Reihenfolge ändern, Ausfall auffangen. Vor der Abfahrt für den
  ganzen Tag, danach **ab jetzt** aus dem Lagebild.
* **Andere Tour** (Behälter anklicken → „Umplanen“): alle Touren mit Ende danach und Δ €/Tag,
  die beste ist markiert. In der Halle wird einfach anders verladen; ist der Behälter schon
  unterwegs, geht es per **Übergabe an einem Treffpunkt**.
* **Fahrzeug-Aktionen** (Fahrzeug anklicken → „Umplanen“): *Behälter abgeben an …* und
  *Gebiet tauschen*; dazu wie bisher *Nachricht an das Gerät*.
* **Drag & Drop** am Laptop: Behälter in der Halle auf ein Fahrzeug ziehen (andere Tour) oder
  auf einen anderen Behälter (tauschen). Auf dem Handy: „Fahrzeug in 3D antippen“.
* Jede Änderung öffnet erst eine **Vorschau** – die Uhr steht so lange:
  * in 3D die neuen Routen gestrichelt, Treffpunkt mit Uhrzeit, Dächer in der neuen Tourfarbe,
    am Fahrzeug die Verschiebung des Tourendes;
  * als Karte Δ km, Δ Arbeitszeit, Δ €/Tag, Δ €/Jahr. Jede Euro-Zahl lässt sich antippen
    („Wie kommt die Zahl zustande?“).
* **Übernehmen** gilt ab jetzt (laufende Bezirke werden fertig zugestellt), **Rückgängig**
  stellt den vorherigen Plan wieder her. Danach rollt der Behälter in der Halle über den Gang
  zu seinem neuen Platz bzw. springt am Treffpunkt ins andere Fahrzeug.

### Zeitsteuerung

* ▶ / ❚❚ startet und hält die Simulationsuhr an, Tempo 1× · 5× · 15× · 60× · 240×.
* Die Zeitleiste (07 … 18 Uhr) spult vor und zurück. Zurück heißt: Der Tag wird aus den
  Ereignissen bis zu dieser Uhrzeit neu aufgebaut.
* Tasten (Laptop): **Leertaste** Start/Pause, **← / →** 10 Minuten (mit Umschalt 1 Stunde),
  **1–5** Tempo.
* Ein angeklicktes Fahrzeug wird verfolgt. Zoomen und Drehen behalten die Verfolgung bei,
  Verschieben beendet sie.

### Animationen (alles aus dem Ereignisstrom)

* **Beladen:** Nach dem Verladescan rollt der Behälter von seinem Platz durch die Rampentür ins
  Fahrzeug (ohne Barcode-Etikett: nach dem ersten Ladescan seiner Pakete).
* **Abfahrt und Rückkehr:** Nach `TOUR_START` fährt das Fahrzeug vorwärts über den Hof davon,
  nach `TOUR_ENDE` wendet es im Hof und setzt rückwärts an die Rampe.
* **Unterwegs:** Die Räder drehen sich mit der gefahrenen Strecke; steht das Fahrzeug an einem
  Stopp, blinkt die Warnblinkanlage. Das Label zeigt die Restzeit.
* **Spuren:** Die schon gefahrene Strecke liegt durchgezogen in Tourfarbe auf der Straße, der
  Rest der Route gestrichelt. Die ausgewählte Tour wird betont, die anderen treten zurück.
* **Häuser leuchten** kurz gelb auf, wenn dort ein Paket zugestellt wurde, orange bei „nicht
  zugestellt“, zeitgleich mit dem angezeigten Fahrzeug.
* **Licht** folgt der Simulationsuhr (Sonnenstand, Farbe des Himmels).

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
    ideeInZahlen.ts Kennzahlen für die Seite „Idee in Zahlen“ (Alltag und Szenarien)
    quellen.ts      Schnittstellen TourDataSource, ScanQuelle, VehiclePositionSource, FahrerGeraet
    scan.ts         Scan-Ereignisse (Arten, Herkunft)
    simulation.ts   Adapter „SimulierteScanner“: erzeugt nur Scan-Ereignisse
    lagebild.ts     Lage aus dem Ereignisstrom: Positionen, Behälter, Fortschritt, Prognosen
    uebergabe.ts    Übergaben am Treffpunkt planen (abgeben, tauschen)
    benachrichtigung.ts  Nachrichten an die Fahrer/innen bei Umplanung
    szenarien.ts    Ausfall, Stau (Sperrung), Panne, Spitzentag
    route.ts        Routengeometrie und Zeitpläne entlang der Route
    sendungen.ts    Pakete je Stopp, Briefe geschätzt nach Haushalten, erfundene Adressen
  worker/           Optimierung im Web Worker
  state/            Zustand (zustand): Plan, Annahmen, Verlauf; Auswahl und Kamera
  szene/            3D-Szene (three.js über @react-three/fiber): Gelände, Straßen,
                    Häuser und Behälter per Instancing, Basis, Fahrzeuge, Spuren, Kamera, Licht
  geraet/           Übertragung zum Fahrergerät (BroadcastChannel)
  ui/               Oberfläche: Leitstand, Panels, Ereignisstrom, Datenquellen,
                    Umplanen (umplanen/: Vorschau, Andere Tour, Tauschen),
                    Idee in Zahlen, geführte Demo (demo/: Regie, Drehbuch, Untertitel),
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

### Szenarien

Knopf **Szenarien** (Handy: Menü ☰). Jedes Szenario ändert nur die Lage, nie den Plan; wie
der Leitstand reagieren würde, steht danach unter **Vorschläge** (mit Vorschau, Δ € und
Nachricht an die Fahrer/innen). Oben steht, welches Szenario läuft; ✕ führt zurück zum
normalen Tag.

| Szenario | was passiert | Reaktion des Leitstands |
|---|---|---|
| Zusteller fällt aus | Tag beginnt neu, eine Tour ist unbesetzt (oder ein Springer beginnt 60 Min später) | „4 Behälter bleiben heute liegen“ → „Ausfall Tour 3 auffangen“ verteilt sie |
| Stau: Unfall auf der Mittelbrücke | ab 09:30 gesperrt, rot in der Szene | Routen und Prognosen mit Umweg, Vorschläge z. B. Übergabe gegen Überstunden |
| Fahrzeugdefekt mittags | ab 11:30: das Fahrzeug fährt den laufenden Bezirk zu Ende und bleibt stehen (Panne-Label, Warnblinker) | „Panne Tour 2 auffangen“: die anderen holen die Behälter am Standort ab |
| Spitzentag | Tag beginnt neu mit +40 % Menge (Annahme, einstellbar) | Überstunden im Startplan, Vorschläge bauen sie ab |

Die Panne kann auch die Fahrerin oder der Fahrer melden: Geräte-Ansicht → **Panne melden**.
Die Szenarien liegen in `src/core/szenarien.ts`; Panne in Lagebild und Simulation, das
Auffangen in `src/core/uebergabe.ts` (`defektAuffangen`, Überstunden bis 90 Min je Tour
gelten dabei als zumutbar).

### Benachrichtigungen an die Fahrer/innen

Jede übernommene Umplanung (auch Rückgängig) schickt jeder betroffenen Tour eine Nachricht
aufs Gerät – über die Schnittstelle `FahrerGeraet`, kurz genug fürs Scanner-Display:

```
Neu: Behälter LI-S, Übergabe 13:10 am Treffpunkt Deichweg (von Tour 2)
Abgeben: Behälter BI-W, Übergabe 11:15 am Treffpunkt Mühlenplatz (an Tour 4)
Entfällt: Behälter AL-S (übernimmt Tour 2)
Neue Reihenfolge: LI-N → LI-M → LI-S
```

* Die **Vorschau** zeigt schon vorher, wer welche Nachricht bekommt.
* Auf dem **Gerät** (`#/fahrer/T1`) erscheint die Umplanung als große Karte mit
  **Verstanden**; die Stoppliste zeigt Übergaben mit Uhrzeit und markiert neue Stopps.
* Im **Leitstand** stehen offene Nachrichten als „✉ offen“ in der Tourliste und als ✉ am
  Fahrzeug; das Fahrzeug-Panel zeigt den Verlauf („verstanden 10:03“). Eine neuere Umplanung
  ersetzt eine noch nicht bestätigte.
* Ist für eine Tour kein Geräte-Fenster offen, bestätigt ein **simulierter Fahrer** nach
  1–4 Minuten Simulationszeit, gekennzeichnet mit „(simuliert)“. Abschaltbar im Menü
  („Fahrer ohne Geräte-Fenster simulieren“).
* Erzeugt werden die Nachrichten in `src/core/benachrichtigung.ts` (getestet).

### Übergaben: auch nur aus Scans

Eine Übergabe ist im Plan ein Schritt bei beiden Touren (Treffpunkt, wer was abgibt). Das
Rechenmodell lässt den, der zuerst da ist, warten; der Optimierer sucht Treffpunkt und
Zeitpunkt (`src/core/uebergabe.ts`). Die Simulation fährt beide Fahrzeuge hin und erzeugt beim
Umladen die üblichen Scans im übernehmenden Fahrzeug (`BEHAELTER_VERLADEN` mit Etikett,
sonst die `PAKET_IN_FAHRZEUG`-Scans der Pakete). Daran erkennt das Lagebild, dass die
Übergabe stattgefunden hat – es gibt dafür kein eigenes Ereignis und keine neue Hardware.

### So testest du Phase 8

1. `npm run dev`, oben **▶ Demo**. Die Demo läuft gut 2 Minuten von 07:00 bis zur Seite
   „Idee in Zahlen“. Leertaste hält an (die Uhr steht), → springt weiter, Esc beendet.
2. Am iPhone: Menü ☰ → „Demo starten“; der Untertitel steht oben, das Blatt unten.
3. Menü ☰ → **Idee in Zahlen**: Euro-Zahlen antippen (Rechenweg). Unten bei den Annahmen den
   Stundensatz ändern → alle Zahlen rechnen neu. „Zustellbasen“ auf 10 → Hochrechnung.
4. **Drucken / PDF**: Szenarien je eine Karte, am Ende der Rechenweg der Hauptzahl.
5. Bei einem Szenario **Im 3D-Leitstand abspielen** → das Szenario startet im Leitstand.
6. Nach dem Merge auf `main`: `https://<Konto>.github.io/<Repository>/leitstand/?demo`.

### So testest du Phase 7

1. `npm run dev`, oben **Szenarien** → „Zusteller fällt aus“ (Tour 3) → Starten. Links steht
   „4 Behälter bleiben heute liegen“; die Vorschläge öffnen sich mit „Ausfall Tour 3
   auffangen“ → In 3D ansehen → Übernehmen. Die Warnung verschwindet.
2. **Szenarien** → „Stau“ → Starten: Die Uhr springt auf 09:30, die Mittelbrücke ist rot
   gesperrt. ▶ (60×): die Fahrzeuge fahren über Nord- und Südbrücke.
3. **Szenarien** → „Fahrzeugdefekt“ → Starten: 11:30, Tour 2 meldet eine Panne. Vorschlag
   „Panne Tour 2 auffangen“ mit Übergabe am Standort → Übernehmen; Tour 2 und der Abholer
   bekommen ihre Nachricht.
4. **Szenarien** → „Spitzentag“: Überstunden-Prognose deutlich höher, Vorschläge bauen sie ab.
5. Oben beim Szenario ✕ → normaler Tag. Mit Geräte-Fenster: dort **Panne melden**.

### So testest du Phase 6

1. `npm run dev`, Leitstand öffnen; Menü → „Geräte-Ansicht (Fahrer)“ öffnet ein zweites
   Fenster, dort **Tour 1** wählen. Beide Fenster nebeneinander.
2. Im Leitstand Zeitleiste auf 10:00 → **Vorschläge** → „Überlastung Tour 1 abbauen“ →
   In 3D ansehen. Unten steht, welche Nachricht Tour 1 und Tour 4 bekommen. **Übernehmen**.
3. Auf dem Gerät erscheint „Umplanung – Abgeben: Behälter …, Übergabe … am Treffpunkt …“.
   Im Leitstand stehen Tour 1 und Tour 4 auf „✉ offen“. Auf dem Gerät **Verstanden** →
   im Leitstand ist Tour 1 bestätigt; ▶ starten → Tour 4 (ohne Gerät) bestätigt simuliert.
4. Gerät → Stoppliste: die Übergabe steht mit Uhrzeit zwischen den Stopps.
5. ↶ (Rückgängig) → beide bekommen „Umplanung zurückgenommen“.

### So testest du Phase 5

1. `npm run dev`, oben **Vorschläge**: „Tour 6 einsparen“ → **In 3D ansehen**. Die Uhr steht,
   neue Routen und Δ-Werte erscheinen; Euro-Zahl antippen zeigt den Rechenweg. Verwerfen.
2. Tour 1 → Behälter-Chip → **Umplanen → Andere Tour**: Liste mit Δ €/Tag, Ziel wählen,
   Vorschau, **Übernehmen**. „Basis zeigen“: der Behälter steht jetzt bei der anderen Rampe.
   ↶ macht es rückgängig (er rollt zurück).
3. Laptop: „Basis zeigen“, einen Behälter mit der Maus auf ein Fahrzeug ziehen.
   Handy: Behälter wählen → „Fahrzeug in 3D antippen“ → Fahrzeug antippen.
4. Zeitleiste auf 10:00 → **Vorschläge**: „Überlastung Tour 1 abbauen“ mit Übergabe am
   Treffpunkt → In 3D ansehen → Übernehmen → ▶. Zur Übergabezeit treffen sich beide
   Fahrzeuge, der Behälter wechselt (Ereignisstrom: Ladescans im anderen Fahrzeug), die
   Überstunden-Prognose sinkt.

### So testest du Phase 4

1. `npm run dev`, „Basis zeigen“, Zeitleiste auf etwa 07:10, Tempo 5×, ▶ (oder Leertaste).
   Die Behälter rollen nacheinander durch die Rampentüren in die Fahrzeuge.
2. Gegen 07:30 fahren die Fahrzeuge vorwärts über den Hof los.
3. Tempo 60×, Menü → „Ganze Karte“: hinter jedem Fahrzeug wächst eine Spur in Tourfarbe,
   der Rest der Route ist gestrichelt.
4. Eine Tour anklicken: Die Kamera folgt. Mit dem Mausrad heranzoomen (die Verfolgung bleibt):
   Häuser leuchten bei Zustellungen auf, beim Halt blinkt die Warnblinkanlage.
5. ← / → springen 10 Minuten; nachmittags setzen die Fahrzeuge rückwärts an die Rampe.

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
| Zustellbasen (nur Hochrechnung) | 1 |

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
