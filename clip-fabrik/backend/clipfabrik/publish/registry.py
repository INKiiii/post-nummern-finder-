"""Adapter-Registry und Token-Handling pro Konto."""

from __future__ import annotations

import datetime as dt
import logging

from .. import crypto
from ..config import get_settings
from ..db import SocialAccount, session_scope, utcnow
from .base import PlatformAdapter, PublishError, TokenBundle
from .instagram import InstagramAdapter
from .mock import MockAdapter
from .tiktok import TikTokAdapter
from .youtube import YouTubeAdapter

log = logging.getLogger(__name__)

PLATFORMS = ("tiktok", "instagram", "youtube")


def adapter_for(platform: str) -> PlatformAdapter:
    if platform == "tiktok":
        return TikTokAdapter()
    if platform == "instagram":
        return InstagramAdapter()
    if platform == "youtube":
        return YouTubeAdapter()
    if platform == "mock" and (get_settings().enable_mock_publisher or get_settings().fake_ai):
        return MockAdapter()
    raise PublishError(f"Unbekannte Plattform {platform}", retry=False)


def available_platforms() -> list[str]:
    out = list(PLATFORMS)
    if get_settings().enable_mock_publisher or get_settings().fake_ai:
        out.append("mock")
    return out


def get_tokens(account_id: int) -> TokenBundle:
    """Tokens eines Kontos, bei Bedarf automatisch erneuert (Token-Refresh)."""
    with session_scope() as s:
        acc = s.get(SocialAccount, account_id)
        if acc is None or not acc.tokens_enc:
            raise PublishError("Konto nicht verbunden", retry=False, auth=True)
        tokens = TokenBundle.from_json(crypto.decrypt_json(acc.tokens_enc))
        platform = acc.platform
    if tokens.expires_at and tokens.expires_at < utcnow() + dt.timedelta(minutes=10):
        try:
            tokens = adapter_for(platform).refresh(tokens)
        except PublishError:
            with session_scope() as s:
                acc = s.get(SocialAccount, account_id)
                acc.status = "expired"
                acc.last_error = "Anmeldung abgelaufen – bitte neu verbinden"
            raise
        save_tokens(account_id, tokens)
    return tokens


def save_tokens(account_id: int, tokens: TokenBundle) -> None:
    with session_scope() as s:
        acc = s.get(SocialAccount, account_id)
        acc.tokens_enc = crypto.encrypt_json(tokens.to_json())
        acc.token_expires_at = tokens.expires_at
        acc.status = "connected"
        acc.last_error = None
