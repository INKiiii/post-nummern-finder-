# Hausnummern-Finder

Handy-Webapp (PWA) für Zusteller: Straße wählen oder sagen, Hausnummer eintippen, und die App zeigt Entfernung, Straßenseite (links/rechts aus der Fahrtrichtung) und die eigenen Haus-Infos zu Eingängen und Briefkästen. Gebiete werden einmal heruntergeladen, danach läuft alles offline. Die App speichert keine Kundendaten.

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

### Amtliche Adressdaten zusammenführen

Quellen sind austauschbar (`scripts/lib/sources/`). Amtliche Adressen (z. B. Hauskoordinaten eines Bundeslands) werden als CSV mit einer JSON-Konfiguration eingebunden (Spalten, Koordinatensystem `EPSG:25832`/`25833` oder lat/lon, Lizenz, Quellenangabe):

```bash
npm run build-regions -- --input data/osm/niedersachsen-latest.osm.pbf \
  --official hauskoordinaten.csv:scripts/sources.example.json --state Niedersachsen
```

Gleiche Adressen (gleiche Straße und Nummer, weniger als 150 m auseinander) werden zusammengeführt. Die Lage kommt aus der amtlichen Quelle (Reihenfolge mit `--prefer` änderbar). Lizenz und Quellenangabe jeder beteiligten Quelle stehen im Paket und werden in der App unter „Daten“ angezeigt.

## Veröffentlichen und im Auto testen

`.github/workflows/deploy.yml` baut bei jedem Push auf `main`, auf Knopfdruck und einmal pro Woche die Pakete für alle PLZ in Niedersachsen. Danach laufen Tests und der Stichprobentest, und App und Pakete gehen auf GitHub Pages. Einmalig einrichten: **Settings → Pages → Source: GitHub Actions**. `report.csv` liegt danach als Download im Actions-Lauf und unter `<pages-url>/report.csv`.

Auf dem Handy die Pages-Adresse öffnen und „Zum Startbildschirm hinzufügen“ wählen. Dann unter „Gebiete“ z. B. `21395` und `21436` laden (am besten im WLAN).

## Die App

* **Start:** Suchfeld mit Autovervollständigung (tippfehlertolerant, `Str.`/`Straße` egal), zuletzt genutzte Straßen oben, die letzten 5 Adressen als Schnellwahl. Dazu eine große Zahlentastatur mit Buchstaben-Zusatz (12a).
* **Straße automatisch:** Mit GPS schlägt der Startscreen oben die nächstgelegene Straße (bis 50 m) als großen Knopf vor, an Kreuzungen zusätzlich die zweite. Antippen und nur noch die Nummer eingeben. Die Suche bleibt.
* **Status:** „✓ Offline bereit · 2 Gebiete“, wenn der Service Worker alle App-Dateien gespeichert hat und mindestens ein Gebiet geladen ist, sonst ein gelber Hinweis.
* **Standort verweigert:** Statt „–“ erscheint eine rote Anleitung „Standort erlauben: Einstellungen, Datenschutz, Ortungsdienste“ mit den Schritten für iPhone bzw. Android.
* **Ergebnis:** Entfernung (Luftlinie) und groß **LINKS/RECHTS**. Liegt das Haus mehr als 20 m von der Straße, steht der Abstand dabei. Zufahrten aus OSM (`highway=service` + `service=driveway`) werden eingezeichnet, die Abzweigung ist mit **E** markiert („Einfahrt in 120 m links“). Fehlt eine Zufahrt, setzt man die Einfahrt per langem Drücken selbst; sie wird lokal gespeichert und mit exportiert.
* **Karte:** Standard ist „Fahrtrichtung oben“ mit leichter Neigung, umschaltbar auf „Norden oben“ (die Wahl wird gemerkt). Mit GPS folgt die Karte dem Auto: Das Auto sitzt im unteren Drittel, die Karte zeigt höchstens ~120 m voraus und zoomt beim Annähern weiter heran. Ist das Ziel weiter weg, zeigt ein Pfeil am Rand Richtung und Entfernung („42 · 340 m“, bei vorhandener Zufahrt „E · …“), statt herauszuzoomen. Haus, Einfahrt und Auto bleiben im Nahbereich immer im Bild, auch bei Häusern in zweiter Reihe. Beschriftet werden nur die Zielnummer und je 3 Nachbarn derselben Straßenseite davor und dahinter, im Umkreis von 40 m um das Auto alle sichtbaren Nummern. Alle anderen Häuser sind kleine Punkte. Beschriftungen überlappen nie; Hausnummern haben Vorrang, Straßennamen weichen entlang der Straße aus oder werden ausgeblendet. Die Knöpfe liegen in einer Leiste unter der Karte.
* **Straßenseite:** Fährt man auf der Zielstraße, wird die Straßenseite benutzt (stimmt auch in Kurven und bei weit entfernten Zielen), sonst die Richtung zum Ziel. Die Karte ist selbst gezeichnet (SVG, keine Kacheln), mit Postauto in Fahrtrichtung.
* **Fehlende Nummern:** Fehlende Nummern werden aus den Nachbarn derselben Straßenseite geschätzt und als **geschätzt** markiert („zwischen 15 und 19“).
* **Haus-Infos:** Zufahrt, Eingänge mit Lage und Briefkastenzahl (Plus/Minus), kurzer Hinweis. Alles zum Antippen. Die Karte zeigt z. B. „42: 2 Eingänge. Rechts: 3 Briefkästen. Links hinten: 2 Briefkästen.“ Hinweise mit erkennbaren Namen werden nicht gespeichert, auch nicht beim Import.
* **Sprechen:** Mikrofon antippen und „Elbuferstraße zweiundvierzig“ sagen, das Ergebnis erscheint ohne Bestätigung. „Nächster Brief“ hört direkt wieder zu. Die Spracherkennung braucht je nach Browser Internet; die Tastatur geht immer offline.
* **Lücken schließen:** Lang auf die Karte drücken setzt eine Hausnummer („selbst gesetzt“). Fehlende Straßen legt man über die Suche an: nachzeichnen, beim Fahren aufzeichnen oder nur mit Startpunkt.
* **Sichern und Teilen:** „Haus-Infos sichern“ (unter „Daten“) speichert Haus-Infos, eigene Punkte, Einfahrten und Straßen als JSON-Datei (Teilen-Menü oder Download). Ist die letzte Sicherung älter als 14 Tage oder gab es noch keine, erinnert der Startscreen daran (nur wenn eigene Daten vorhanden sind). Import unter „Daten“; bei Konflikten gewinnt der neuere Stand.
* Speicherung nur lokal (IndexedDB). Der Service Worker hält die App offline bereit.

## Qualitätsbericht und Stichprobentest (Schritt 5)

```bash
npm run report        # report.csv, schlechteste Straßen zuerst (+ Top 20 im Terminal)
npm run sample-test   # zufällige Adressen je Gebiet über die App-Logik abfragen
npm test              # Unit- und End-to-End-Tests (synthetisches OSM-Gebiet)
```

**Praxistest Tespe/Marschacht (manuell):** Elbuferstraße, Neubaugebiet Schilfring und Nachbarstraßen (Schreibweise in `--details 21395,21436` prüfen). Prüfpunkte: Straßenseite, Entfernung, Reihenfolge der Nummern.

## Spätere Phase

Den Kamera-Scan der Adresszeile erst bauen, wenn mit der Zustellbasis geklärt ist, ob er nach Datenschutz und Postgeheimnis erlaubt ist.

Kartendaten © OpenStreetMap-Mitwirkende, ODbL.
