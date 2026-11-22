"""Laufzeit-Einstellungen (Settings-Seite).

Reihenfolge: Standardwert < Umgebungsvariable (.env) < Wert aus der Datenbank.
Secrets werden verschlüsselt gespeichert und in der API nur maskiert ausgegeben.
"""

from __future__ import annotations

import copy
from typing import Any

from sqlalchemy.orm import Session

from . import crypto
from .config import get_settings
from .db import AppSetting, session_scope

# Schlüssel, die als Secret behandelt werden (verschlüsselt, maskiert, nie geloggt)
SECRET_KEYS = {
    "anthropic_api_key",
    "twitch_client_secret",
    "tiktok_client_secret",
    "meta_app_secret",
    "google_client_secret",
    "telegram_bot_token",
    "vapid_private_key",
    "eventsub_secret",
}

DEFAULTS: dict[str, Any] = {
    # KI
    "claude_model": "claude-sonnet-5-5",
    "claude_effort": "medium",
    "claude_fallbacks": True,
    "claude_vision": True,
    "anthropic_api_key": None,
    "budget_per_stream_usd": 3.0,
    "usd_to_eur": 0.92,
    # Preise pro Million Token (USD), für Kostenschätzung; anpassbar falls Anthropic Preise ändert
    "model_prices": {
        "claude-sonnet-5-5": {"input": 2.0, "output": 10.0, "cache_read": 0.10},
        "claude-opus-5-5": {"input": 4.0, "output": 20.0, "cache_read": 0.20},
        "claude-haiku-5-5": {"input": 0.10, "output": 0.50, "cache_read": 0.01},
    },
    # Bewertungsraster: Gewichte (Risiko wird invertiert: 10 = sehr riskant)
    "score_weights": {
        "hook": 1.5,
        "payoff": 1.4,
        "clarity": 1.0,
        "emotion": 1.2,
        "meme": 0.9,
        "risk": 0.8,
    },
    "default_min_score": 7.0,
    "default_clips_per_stream": 15,
    "push_score_threshold": 8.5,
    # Verpacken
    "clip_target_min": 10.0,
    "clip_target_max": 35.0,
    "clip_hard_min": 8.0,
    "clip_hard_max": 45.0,
    "manual_lookback": 45.0,
    "live_delay_seconds": 75.0,
    "subtitle_style": "ass",  # ass | srt
    "hook_overlay": True,
    # Aufnahme / Speicher
    "raw_retention_days": 7,
    "rejected_retention_days": 14,
    "disk_warn_percent": 15,
    "disk_stop_gb": 3,
    "delete_segments_after_assembly": True,
    # Push
    "push_events": {
        "stream_started": True,
        "stream_ended": True,
        "clips_ready": True,
        "strong_clip": True,
        "error": True,
        "publish_failed": True,
    },
    "push_min_interval_minutes": 10,
    "telegram_bot_token": None,
    "telegram_chat_id": None,
    "ntfy_url": None,
    # Veröffentlichung
    "publish_windows": [["11:00", "13:30"], ["17:00", "21:30"]],
    "publish_timezone": "Europe/Berlin",
    "youtube_daily_units": 10000,
    "youtube_upload_cost": 1600,
    "instagram_daily_limit": 50,
    "tiktok_daily_limit": 15,
    "safety_check_before_publish": True,
    # Lernschleife
    "feedback_examples": 6,
    # Twitch
    "twitch_client_id": None,
    "twitch_client_secret": None,
    "eventsub_secret": None,
    "chat_emotes": [
        "KEKW", "LUL", "LULW", "OMEGALUL", "Pog", "PogChamp", "PogU", "POGGERS", "monkaS",
        "Kappa", "PepeLaugh", "ICANT", "Sadge", "WutFace", "D:", "EZ", "Clap", "catJAM",
        "xdd", "aware", "Aware", "LMAO", "xD", "XD", "😂", "💀", "🤣",
    ],
}

# Mapping auf .env-Werte
_ENV_MAP = {
    "anthropic_api_key": "anthropic_api_key",
    "twitch_client_id": "twitch_client_id",
    "twitch_client_secret": "twitch_client_secret",
    "telegram_bot_token": "telegram_bot_token",
    "telegram_chat_id": "telegram_chat_id",
    "ntfy_url": "ntfy_url",
}


def _env_value(key: str) -> Any:
    attr = _ENV_MAP.get(key)
    if not attr:
        return None
    return getattr(get_settings(), attr, None)


def get(key: str, default: Any = None, session: Session | None = None) -> Any:
    def _read(s: Session) -> Any:
        row = s.get(AppSetting, key)
        if row is not None and row.value is not None:
            v = row.value
            if crypto.is_encrypted(v):
                return crypto.decrypt(v)
            return copy.deepcopy(v)
        env = _env_value(key)
        if env not in (None, ""):
            return env
        if key in DEFAULTS:
            return copy.deepcopy(DEFAULTS[key])
        return default

    if session is not None:
        return _read(session)
    with session_scope() as s:
        return _read(s)


def set_value(key: str, value: Any, session: Session | None = None) -> None:
    def _write(s: Session) -> None:
        stored = value
        if key in SECRET_KEYS and isinstance(value, str) and value:
            stored = crypto.encrypt(value)
        row = s.get(AppSetting, key)
        if row is None:
            s.add(AppSetting(key=key, value=stored))
        else:
            row.value = stored

    if session is not None:
        _write(session)
        return
    with session_scope() as s:
        _write(s)


def mask(value: Any) -> Any:
    if not value:
        return None
    v = str(value)
    return "••••" + v[-4:] if len(v) > 8 else "••••"


def public_settings() -> dict[str, Any]:
    """Alle Einstellungen für die Settings-Seite, Secrets maskiert."""
    out: dict[str, Any] = {}
    with session_scope() as s:
        for key in DEFAULTS:
            val = get(key, session=s)
            if key in SECRET_KEYS:
                out[key] = {"set": bool(val), "masked": mask(val)}
            else:
                out[key] = val
    return out


def update_settings(values: dict[str, Any]) -> list[str]:
    """Übernimmt erlaubte Schlüssel. Leere Secrets ändern nichts (Feld nicht ausgefüllt)."""
    changed: list[str] = []
    with session_scope() as s:
        for key, val in values.items():
            if key not in DEFAULTS:
                continue
            if key in SECRET_KEYS:
                if val in (None, ""):
                    continue
                if val == "__delete__":
                    val = None
            set_value(key, val, session=s)
            changed.append(key)
    return changed
