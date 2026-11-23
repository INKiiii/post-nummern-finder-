#!/usr/bin/env bash
# =============================================================================
# Clip-Fabrik – Einrichtung auf einem frischen Ubuntu-Server (22.04/24.04), als root.
# Wird von cloud-init.yaml automatisch gestartet. Manuell:  sudo bash setup.sh
#
# Optionale Variablen (sonst automatisch):
#   ADMIN_PASSWORD  Passwort für die App (sonst zufällig, steht am Ende im Log und in /root/clipfabrik-zugang.txt)
#   DOMAIN          z. B. clips.meinedomain.de (sonst <IP>.sslip.io – HTTPS ohne eigene Domain)
#   ANTHROPIC_API_KEY, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET  (können auch später in der App eingetragen werden)
#   GPU=auto|yes|no
# =============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATUS_DIR=/var/www/clipfabrik-setup
GPU="${GPU:-auto}"
log() { echo "[$(date +%H:%M:%S)] $*"; status "$*"; }

# --- Fortschrittsseite: http://<IP> zeigt während der Einrichtung den Stand (fürs Handy) ---
status() {
  mkdir -p "$STATUS_DIR"
  cat > "$STATUS_DIR/index.html" <<HTML
<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10"><title>Clip-Fabrik wird eingerichtet</title>
<body style="font-family:system-ui;background:#0b0b10;color:#eee;padding:24px;max-width:520px;margin:auto">
<h1>Clip-Fabrik wird eingerichtet …</h1><p>Das dauert etwa 10 Minuten. Diese Seite aktualisiert sich selbst.</p>
<p style="background:#1e1e28;padding:16px;border-radius:16px">Aktuell: <b>$1</b></p></body></html>
HTML
}
start_status_server() {
  status "Start"
  (cd "$STATUS_DIR" && nohup python3 -m http.server 80 >/dev/null 2>&1 & echo $! > /tmp/clipfabrik-status.pid) || true
}
stop_status_server() { [ -f /tmp/clipfabrik-status.pid ] && kill "$(cat /tmp/clipfabrik-status.pid)" 2>/dev/null || true; }
trap 'status "Fehler – Details: /var/log/clipfabrik-setup.log"' ERR

if [ "$(id -u)" -ne 0 ]; then echo "Bitte als root ausführen (sudo bash setup.sh)"; exit 1; fi
export DEBIAN_FRONTEND=noninteractive
start_status_server

log "Systempakete installieren"
apt-get update -y
apt-get install -y ca-certificates curl git openssl ufw pciutils
# Sicherheitsupdates automatisch
apt-get install -y unattended-upgrades && dpkg-reconfigure -f noninteractive unattended-upgrades || true

if ! command -v docker >/dev/null; then
  log "Docker installieren"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# Swap, falls wenig RAM (Whisper medium braucht ~3 GB)
MEM_GB=$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo)
if [ "$MEM_GB" -lt 12 ] && ! swapon --show | grep -q swapfile; then
  log "Swap anlegen (${MEM_GB} GB RAM)"
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# GPU?
COMPOSE_FILES="-f docker-compose.yml"
if [ "$GPU" = "yes" ] || { [ "$GPU" = "auto" ] && lspci | grep -qi nvidia; }; then
  log "NVIDIA-GPU gefunden: Treiber und Container-Toolkit installieren"
  if ! command -v nvidia-smi >/dev/null; then
    apt-get install -y ubuntu-drivers-common && ubuntu-drivers autoinstall || true
  fi
  if ! command -v nvidia-ctk >/dev/null; then
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
      | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
      > /etc/apt/sources.list.d/nvidia-container-toolkit.list
    apt-get update -y && apt-get install -y nvidia-container-toolkit
    nvidia-ctk runtime configure --runtime=docker && systemctl restart docker
  fi
  COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.gpu.yml"
fi

log "Konfiguration (.env) anlegen"
cd "$APP_DIR"
IP=$(curl -fsS --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')
DOMAIN="${DOMAIN:-${IP//./-}.sslip.io}"
if [ ! -f .env ]; then
  cp .env.example .env
  PW="${ADMIN_PASSWORD:-$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)}"
  sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|; s|^PUBLIC_URL=.*|PUBLIC_URL=https://${DOMAIN}|" .env
  # Werte für sed escapen (Passwörter dürfen & | \ enthalten)
  esc() { printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g'; }
  sed -i "s|^SECRET_KEY=.*|SECRET_KEY=$(openssl rand -hex 32)|; s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$(esc "$PW")|" .env
  for v in ANTHROPIC_API_KEY TWITCH_CLIENT_ID TWITCH_CLIENT_SECRET; do
    if [ -n "${!v:-}" ]; then sed -i "s|^${v}=.*|${v}=$(esc "${!v}")|" .env; fi
  done
  if [ "$COMPOSE_FILES" != "-f docker-compose.yml" ]; then
    sed -i "s|^WHISPER_MODEL=.*|WHISPER_MODEL=large-v3|; s|^WHISPER_LIVE_MODEL=.*|WHISPER_LIVE_MODEL=medium|; s|^WORKER_CONCURRENCY=.*|WORKER_CONCURRENCY=2|" .env
  fi
  chmod 600 .env
else
  PW="(unverändert – steht in $APP_DIR/.env)"
  DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2)
fi

log "Firewall: nur SSH, HTTP, HTTPS"
ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443 >/dev/null; ufw --force enable >/dev/null

log "App bauen (dauert ein paar Minuten)"
# shellcheck disable=SC2086
docker compose $COMPOSE_FILES build
stop_status_server
log "App starten"
# shellcheck disable=SC2086
docker compose $COMPOSE_FILES up -d

echo "Warte auf HTTPS-Zertifikat und App …"
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "https://${DOMAIN}/api/health" >/dev/null 2>&1; then OK=1; break; fi
  sleep 10
done

# Wöchentliches Update (Sonntag 4:30): neuen Stand holen, neu bauen.
# Liegt die Clip-Fabrik inzwischen in main, wechselt der Server automatisch dorthin
# (wichtig für Server, die vor dem Merge vom Arbeits-Branch eingerichtet wurden).
cat > /usr/local/bin/clipfabrik-update <<UPD
#!/usr/bin/env bash
set -euo pipefail
cd "$APP_DIR/.."
if git fetch --depth 1 origin main 2>/dev/null && git cat-file -e FETCH_HEAD:clip-fabrik/docker-compose.yml 2>/dev/null; then
  git checkout -q -B main FETCH_HEAD
else
  git pull --ff-only
fi
cd "$APP_DIR"
docker compose $COMPOSE_FILES up -d --build
docker image prune -f >/dev/null
UPD
chmod +x /usr/local/bin/clipfabrik-update
cat > /etc/cron.d/clipfabrik-update <<CRON
30 4 * * 0 root /usr/local/bin/clipfabrik-update >/var/log/clipfabrik-update.log 2>&1
CRON

cat > /root/clipfabrik-zugang.txt <<TXT
Clip-Fabrik ist eingerichtet.
Adresse:  https://${DOMAIN}
Passwort: ${PW}

Twitch-App (dev.twitch.tv) – OAuth-Redirect-URL:  https://${DOMAIN}/api/twitch/callback
TikTok-Redirect:     https://${DOMAIN}/api/oauth/tiktok/callback
Instagram-Redirect:  https://${DOMAIN}/api/oauth/instagram/callback
YouTube-Redirect:    https://${DOMAIN}/api/oauth/youtube/callback
TXT
chmod 600 /root/clipfabrik-zugang.txt
echo "======================================================================"
cat /root/clipfabrik-zugang.txt
[ "${OK:-0}" = 1 ] || echo "Hinweis: App antwortet noch nicht über HTTPS – in ein paar Minuten erneut versuchen."
echo "======================================================================"
