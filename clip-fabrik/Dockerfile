# Clip-Fabrik – CPU-Variante (Modus A mit faster-whisper medium, Live-Modus mit small)
# Stufe 1: Frontend bauen
FROM node:22-bookworm-slim AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# Stufe 2: Laufzeit – Ubuntu 24.04: ffmpeg 6.1 + libass wie in den Render-Tests, Python 3.12
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    DATA_DIR=/data FRONTEND_DIST=/app/frontend/dist HF_HOME=/data/models TZ=Europe/Berlin
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg fonts-dejavu-core fonts-inter tini curl ca-certificates tzdata \
 && python3 -m venv /opt/venv && rm -rf /var/lib/apt/lists/*
ENV PATH=/opt/venv/bin:$PATH
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install -r requirements.txt
COPY backend/ ./
RUN pip install --no-deps -e .
COPY --from=frontend /src/dist /app/frontend/dist
RUN useradd -m -u 1001 clip && mkdir -p /data && chown -R clip /data
USER clip
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fs http://localhost:8000/api/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["clipfabrik", "api"]
