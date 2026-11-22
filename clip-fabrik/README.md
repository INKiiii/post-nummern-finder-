# Clip-Fabrik

**Stream rein, fertige Clips raus.** Die App erkennt, wenn ein Twitch-Streamer live geht, nimmt den Stream auf, findet die stärksten Momente (Chat, Lautstärke, Transkript, Claude) und schneidet sie hochkant mit Wort-für-Wort-Untertiteln. Du prüfst die Clips am Handy per Wischen. Freigegebene Clips gehen mit eigenen Texten pro Plattform an TikTok, Instagram Reels und YouTube Shorts, verteilt über den Tag und mit Rücksicht auf die Limits.

Die schwere Arbeit (Aufnahme, Whisper, ffmpeg) läuft auf einem gemieteten Server. Du bedienst alles am Handy als App (PWA).

> **Zustimmung ist Pflicht.** Die App verarbeitet nur Kanäle, deren Inhaber zugestimmt hat. Beim Anlegen eines Kanals wird das abgefragt. Optional bestätigt der Streamer per Link mit seinem eigenen Twitch-Login.

---

## Inhalt

1. [Einrichtung nur am Handy (≈ 10 Minuten)](#1-einrichtung-nur-am-handy--10-minuten)
2. [Erste Schritte in der App](#2-erste-schritte-in-der-app)
3. [Kosten](#3-kosten)
4. [So wählt die App Clips aus](#4-so-wählt-die-app-clips-aus)
5. [Live-Modus und Nachbearbeitung](#5-live-modus-und-nachbearbeitung)
6. [API-Freigaben für TikTok, Instagram, YouTube](#6-api-freigaben-für-tiktok-instagram-youtube)
7. [Push-Benachrichtigungen](#7-push-benachrichtigungen)
8. [Was die App bewusst nicht tut, und Grenzen](#8-was-die-app-bewusst-nicht-tut-und-grenzen)
9. [Entwicklung und Tests](#9-entwicklung-und-tests)
10. [Fehlerbehebung](#10-fehlerbehebung)

---

## 1. Einrichtung nur am Handy (≈ 10 Minuten)

Du brauchst: ein Handy, eine E-Mail-Adresse und eine Zahlungsmethode für den Server. Eine eigene Domain ist **nicht** nötig. Die App läuft dann unter `https://<IP-mit-Bindestrichen>.sslip.io` mit echtem HTTPS-Zertifikat.

### Schritt 1: Server mieten (Hetzner Cloud, App „Hetzner Cloud“ oder Browser)

1. Konto bei Hetzner Cloud anlegen und ein Projekt erstellen.
2. **Server hinzufügen**:
   - Standort: Falkenstein oder Nürnberg
   - Image: **Ubuntu 24.04**
   - Typ: **CPX31** (4 vCPU, 8 GB RAM, 160 GB SSD) für den Start. Mehr dazu unter [Kosten](#3-kosten).
   - SSH-Schlüssel: kannst du weglassen, du bekommst dann ein Root-Passwort per Mail (brauchst du normalerweise nie).
3. Ganz unten bei **Cloud config** den kompletten Inhalt von [`deploy/cloud-init.yaml`](deploy/cloud-init.yaml) einfügen.
   **Nur diese eine Zeile ändern:** `ADMIN_PASSWORD=…` (dein Passwort für die App, mindestens 10 Zeichen).
4. **Erstellen** tippen und die angezeigte IPv4-Adresse merken, z. B. `203.0.113.7`.

### Schritt 2: Warten und zusehen

- Nach ca. 2 Minuten zeigt `http://203.0.113.7` (deine IP) eine Fortschrittsseite.
- Nach ca. 10 Minuten läuft die App unter **`https://203-0-113-7.sslip.io`** (Punkte durch Bindestriche ersetzt).

### Schritt 3: App aufs Handy holen

1. Adresse im Browser öffnen und mit deinem Passwort einloggen.
2. **iPhone:** Teilen → „Zum Home-Bildschirm“. Danach die App nur noch über das neue Symbol öffnen, nur so funktionieren Push-Pop-ups.
   **Android (Chrome):** Menü → „App installieren“.
3. In der App: **Mehr → Einstellungen → Push auf diesem Handy aktivieren**.

Fertig. Weiter mit [Erste Schritte](#2-erste-schritte-in-der-app).

<details>
<summary>Alternativen: eigener Server, eigene Domain, Cloudflare Tunnel, GPU, Railway/Fly.io</summary>

- **Eigener Linux-Server (Ubuntu):** Repository klonen und `sudo ADMIN_PASSWORD=… bash clip-fabrik/deploy/setup.sh` ausführen. Das Skript installiert Docker, legt `.env` mit Zufallsschlüssel an, richtet Firewall, Swap und automatische Updates ein und startet alles.
- **Eigene Domain:** Einen A-Record auf die Server-IP setzen und in der Cloud-Config `DOMAIN=clips.deinedomain.de` eintragen. Läuft der Server schon: `DOMAIN` und `PUBLIC_URL` in `/opt/clipfabrik/clip-fabrik/.env` ändern, dann `docker compose up -d`.
- **Cloudflare Tunnel** (keine offenen Ports): `TUNNEL_TOKEN` in `.env` eintragen und `docker compose --profile tunnel up -d` ausführen. `PUBLIC_URL` muss dann die Tunnel-Adresse sein.
- **GPU-Server** (z. B. Hetzner GEX44): Das Setup-Skript erkennt NVIDIA-Karten automatisch, installiert Treiber und Container-Toolkit und startet den Worker mit `docker-compose.gpu.yml` (Whisper `large-v3` auf CUDA, NVENC, wenn verfügbar).
- **Privates Repository:** In der Cloud-Config `REPO_URL=https://<lese-token>@github.com/INKiiii/post-nummern-finder-.git` setzen. Das Token braucht nur Lesezugriff auf den Inhalt.
- **Railway / Fly.io:** Grundsätzlich möglich (es gibt ein Dockerfile), aber nicht empfohlen. Stundenlange Aufnahmen brauchen viel persistenten Speicher und drei dauerhaft laufende Prozesse (API, Worker, Daemon). Das wird dort schnell teurer als ein Hetzner-Server und ist umständlicher einzurichten.
</details>

---

## 2. Erste Schritte in der App

| # | Wo | Was |
|---|---|---|
| 1 | Mehr → Einstellungen → KI | **Anthropic-API-Key** eintragen ([console.anthropic.com](https://console.anthropic.com)), „Key testen“ tippen (kostet nichts). Ohne Key läuft nur ein schwacher Heuristik-Modus. |
| 2 | dev.twitch.tv/console/apps | **Twitch-Anwendung registrieren**: Name beliebig, OAuth-Redirect `https://<deine-adresse>/api/twitch/callback`, Kategorie „Application Integration“, Client-Typ „Vertraulich“. Client-ID und Secret notieren. |
| 3 | Mehr → Einstellungen → Twitch-App | Client-ID und Secret eintragen. Ab jetzt läuft die Live-Erkennung (EventSub + Polling alle 30 s). |
| 4 | Mehr → Konten | **Mit Twitch einloggen** (dein Mod-Konto). Rechte: nur `chat:read` und `clips:edit`. Damit liest die App den Chat mit und kann Twitch-Clips als Marker setzen. |
| 5 | Kanäle → + Kanal | Twitch-Namen eingeben, **Zustimmung des Streamers bestätigen**, Live-Clipping und/oder Nachbearbeitung wählen. |
| 6 | Kanal → ⚙︎ | Clips pro Stream, Mindest-Score, Brand-Voice, Layout (Facecam oben), `!clip`, Twitch-Clips als Marker. Optional „Einladungslink teilen“, damit der Streamer per Twitch-Login offiziell bestätigt. |
| 7 | Mehr → Konten | TikTok/Instagram/YouTube verbinden, sobald die App-Freigaben da sind ([Kapitel 6](#6-api-freigaben-für-tiktok-instagram-youtube)). Bis dahin: Export-Paket. |

**Im Alltag:**

- **Push „12 neue Clips bereit“** antippen, und die Karten-Review öffnet sich direkt.
- **Wischen:** → freigeben, ← ablehnen, ↑ später. ✎ öffnet den Editor (Schnitt, Hook, Untertitel, Texte pro Plattform, Neu-Rendern).
- **„Jetzt clippen“** (großer roter Knopf, solange der Kanal aufnimmt) markiert die letzten 30–60 Sekunden. Mods können dasselbe im Chat mit `!clip` auslösen.
- **Plan** (Warteschlange): Was geht wann raus. Gedrückt halten und ziehen sortiert um, die Zeiten werden neu verteilt.
- **Archiv → Freigegeben → Export-Paket**: ZIP mit Clips und `captions_<plattform>.csv`, falls eine Plattform-API noch nicht freigegeben ist. Pro Clip gibt es außerdem „Teilen“ und „Aufs Handy speichern“.

---

## 3. Kosten

Alle Preise sind ungefähre Werte. Bitte vor dem Mieten die aktuellen Preise beim Anbieter prüfen.

### Server pro Monat

| Variante | Beispiel | Preis/Monat (ca.) | Eignung |
|---|---|---|---|
| **CPU klein** | Hetzner CPX31: 4 vCPU, 8 GB, 160 GB | 15–20 € | Nachbearbeitung (Whisper `medium`), Live-Modus mit `small`, 1–2 Kanäle |
| **CPU stark** | Hetzner CCX33: 8 dedizierte vCPU, 32 GB, 240 GB | 50–65 € | mehrere Kanäle, lange Streams täglich, schnellere Analyse |
| **+ Speicher** | Hetzner Volume 200 GB | ca. 9–10 € | wenn Rohaufnahmen länger als 7 Tage bleiben sollen |
| **GPU** | Hetzner GEX44 (RTX 4000 Ada 20 GB) | ca. 185–200 € + Einrichtungsgebühr | Live-Modus mit vielen Kanälen, Whisper `large-v3`, sehr schnelles Rendern |

**Speicherbedarf:** Eine Stream-Stunde in 1080p60 belegt etwa 3–4 GB, ein 8-Stunden-Stream also bis zu 30 GB. Rohmaterial wird nach 7 Tagen gelöscht (einstellbar), fertige Clips bleiben.

### Pro Stream-Stunde

| Posten | CPU-Server (4 vCPU) | GPU-Server |
|---|---|---|
| Rechenzeit Transkription (`medium`, int8, mit VAD) | ca. 20–50 min | ca. 2–4 min (`large-v3`) |
| Rendern (15 Vorschauen 540p + Originale nur für Freigaben) | ca. 3–6 min | ca. 1 min |
| **Claude Sonnet 5.5** (Standard) | **ca. 0,24 $ für 1 h**, gedeckelt bei ca. 0,45 $ für 4–8 h | gleich |
| Claude Opus 5.5 (beste Auswahl) | ca. 0,47 $ / bis 0,90 $ | gleich |
| Claude Haiku 5.5 (sehr günstig) | ca. 0,01 $ / bis 0,02 $ | gleich |

Die Claude-Kosten sind gedeckelt, weil nur Momente mit starkem Signal an Claude gehen (höchstens 3 × Clip-Quote + 10 Kandidatenfenster pro Stream). Die App zeigt **vor dem Start** eine Schätzung an und fragt nach, wenn sie über deinem Budget pro Stream liegt (Standard 3 $). Je nach Effort kommen Denk-Tokens dazu, rechne mit dem Faktor 1,5–2. Wiederholte Anfragen kommen aus dem Cache und kosten nichts. Die tatsächlichen Kosten stehen pro Stream unter „Streams“ und gesammelt unter „Auswertung“.

**Beispiel:** CPX31 + täglich ein 4-Stunden-Stream mit Sonnet ≈ 18 € + 30 × 0,45 $ × 1,5 ≈ **38 € im Monat**.

---

## 4. So wählt die App Clips aus

Die Auswahl ist eine mehrstufige Pipeline, kein einzelner Claude-Aufruf:

1. **Signal-Vorfilter:** Kandidaten entstehen nur an Momenten mit starkem Signal: Chat-Spitze (Nachrichtenrate gegenüber der Basis, Emote-Spam wie KEKW/OMEGALUL, Großbuchstaben, Subs, Raids, Bits), Lautstärke-Ausreißer, Gelächter, Stille nach der Pointe, Wortwiederholungen („nein nein nein“), Reaktionswörter, gehäufte Timeouts/Bans, manuelle Marker. Der Chat läuft dem Bild ein paar Sekunden hinterher, das wird ausgeglichen.
2. **Claude-Bewertung pro Kandidat** nach festem Raster (je 1–10): Hook in den ersten 2 Sekunden, Pointe, Verständlichkeit ohne Vorwissen, emotionale Intensität, Meme-Potenzial, Risiko. Der Gesamt-Score ist ein gewichteter Mittelwert, die Gewichte stehen in den Einstellungen. Dazu eine Begründung in einem Satz. Optional sieht Claude Einzelbilder (Vision).
3. **Harte Ausschlüsse:** Hassrede, Beleidigung, Diskriminierung, sexuelle Inhalte, Gewalt, Selbstverletzung, private Daten, laufende Musik, fremde Videos, Richtlinienverstöße. Solche Clips werden markiert und gehen nur mit deiner ausdrücklichen Freigabe raus. Eine Regex-Prüfung (Telefonnummern, Adressen, E-Mails, IBAN, Schimpfwörter, Musik-Marker) läuft zusätzlich, und **vor jeder Veröffentlichung** gibt es einen eigenen Safety-Check.
4. **Knackig verpacken:** Ziel 10–35 s, Start und Ende auf Wortgrenzen, nie mitten im Satz, Füllwörter am Rand weg, Hook-Untertitel oben, optional ein Rückblick-Cut von 2–4 s, Wort-für-Wort-Untertitel in Großbuchstaben mit Highlight-Wort, Lautheit auf −14 LUFS, weiche Ein- und Ausblendung für sauberes Loopen.
5. **Dedupe und Vielfalt:** Kein Moment doppelt (zeitliche Überlappung), kein Witz doppelt (Text-Ähnlichkeit), keine zwei gleichen Formate hintereinander.
6. **Ranking und Quote:** Ein Gesamt-Ranking über den ganzen Stream. Nur die besten N Clips (Standard 15) kommen in die Review, der Rest landet im Archiv „Auch gut“.
7. **Lernschleife:** Deine Freigaben und Ablehnungen sowie die späteren Views (Top/Flop) gehen als Beispiele in den Bewertungs-Prompt ein. So lernt die Auswahl den Humor des Streamers und das Publikum kennen.

Für Untertitel nutzt die App eigene ASS-Dateien mit `PlayResX=1080 / PlayResY=1920`, damit alle Werte echte Pixel sind. Für den SRT-Fallback rechnet sie in die libass-Standardauflösung (288 Pixel Höhe) um: `FontSize=11`, `MarginV=45`. Ein Test rendert echte Frames und prüft, dass die Untertitel sichtbar, richtig groß und richtig platziert sind.

---

## 5. Live-Modus und Nachbearbeitung

| | Nachbearbeitung (Modus A) | Live-Clip-Farmer (Modus B) |
|---|---|---|
| Start | bei `stream.offline` | während des Streams, ca. 60–90 s Verzögerung |
| Auslöser | ganze Aufnahme | Chat-Spitze, Lautstärke/Gelächter im letzten Segment, „Jetzt clippen“, `!clip` |
| Ergebnis | Push „N neue Clips bereit“ mit dem besten Clip | Push „Clip mit Score 9 bereit“ (höchstens 1 alle 10 min, Rest gesammelt am Ende) |
| Extras | Gesamt-Durchlauf bestätigt, verbessert oder dedupliziert die Live-Funde | optional Twitch-Clip als Marker und Sicherheitskopie (`clips:edit`) |

**Aufnahme:** streamlink nimmt den öffentlichen Stream in 2-Minuten-Segmenten (MPEG-TS) auf. Das übersteht Abstürze. Bei Verbindungsabbruch verbindet die App automatisch neu, die Lücke wird markiert. Werbepausen filtert streamlink heraus, sie werden ebenfalls notiert. Bei Abo-only-Streams kommt eine klare Meldung statt eines Absturzes; Ausweg sind Twitch-Clips oder das VOD-Backup (wenn der Kanal VODs speichert). Speicher wird überwacht: Warnung bei knappem Platz, Stopp bevor der Server vollläuft.

---

## 6. API-Freigaben für TikTok, Instagram, YouTube

Die App nutzt **ausschließlich die offiziellen APIs**. Solange eine Freigabe fehlt, nutzt du das **Export-Paket** (Archiv → Freigegeben). Der Quota-Tracker unter „Plan“ zeigt pro Konto, was heute noch geht.

### TikTok (Content Posting API)

1. [developers.tiktok.com](https://developers.tiktok.com) → App anlegen → Produkte **Login Kit** und **Content Posting API** hinzufügen.
2. Scopes: `user.info.basic`, `video.upload`, `video.publish`, `video.list`. Redirect-URI: `https://<adresse>/api/oauth/tiktok/callback`.
3. `TIKTOK_CLIENT_KEY` und `TIKTOK_CLIENT_SECRET` in `.env` eintragen (oder das Secret in den Einstellungen).
4. **Ohne Audit** erlaubt TikTok nur **private Posts** (SELF_ONLY). Die App setzt das automatisch und zeigt es an. Alternativ wählst du im Konto **„Entwurf in Inbox“**: Der Clip landet in deiner TikTok-Inbox, und du veröffentlichst ihn selbst in der TikTok-App.
5. Für öffentliches Posten das **Audit** beantragen (Formular im Developer-Portal, mit Demo-Video des Ablaufs). Danach in der App beim Konto „App-Freigabe/Audit erteilt“ einschalten.

### Instagram Reels (Instagram API mit Instagram-Login)

1. Instagram-Konto in ein **Business- oder Creator-Konto** umwandeln (in der Instagram-App unter Einstellungen → Kontotyp).
2. [developers.facebook.com](https://developers.facebook.com) → App (Typ „Business“) → Produkt **Instagram** → „API mit Instagram-Login“.
3. Berechtigungen: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights`. Redirect: `https://<adresse>/api/oauth/instagram/callback`.
4. `META_APP_ID` und `META_APP_SECRET` eintragen. Im Entwicklungsmodus funktionieren nur eingetragene Test-Nutzer. Für alle anderen braucht es die **App-Prüfung** (Screencast und Datenschutz-URL).
5. Limit: **50 API-Veröffentlichungen in 24 Stunden** pro Konto (wird berücksichtigt).

### YouTube Shorts (YouTube Data API v3)

1. [console.cloud.google.com](https://console.cloud.google.com) → Projekt → **YouTube Data API v3** aktivieren.
2. OAuth-Zustimmungsbildschirm (extern) einrichten, Scopes `youtube.upload` und `youtube.readonly`. OAuth-Client „Webanwendung“ mit Redirect `https://<adresse>/api/oauth/youtube/callback`.
3. `GOOGLE_CLIENT_ID` und `GOOGLE_CLIENT_SECRET` eintragen.
4. Solange die App „im Test“ ist, laufen Refresh-Tokens nach 7 Tagen ab. Für Dauerbetrieb die **Verifizierung** beantragen. Ungeprüfte Projekte laden Videos unter Umständen nur privat hoch.
5. **Kontingent:** 10.000 Einheiten pro Tag, ein Upload kostet laut Doku 1.600 Einheiten, das sind rund 6 Uploads am Tag. Für mehr ein **Quota-Erweiterungsformular** einreichen und danach den neuen Wert in den Einstellungen eintragen. Beide Werte sind einstellbar, falls Google die Kosten ändert.

### Konten, die dir nicht gehören (z. B. der Kanal des Streamers)

Konten → „Streamer einladen“ → Link teilen. Der Streamer öffnet den Link am Handy und meldet sich **direkt bei der Plattform** an. Du siehst dabei nie sein Passwort, und er kann den Zugriff jederzeit bei der Plattform widerrufen. Mehrere Konten pro Plattform (Hauptkanal, Fan-Pages) sind möglich, jedes mit eigenem Tageslimit, eigenen Sendefenstern, Mindestabstand und zufälligem Versatz.

---

## 7. Push-Benachrichtigungen

- **Web-Push (PWA, VAPID):** Android/Chrome direkt. Auf dem iPhone ab iOS 16.4 nur, wenn die App über „Zum Home-Bildschirm“ installiert und von dort geöffnet wird. Ein Tipp auf die Benachrichtigung öffnet die passende Ansicht.
- **Fallback:** Telegram-Bot (Token und Chat-ID) oder ntfy (`https://ntfy.sh/<geheimes-thema>` in der ntfy-App abonnieren).
- Pro Ereignis abschaltbar: Stream gestartet, Stream beendet, neue Clips bereit, starker Live-Clip (mit Ratenbegrenzung), Fehler, Veröffentlichung fehlgeschlagen.

---

## 8. Was die App bewusst nicht tut, und Grenzen

- **Keine** inoffiziellen Automatisierungen, Login-Skripte oder Browser-Bots, **kein** Umgehen von Limits, keine gekauften Interaktionen, kein Scraping von Twitch (Live-Erkennung nur über Helix und EventSub).
- **Ohne API-Freigaben** posten TikTok/Instagram/YouTube nur eingeschränkt (privat, Entwurf, Test-Nutzer). Das Export-Paket ist der regelkonforme Weg bis dahin.
- **Abo-only-Streams** lassen sich öffentlich nicht aufnehmen. Ein Mod-Token gibt streamlink keinen Zugang zu Abo-Streams.
- **Lach-Erkennung** ist eine Heuristik (rhythmische Lautstärke). Sie zählt nur zusammen mit anderen Signalen.
- **Live-Modus auf CPU:** Funktioniert mit Whisper `small` und moderater Clip-Rate. Bei vielen gleichzeitigen Kanälen ist eine GPU nötig.
- **Twitch-Chat über IRC:** Twitch empfiehlt langfristig EventSub-Chat. Der Chat-Client ist gekapselt und lässt sich umstellen, wenn IRC abgeschaltet wird.
- **Create Clip als Mod:** funktioniert nur, wenn der Kanal Clips erlaubt.

---

## 9. Entwicklung und Tests

```bash
# Backend
cd clip-fabrik/backend
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt && pip install -e .
python -m pytest            # 75 Tests, ca. 3 Minuten (braucht ffmpeg)

# Frontend
cd ../frontend
npm ci && npm run build      # Typprüfung + Build nach frontend/dist

# Lokal starten (ohne Docker): API + Worker + Daemon in einem Prozess
cd ../backend
DATA_DIR=./data ADMIN_PASSWORD=lokal-passwort-1 FRONTEND_DIST=../frontend/dist clipfabrik all
# → http://localhost:8000

# Demo-Daten (synthetische Streams durch die komplette Pipeline, ohne API-Keys)
DATA_DIR=./demo-data CLIPFABRIK_FAKE_AI=1 ENABLE_MOCK_PUBLISHER=1 ADMIN_PASSWORD=demo-passwort-123 python -m clipfabrik.devtools.seed_demo

# Oberflächen-Test im Handyformat (Playwright, Server muss laufen)
cd ../frontend && BASE_URL=http://127.0.0.1:8000 PASSWORD=demo-passwort-123 SHOTS=./shots node tests/e2e.mjs

# Mock-Twitch-Server zum Ausprobieren (Live an/aus, Chat-Spitze, !clip per Tastendruck)
python -m clipfabrik.devtools.mock_twitch --port 9999
```

**Was die Tests abdecken:**

| Test | Inhalt |
|---|---|
| `test_subtitles_render.py` | rendert echte Frames: Untertitel sichtbar, Größe und Abstand passen, Highlight-Wort gelb, Vorschau skaliert mit, SRT mit libass-Einheiten (FontSize 11 / MarginV 45), Gegenprobe mit FontSize 60 schlägt an |
| `test_units.py` | Zeitstrahl mit Lücken, Verpacken (Wortgrenzen, Füllwörter, Längen, stille Momente), Dedupe/Vielfalt, Score/Ausschlüsse, IRC- und EventSub-Parsing, Chat-Spitzen, Audio-Signale |
| `test_queue_security.py` | Job-Queue mit Checkpoints und Wiederaufnahme nach Absturz, Backoff, Verschlüsselung, Log-Schwärzung, Login-Sperre, Push-Ratenbegrenzung |
| `test_pipeline_integration.py` | synthetisches Video (testsrc + Sprache + Chat) → komplette Pipeline → Vorschau → Freigabe → Original 1080×1920 mit −14 LUFS und sichtbaren Untertiteln → Veröffentlichung (Mock-Adapter) → ZIP-Export |
| `test_claude_publish.py` | Claude-Request (JSON-Schema, Prompt-Caching, Fallback, Cache, Kosten, Ablehnung), Zeitplaner, Quota, TikTok/Instagram/YouTube gegen gemockte offizielle APIs |
| `test_twitch_mock.py` | Mock-Twitch (Helix + HLS + IRC) mit **echtem streamlink**: Live-Erkennung, Aufnahme in Segmenten, Chat-Spitze, `!clip`, Twitch-Clip als Marker, „Jetzt clippen“, Reconnect mit Lücke, Modus A am Ende |
| `frontend/tests/e2e.mjs` | iPhone-Format: Login, Kanäle, Zustimmungspflicht, Wischen in der Review, Editor, Warteschlange, kein horizontales Scrollen, Tippflächengröße |

**Architektur:**

```
Handy (PWA) ──HTTPS──> Caddy ──> api (FastAPI, liefert die App aus)
                                   │  SQLite (WAL) in /data
                     daemon ───────┤  Live-Erkennung (EventSub-Hinweise + Polling), streamlink-Aufnahme,
                                   │  Chat (IRC), Chat-Spitzen, Zeitplaner, Ordner-Import, Aufräumen
                     worker ───────┘  Job-Queue: Whisper, Analyse, Claude, Rendern, Veröffentlichen, Export
```

`backend/clipfabrik/`: `analysis/` (Audio, Chat, Signale, Zeitstrahl, Whisper), `llm/` (Claude-Client, Prompts, Heuristik), `highlights/` (Pipeline, Verpacken, Dedupe, Scoring, Lernschleife), `media/` (ffmpeg, Untertitel, Renderer), `twitch/` (Helix, EventSub, IRC, Recorder), `publish/` (Adapter, Quota, Zeitplaner, Export), `jobs/` (Queue, Worker, Handler), `api/` (REST), `daemon.py`.

---

## 10. Fehlerbehebung

| Problem | Lösung |
|---|---|
| Seite lädt nach 15 Minuten nicht | `http://<IP>` zeigt den Setup-Fortschritt bzw. den Fehler. Log: `/var/log/clipfabrik-setup.log`. In der Hetzner-App lässt sich der Server per „Rebuild“ mit derselben Cloud-Config neu aufsetzen. |
| Kein Push auf dem iPhone | App über „Zum Home-Bildschirm“ installieren, von dort öffnen, dann Einstellungen → „Push aktivieren“. In iOS → Mitteilungen die App erlauben. |
| „Daemon läuft nicht“ / „Worker läuft nicht“ | Einmal den Server in der Hetzner-App neu starten. Alle Dienste starten automatisch, unterbrochene Jobs laufen ab dem letzten Checkpoint weiter. |
| Kanal bleibt „offline“, obwohl er live ist | Twitch-Client-ID/Secret prüfen (Kanäle-Seite zeigt Hinweise). Polling läuft alle 30 s. |
| „Stream nicht aufnehmbar“ | Abo-only oder regional gesperrt. „Twitch-Clips als Marker“ und „VOD-Backup“ einschalten. |
| YouTube „Kontingent aufgebraucht“ | Normal ohne Erweiterung (rund 6 Uploads am Tag). Die App verschiebt automatisch auf den nächsten Tag. |
| Clip zu lang/kurz | Im Editor mit dem Trim-Regler oder ±1 s anpassen, dann „Neu rendern“. Zielwerte in den Einstellungen. |
| Speicher voll | Einstellungen → Speicher → „Jetzt aufräumen“, Aufbewahrung verkürzen oder ein Hetzner-Volume dazubuchen. |
