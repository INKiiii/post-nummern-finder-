# Clip-Fabrik – Plan, Meilensteine, Risiken

## Meilensteine

| Phase | Inhalt | Abnahme |
|---|---|---|
| **1a Fundament** | FastAPI, SQLite (SQLAlchemy), eigene SQLite-Job-Queue mit Checkpoints/Heartbeat (wiederaufnehmbar), Login (ein Nutzer, Argon2, signiertes Cookie), verschlüsselte Secrets, Log-Schwärzung | Unit-Tests Queue, Crypto, Auth |
| **1b Medien** | ffmpeg-Modul (Audio, Lautheit, Stille, Schnitt), ASS-Untertitel Wort für Wort mit PlayRes 1080x1920, SRT-Fallback mit libass-288-Werten (FontSize 11 / MarginV 45), Renderer (Blur-Hintergrund, Facecam-Layout, loudnorm, NVENC/x264, 540p-Vorschau) | Frame-Render-Test: Untertitel sichtbar, Größe und Lage plausibel |
| **1c Analyse + Auswahl** | faster-whisper mit Wort-Zeitstempeln und Cache, Lautstärke/Stille/Lach-Heuristik, Chat-Metriken, Signal-Vorfilter, Claude-Durchläufe (Kandidaten → Raster-Bewertung → Gesamt-Ranking), harte Ausschlüsse, Verpacken, Dedupe/Vielfalt, Quote, Plattform-Texte | Integrationstest: synthetisches Video → gerenderter Clip |
| **1d Twitch** | Kanal anlegen mit Zustimmung, Helix-Client, EventSub-Webhook + Polling-Fallback, streamlink-Aufnahme in Segmenten mit Reconnect und Lückenmarkierung, Modus A nach Stream-Ende, Push (Web-Push/VAPID, Telegram, ntfy) | Mock-Twitch-Server (Helix + HLS + IRC) mit echtem streamlink |
| **1e Oberfläche** | React/Vite/Tailwind-PWA, Kanäle, Karten-Review mit Wischgesten, Editor (Trim, Untertitel, Texte, Neu-Rendern), Archiv, Upload (tus), Fallback-Export | Playwright-Test im Handyformat |
| **2 Live + Veröffentlichung** | Modus B (Chat-Spikes, rollender Puffer, „Jetzt clippen“, `!clip`, Twitch-Clip als Marker), Adapter TikTok/Instagram/YouTube + Mock, Quota-Tracker, Zeitplaner mit Fenstern/Versatz/Backoff, mehrere Konten, Einladungslinks | respx-gemockte Plattform-Tests, Scheduler-Tests |
| **3 Auswertung** | Metriken holen, Dashboard Top/Flop, Lernschleife (Freigaben/Ablehnungen/Views als Beispiele im Prompt) | Unit-Tests Feedback-Auswahl |
| **Betrieb** | Docker Compose (CPU/GPU), Caddy-HTTPS, Cloud-Init für Hetzner, Einrichtungsskript, README, Kostenschätzung | `docker compose config`, Skript-Lint |

## Risiken und Gegenmaßnahmen

| Risiko | Wirkung | Gegenmaßnahme |
|---|---|---|
| TikTok-Audit fehlt | Posts nur privat (SELF_ONLY) | Inbox-/Entwurfs-Upload, Fallback-Export mit captions.csv, Teilen-Knopf |
| Instagram-App-Prüfung / Business-Konto | Kein API-Posting | Fallback-Export, klare Anzeige im Quota-Tracker |
| YouTube-Kontingent (10.000 Einheiten/Tag) | wenige Uploads/Tag | Quota-Tracker mit einstellbaren Kosten, Antrag auf Erweiterung |
| Abo-only-Streams, Werbepausen | Aufnahme lückenhaft | Lücken markieren, VOD-Backup, Twitch-Clips als Marker, Push „nicht aufnehmbar“ |
| CPU-Server zu langsam für Live-Modus | Verzögerung > 90 s | GPU-Variante, kleineres Whisper-Modell für Live, Modus A als Fallback |
| Claude-Kosten bei 8-h-Streams | Budget | Signal-Vorfilter (nur Kandidatenfenster gehen an Claude), Prompt-Caching, Ergebnis-Cache, Kostenschätzung + Budget-Grenze pro Stream |
| Rechtliches (Urheberrecht, Persönlichkeitsrechte) | Sperrungen | harte Ausschlüsse, Safety-Check vor jeder Veröffentlichung, nur Kanäle mit Zustimmung |
| Twitch-IRC wird langfristig von EventSub-Chat abgelöst | Chat-Signal fällt aus | Chat-Client hinter Interface, EventSub-Chat nachrüstbar |

## Stand nach Phase 1–3

Alle drei Phasen sind umgesetzt und getestet (75 Backend-Tests, Oberflächen-Test im Handyformat, Docker-Build
mit Container-Smoke-Test). Details und offene Punkte: README, Kapitel 8 („Grenzen“).

## Grenzen der Entwicklungsumgebung (ehrlich)

- Twitch, HuggingFace (Whisper-Modelle) und die Social-APIs waren in der Entwicklungs-Sandbox nicht erreichbar,
  und es gab keinen Anthropic-Key für die App. Getestet wurde deshalb mit Mock-Twitch-Server (echter streamlink über
  HLS), gemockten Plattform-APIs und einem deterministischen Heuristik-Modell statt Claude. Der Test mit einem
  echten Kanal und echter Whisper-/Claude-Auswahl passiert beim ersten Stream auf deinem Server.
- `stream_clipper.py` lag nicht im Projektordner; das Modul wurde nach der Beschreibung neu gebaut.
