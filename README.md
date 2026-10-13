# Hausnummern-Finder

Handy-Webapp (PWA) für Zusteller. Sie startet in einer **Live-Karte**: Die Position liegt auf der Straße, oben stehen groß die nächsten Hausnummern voraus, getrennt nach linker und rechter Straßenseite. Eine Zielnummer ist optional („Nr. suchen“ im Stand), dazu kommen eigene Haus-Infos zu Eingängen und Briefkästen. Gebiete werden einmal heruntergeladen, danach läuft alles offline (außer der Spracherkennung). Die App speichert keine Kundendaten, keine Fotos und keinen Standortverlauf.

**Leitprinzipien:** Während der Fahrt nur anzeigen (Eingaben ab ~11 km/h gesperrt, keine Pop-ups, keine Animationen). Keine Vorab-Eingabe von Briefen. Offline zuerst. Geschätzte und selbst gesetzte Daten sind als solche erkennbar, die GPS-Ungenauigkeit wird immer gezeigt. Alles bleibt auf dem Gerät.

> **Weiteres Projekt im Repo:** Der Prototyp *Zustell-Leitstand 3D* (fiktive Demo-Daten) liegt im Ordner [`leitstand/`](leitstand/README.md) und hat eigene Abhängigkeiten, Tests und einen eigenen Prüf-Workflow. Auf GitHub Pages liegt er unter `/leitstand/` neben dieser App (geführte Demo: `/leitstand/?demo`).

## Schnellstart

```bash
npm install
npm run demo-data      # erfundenes Demo-Gebiet "Musterdorf" (PLZ 00001/00002)
npm run dev            # http://localhost:5173
```

Das Demo-Gebiet lässt sich an den eigenen Standort legen, um GPS und Straßenseite zu testen:
`node scripts/make-demo-data.mjs --at 53.39,10.42`

## Echte Gebiete bauen (Schritt 1)

```bash
# Ganz Niedersachsen (lädt ca. 700 MB von download.geofabrik.de, dauert je nach Rechner 10–30 min)
npm run build-regions -- --download europe/germany/niedersachsen --state Niedersachsen

# Nur Tespe und Marschacht, mit Vollständigkeit pro Straße
npm run build-regions -- --input data/osm/niedersachsen-latest.osm.pbf --only 21395,21436 --details
```

* Quelle ist ein lokaler OSM-Auszug (`.osm.pbf`), keine Overpass-Abfrage. Das Skript funktioniert mit jedem Geofabrik-Auszug, z. B. `europe/germany/bayern`.
* Übernommen werden alle Objekte mit `addr:housenumber` + `addr:street` (oder `addr:place`); bei Gebäuden der Flächenschwerpunkt, auch bei Multipolygonen. Dazu alle benannten Straßen inklusive `highway=construction` (Neubaugebiete).
* Pakete gibt es pro PLZ (Standard) oder mit `--group kreis` pro Landkreis. PLZ-Zuordnung über `addr:postcode`, sonst über die OSM-PLZ-Grenzen, sonst über die nächste Adresse. Eine Straße, die über eine PLZ-Grenze läuft, liegt vollständig in beiden Paketen.
* Ausgabe: `public/regions/<id>.json.gz` und der Index `public/regions/regions.json` (Name, PLZ, Orte, Größe, Datei, Prüfsumme).
* Im Terminal steht pro Gebiet die Zahl der Straßen, Hausnummern und Straßen ohne Nummern. Mit `--details` kommt pro Straße z. B. `Nummern 1 bis 195 vorhanden (181), es fehlen 17, 23–24, 100–110` bzw. `LÜCKE: keine Hausnummern in den Daten`.
* PLZ-Pakete sind meist deutlich kleiner als 1 MB (gut für das Handy). Wer größere Pakete möchte, nimmt `--group kreis`.
* **Gebäudeumrisse** für die Karte (Gebäude mit Adresse und Wohngebäude, auf ~1 m vereinfacht) kommen nur in ein Paket, wenn es dadurch höchstens doppelt so groß wird (`--outlines-max 2`, abschaltbar mit `--outlines off`). Stand Oktober 2026 für Niedersachsen: in 558 von 833 PLZ-Gebieten enthalten, in 270 weggelassen; alle Pakete zusammen 40,8 MB ohne → 67,2 MB mit Umrissen. Die Gesamtzahlen stehen am Ende jedes Builds.

### Lücken in den Daten: was die App selbst schließt

OpenStreetMap ist nicht überall vollständig. Der Build holt deshalb alles heraus, was in den Daten steckt:

* **Interpolationslinien** (`addr:interpolation`): Wo in OSM nur Anfangs- und Endnummer mit einer Linie dazwischen eingetragen sind, werden die Nummern dazwischen erzeugt. In der App sind sie „geschätzt“ markiert („Lage aus OSM-Interpolationslinie“).
* **Gebäude ohne Hausnummer:** Wohngebäude ohne Nummer werden der nächsten Straße zugeordnet. Fehlt eine Nummer, setzt die App die geschätzte Lage auf das passende Gebäude derselben Straßenseite („auf Gebäude ohne Nummer gesetzt“). Auf der Karte erscheinen diese Gebäude als kleine Quadrate. Beim langen Drücken rastet ein eigener Punkt auf das Gebäude ein.
* **Straßen durch mehrere Gemeinden mit eigener Nummernfolge** (z. B. Elbuferstraße in Tespe und in Marschacht, beide mit einer Nr. 95) werden nach Gemeinde getrennt (notfalls nach Ortsteil oder PLZ), samt Straßenlinie. In der Suche stehen sie mit Ort, die am aktuellen Standort zuerst. Gibt es eine Nummer trotzdem mehrfach in einer Straße, wählt die App die nächstgelegene und zeigt „⚠ Nr. … gibt es mehrfach“.
* **Doppelte Straßen:** Abgetrennte Stücke ohne Hausnummern (z. B. Feldweg-Fortsetzungen) werden mit der gleichnamigen Straße bis 1,5 km Entfernung zusammengeführt.
* **Wege ohne Häuser:** Straßen ohne Nummern **und** ohne Wohngebäude (Feld- und Deichwege) gelten nicht als Lücke. Sie heißen in der App „Weg ohne Häuser“ und stehen im Bericht am Ende. Echte Lücken („keine Hausnummern, N Gebäude“) stehen ganz oben in `report.csv`.

Was dann noch fehlt, lässt sich nur mit besseren Daten schließen:

1. **Amtliche Hauskoordinaten** (siehe unten). Sie enthalten jede vergebene Hausnummer und sind die vollständigste Quelle.
2. **In OSM nachtragen**, z. B. mit der App *Every Door* (iPhone und Android) direkt vor Ort. Der wöchentliche Build übernimmt Änderungen automatisch.
3. **Eigene Punkte** in der App setzen und über „Haus-Infos sichern“ mit Kollegen teilen.

### Amtliche Adressdaten zusammenführen

Quellen sind austauschbar (`scripts/lib/sources/`). Amtliche Adressen (z. B. Hauskoordinaten eines Bundeslands) werden als CSV mit einer JSON-Konfiguration eingebunden (Spalten, Koordinatensystem `EPSG:25832`/`25833` oder lat/lon, Lizenz, Quellenangabe):

```bash
npm run build-regions -- --input data/osm/niedersachsen-latest.osm.pbf \
  --official hauskoordinaten.csv:scripts/sources/niedersachsen-hk.json --state Niedersachsen
```

**Automatisch über GitHub:** Unter *Settings › Secrets and variables › Actions › Variables* die Variable `OFFICIAL_ADDR_URL` mit der Download-Adresse der CSV- oder ZIP-Datei anlegen. Optional zeigt `OFFICIAL_ADDR_CONFIG` auf eine eigene Spalten-Konfiguration (Standard: `scripts/sources/niedersachsen-hk.json`). Passt eine Spalte nicht, bricht der Build ab und nennt alle vorhandenen Spalten.

Gleiche Adressen (gleiche Straße und Nummer, weniger als 150 m auseinander) werden zusammengeführt. Die Lage kommt aus der amtlichen Quelle (Reihenfolge mit `--prefer` änderbar). Lizenz und Quellenangabe jeder beteiligten Quelle stehen im Paket und werden in der App unter „Eigene Daten“ und „Einstellungen & Info“ angezeigt.

## Veröffentlichen und im Auto testen

`.github/workflows/deploy.yml` baut bei jedem Push auf `main`, auf Knopfdruck und einmal pro Woche die Pakete für alle PLZ in Niedersachsen. Danach laufen Tests und der Stichprobentest, und App und Pakete gehen auf GitHub Pages. Einmalig einrichten: **Settings → Pages → Source: GitHub Actions**. `report.csv` liegt danach als Download im Actions-Lauf und unter `<pages-url>/report.csv`.

Auf dem Handy die Pages-Adresse öffnen und „Zum Startbildschirm hinzufügen“ wählen. Dann unter „Gebiete“ z. B. `21395` und `21436` laden (am besten im WLAN).

## Die App

* **Live-Karte (Hauptbildschirm):** Startet direkt, sobald der Standort da ist. Alle Straßen der geladenen Gebiete als Linien (Tour-Straßen stärker), dünne Gebäudeumrisse (wenn im Paket), Hausnummern an jedem Haus (20 px, dunkler Rand, ohne Überlappung; Vorrang: Ziel, Häuser voraus, dann dahinter). Geschätzte Nummern (OSM-Interpolation) sind kursiv, selbst gesetzte haben einen Punkt („•12“) und ein eckiges Symbol. Fahrzeug im unteren Drittel, ca. 80 m voraus und 20 m zurück; Zoom mit + / − (wird gemerkt). Straßennamen sparsam und nie über Hausnummern.
* **Straßenbezug statt rohem GPS** (`src/matcher.ts`): Die Position wird auf die wahrscheinlichste Straße gelegt (Tour-Straßen bevorzugt), die Karte richtet sich nach Straßenverlauf und Fahrtrichtung. Bei Schrittgeschwindigkeit oder Stillstand ist der GPS-Kurs unzuverlässig; die Fahrtrichtung kommt dann aus der Bewegung entlang der Straße (mindestens einige Meter), sonst bleibt die letzte sichere Richtung. Im Stand springt nichts. Die Straße wechselt erst, wenn die neue zweimal hintereinander klar besser passt. Straßenname antippen → falsch erkannte Straße korrigieren.
* **Vorschauleiste:** Straßenname, darunter „◀ LINKS 42 · 44 · 46 | 41 · 43 · 45 RECHTS ▶“ relativ zur Fahrtrichtung. Beim Umkehren drehen sich Seiten und Reihenfolge mit. Bei Tour-Straßen zusätzlich „Tour A · danach …“.
* **Ziel (optional):** „Nr. suchen“ im Stand. Die Zielkarte zeigt Entfernung entlang der Straße und Seite (bzw. „EINFAHRT LINKS“ bei bekannter Zufahrt), Hinweise wie „geschätzt“, „• selbst gesetzt“, „Haus 70 m von der Straße“ und die Haus-Info. Vorbeigefahren: **„Zurück 12 m“** in Warnfarbe (optional mit Signalton). Liegt das Ziel außerhalb der Karte, zeigt ein Pfeil am Rand Richtung und Entfernung. Ein Haus in zweiter Reihe bleibt sichtbar (Karte verschiebt sich seitlich, zoomt nur begrenzt heraus).
* **Meine Tour:** Straßen einmal hinzufügen, Teil A oder B zuordnen, Reihenfolge verschieben; „Heute zuerst: A | B“. Pro Straße eine Lückenanzeige („Nummern 1 bis 40, es fehlen 17 und 23“). Oft genutzte Straßen (lokaler Zähler, nur der Name, höchstens einmal pro Tag) werden ab 3 Tagen zur Tour vorgeschlagen. Fehlende Straßen lassen sich anlegen.
* **Nr. suchen:** Straße vorausgewählt (aktuelle Live-Straße), große Tasten, „Finden“ setzt das Ziel und kehrt zur Karte zurück. Schnelltasten zur letzten Nummer: **−2, +2, gegenüber**. Spracheingabe als Zusatz, mit Tour nur für Tour-Straßen („fünfundneunzig“, „zwölf a“); bei Fehlschlag sofort die Tastatur.
* **Hier ist Nr. …:** Mit Ziel „Hier“ tippen: Nummer links oder rechts der Straße (Abstand 8/15/25/40 m) oder genau hier setzen, oder „Hier ist die Einfahrt“. Ein Tap, danach „Rückgängig“. Selbst gesetzte Punkte haben Vorrang vor den Grunddaten. Langes Drücken auf die Karte setzt Nummer oder Einfahrt an einer beliebigen Stelle.
* **Haus-Infos:** Zufahrt, Eingänge mit Lage und Briefkastenzahl, kurzer Hinweis – alles per Knopf. Hinweise mit erkennbaren Personennamen werden nicht gespeichert (auch nicht beim Import).
* **Bildschirm bleibt an:** Screen Wake Lock; für iPhone-Web-Apps zusätzlich ein stummes Mini-Video als Ausweichweg. Auf dem iPhone funktioniert Wake Lock in Home-Bildschirm-Apps laut WebKit erst ab iOS 18.4 zuverlässig, und ob es wirkt, lässt sich nicht abfragen. Sicher ist: Einstellungen › Anzeige & Helligkeit › Automatische Sperre › Nie.
* **Hell/Dunkel:** automatisch nach Systemeinstellung, fest wählbar unter Einstellungen. Farbe ist nie das einzige Signal (immer auch Text oder Form).
* **Status (Menü):** „Offline bereit“, „Update verfügbar – tippen zum Neuladen“ (neue Versionen werden nie mitten in der Tour geladen), „Gebiet unvollständig“, „Sicherung fällig“; ein „!“ am Menüknopf, wenn etwas ansteht. GPS-Genauigkeit immer oben, ab 15 m deutlicher Hinweis.
* **Speicher und Sicherung:** IndexedDB, dauerhafter Speicher wird angefordert (Status unter „Eigene Daten“). „Haus-Infos sichern“ speichert Haus-Infos, eigene Punkte, Einfahrten, Straßen als JSON-Datei; Erinnerung nach 14 Tagen. Import: bei Konflikten gewinnt der neuere Stand.
* **Fehlerfälle:** Standort verweigert (Anleitung für iPhone/Android, prüft beim Zurückkehren automatisch neu), GPS ungenau, keine Straße in der Nähe, Gebiet fehlt (Knopf zu den Gebieten).
* **Akku:** Die Karte zeichnet nur bei Änderungen neu; im Hintergrund ist das GPS aus.
* **Nicht enthalten (bewusst):** Vorab-Eingabe von Briefen, Kamera/Fotos, Scanner- oder Sendungsdaten, Kundennamen, Konten, Cloud, Tracking, Standortverlauf, Statistiken.

## Qualitätsbericht und Stichprobentest (Schritt 5)

```bash
npm run report        # report.csv, schlechteste Straßen zuerst (+ Top 20 im Terminal)
npm run sample-test   # zufällige Adressen je Gebiet über die App-Logik abfragen
npm test              # Unit- und End-to-End-Tests (synthetisches OSM-Gebiet, simulierte Fahrten)
npm run test:browser  # Browsertests in Handygröße mit simuliertem GPS (Playwright/Chromium)
```

Die Browsertests fahren im erfundenen Musterdorf: lange Straße, Kurve, Kreuzung, Abbiegen, Umkehr im Schritttempo, Stillstand mit springendem GPS, Haus in zweiter Reihe, fehlende Nummer, Straße über zwei PLZ-Gebiete, Vorbeifahren, Eingabesperre bei Fahrt. Der Workflow „Prüfen“ führt sie bei jedem Push auf einen Arbeitszweig aus, zusammen mit einem Bau aller Pakete aus echten OSM-Daten.

### Im echten Einsatz testen

Was sich ohne echtes iPhone, echtes GPS und echte Straßen nicht prüfen lässt:

1. **Update angekommen:** App ganz schließen und neu öffnen. Menü zeigt „Offline bereit“, Einstellungen zeigen die Version.
2. **Offline:** Flugmodus an, App öffnen. Karte, Vorschau, Nr. suchen und Haus-Infos müssen gehen (nur Sprechen nicht).
3. **Bildschirm bleibt an:** Handy in der Halterung am Ladekabel 10 Minuten nicht berühren. Geht er aus: Automatische Sperre auf „Nie“ stellen und das melden.
4. **Straßenerkennung:** Elbuferstraße in Tespe und in Marschacht abfahren. Stimmen Straße und Ort oben? An Kreuzungen (z. B. Avendorfer Weg) kein Hin- und Herspringen? Falsche Straße per Antippen korrigierbar?
5. **Vorschauleiste:** An 5 Stellen die oben angezeigten Nummern links/rechts mit den Hausnummern an den Häusern vergleichen, auch im Schritttempo und nach dem Wenden.
6. **Stillstand:** Beim Halten springt nichts (Karte, Seiten, Richtung).
7. **GPS-Genauigkeit:** Wo erscheint „GPS ungenau“ (Bäume, enge Bebauung)? Wie weit liegen Position und Straße auseinander?
8. **Ziel:** Drei Briefe hintereinander mit Nr. suchen, +2 und gegenüber. Stimmen Entfernung und Seite? Nach dem Vorbeifahren „Zurück … m“?
9. **Zweite Reihe:** Bei den alten Höfen an der Elbuferstraße: Führung zur Einfahrt korrekt? Wo keine Einfahrt bekannt ist, mit „Hier → Hier ist die Einfahrt“ setzen und beim nächsten Mal prüfen.
10. **Lücken schließen:** Eine fehlende Nummer mit „Hier ist Nr. …“ links/rechts setzen, Lage prüfen, „Rückgängig“ ausprobieren. Die Lückenanzeige unter „Meine Tour“ wird kleiner.
11. **Meine Tour:** Teil A und B einrichten, „Heute zuerst“ umschalten, „danach …“ oben prüfen.
12. **Sprache:** „fünfundneunzig“, „zwölf a“, „Elbuferstraße zweiundvierzig“ – mit und ohne Netz.
13. **Lesbarkeit:** Aus 50–70 cm bei Sonne und in der Dämmerung, hell und dunkel. Schrift groß genug?
14. **Eingabesperre:** Während der Fahrt gesperrt, im Stand sofort frei? Stört sie?
15. **Sicherung:** „Haus-Infos sichern“ in „Dateien“ speichern. Steht unter „Eigene Daten“ „Speicher: dauerhaft“?
16. **Akku:** Verbrauch über 2 Stunden am Ladekabel.
17. **Standort verweigert:** In den iPhone-Einstellungen kurz ausschalten → Anleitung erscheint; wieder einschalten → läuft ohne Neustart weiter.

## Spätere Phase

Den Kamera-Scan der Adresszeile nicht bauen, solange nicht mit der Zustellbasis geklärt ist, ob er nach Datenschutz und Postgeheimnis erlaubt ist.

Kartendaten © OpenStreetMap-Mitwirkende, ODbL.
