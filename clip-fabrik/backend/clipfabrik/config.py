"""Konfiguration aus Umgebungsvariablen (.env).

Alles, was zur Laufzeit in der Settings-Seite geändert werden kann, liegt zusätzlich in der
Datenbank (siehe ``settings_store``). Diese Klasse enthält nur Start-Konfiguration und
Standardwerte.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Grundlegendes
    data_dir: Path = Field(default=Path("./data"), alias="DATA_DIR")
    database_url: str | None = Field(default=None, alias="DATABASE_URL")
    secret_key: str = Field(default="", alias="SECRET_KEY")
    admin_password: str | None = Field(default=None, alias="ADMIN_PASSWORD")
    public_url: str = Field(default="http://localhost:8000", alias="PUBLIC_URL")
    frontend_dist: Path | None = Field(default=None, alias="FRONTEND_DIST")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    cookie_secure: bool | None = Field(default=None, alias="COOKIE_SECURE")
    timezone: str = Field(default="Europe/Berlin", alias="TZ")

    # Twitch
    twitch_client_id: str | None = Field(default=None, alias="TWITCH_CLIENT_ID")
    twitch_client_secret: str | None = Field(default=None, alias="TWITCH_CLIENT_SECRET")
    twitch_api_base: str = Field(default="https://api.twitch.tv/helix", alias="TWITCH_API_BASE")
    twitch_auth_base: str = Field(default="https://id.twitch.tv/oauth2", alias="TWITCH_AUTH_BASE")
    twitch_irc_url: str = Field(default="wss://irc-ws.chat.twitch.tv:443", alias="TWITCH_IRC_URL")
    twitch_stream_url_template: str = Field(
        default="https://www.twitch.tv/{login}", alias="TWITCH_STREAM_URL_TEMPLATE"
    )
    twitch_poll_interval: float = Field(default=30.0, alias="TWITCH_POLL_INTERVAL")
    segment_seconds: int = Field(default=120, alias="SEGMENT_SECONDS")

    # KI
    anthropic_api_key: str | None = Field(default=None, alias="ANTHROPIC_API_KEY")
    whisper_model: str = Field(default="medium", alias="WHISPER_MODEL")
    whisper_live_model: str = Field(default="small", alias="WHISPER_LIVE_MODEL")
    whisper_device: str = Field(default="auto", alias="WHISPER_DEVICE")
    whisper_compute_type: str = Field(default="auto", alias="WHISPER_COMPUTE_TYPE")
    fake_ai: bool = Field(default=False, alias="CLIPFABRIK_FAKE_AI")

    # Push
    vapid_subject: str = Field(default="mailto:admin@example.com", alias="VAPID_SUBJECT")
    telegram_bot_token: str | None = Field(default=None, alias="TELEGRAM_BOT_TOKEN")
    telegram_chat_id: str | None = Field(default=None, alias="TELEGRAM_CHAT_ID")
    ntfy_url: str | None = Field(default=None, alias="NTFY_URL")

    # Plattformen
    tiktok_client_key: str | None = Field(default=None, alias="TIKTOK_CLIENT_KEY")
    tiktok_client_secret: str | None = Field(default=None, alias="TIKTOK_CLIENT_SECRET")
    meta_app_id: str | None = Field(default=None, alias="META_APP_ID")
    meta_app_secret: str | None = Field(default=None, alias="META_APP_SECRET")
    google_client_id: str | None = Field(default=None, alias="GOOGLE_CLIENT_ID")
    google_client_secret: str | None = Field(default=None, alias="GOOGLE_CLIENT_SECRET")
    tiktok_api_base: str = Field(default="https://open.tiktokapis.com", alias="TIKTOK_API_BASE")
    instagram_graph_base: str = Field(default="https://graph.instagram.com", alias="INSTAGRAM_GRAPH_BASE")
    instagram_upload_base: str = Field(default="https://rupload.facebook.com", alias="INSTAGRAM_UPLOAD_BASE")
    instagram_api_version: str = Field(default="v23.0", alias="INSTAGRAM_API_VERSION")
    youtube_api_base: str = Field(default="https://www.googleapis.com", alias="YOUTUBE_API_BASE")
    enable_mock_publisher: bool = Field(default=False, alias="ENABLE_MOCK_PUBLISHER")

    # Worker
    worker_concurrency: int = Field(default=1, alias="WORKER_CONCURRENCY")

    @property
    def db_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite:///{(self.data_dir / 'clipfabrik.db').resolve()}"

    @property
    def secure_cookies(self) -> bool:
        if self.cookie_secure is not None:
            return self.cookie_secure
        return self.public_url.startswith("https://")

    # Verzeichnisse
    @property
    def streams_dir(self) -> Path:
        return self.data_dir / "streams"

    @property
    def clips_dir(self) -> Path:
        return self.data_dir / "clips"

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def inbox_dir(self) -> Path:
        return self.data_dir / "inbox"

    @property
    def exports_dir(self) -> Path:
        return self.data_dir / "exports"

    def ensure_dirs(self) -> None:
        for d in (
            self.data_dir,
            self.streams_dir,
            self.clips_dir,
            self.cache_dir,
            self.uploads_dir,
            self.inbox_dir,
            self.exports_dir,
        ):
            d.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    s = Settings()
    if not s.secret_key:
        # Für Tests/Entwicklung: stabiler Schlüssel pro Datenverzeichnis, nie im Produktivbetrieb.
        key_file = s.data_dir / ".dev_secret_key"
        s.data_dir.mkdir(parents=True, exist_ok=True)
        if key_file.exists():
            s.secret_key = key_file.read_text().strip()
        else:
            s.secret_key = os.urandom(32).hex()
            key_file.write_text(s.secret_key)
            key_file.chmod(0o600)
    s.ensure_dirs()
    return s


def reset_settings_cache() -> None:
    get_settings.cache_clear()
