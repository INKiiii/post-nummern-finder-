"""EventSub-Webhook: Signaturprüfung, Challenge, stream.online/offline -> Live-Hinweis am Kanal."""

from __future__ import annotations

import collections
import datetime as dt
import hashlib
import hmac
import logging
import secrets
import threading

from sqlalchemy import select

from .. import settings_store
from ..db import Channel, session_scope, utcnow

log = logging.getLogger(__name__)

MAX_AGE = dt.timedelta(minutes=10)
_seen_lock = threading.Lock()
_seen: collections.OrderedDict[str, None] = collections.OrderedDict()


def eventsub_secret() -> str:
    sec = settings_store.get("eventsub_secret")
    if not sec:
        sec = secrets.token_hex(24)
        settings_store.set_value("eventsub_secret", sec)
    return sec


def verify_signature(secret: str, msg_id: str, timestamp: str, body: bytes, signature: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), msg_id.encode() + timestamp.encode() + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature or "")


def timestamp_fresh(timestamp: str, now: dt.datetime | None = None) -> bool:
    try:
        ts = dt.datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(dt.UTC).replace(tzinfo=None)
    except ValueError:
        return False
    now = now or utcnow()
    return abs(now - ts) <= MAX_AGE


def is_duplicate(msg_id: str) -> bool:
    with _seen_lock:
        if msg_id in _seen:
            return True
        _seen[msg_id] = None
        while len(_seen) > 2000:
            _seen.popitem(last=False)
        return False


def handle_notification(sub_type: str, event: dict) -> str:
    broadcaster = event.get("broadcaster_user_id")
    login = (event.get("broadcaster_user_login") or "").lower()
    hint = {"stream.online": "online", "stream.offline": "offline"}.get(sub_type)
    if hint is None:
        return "ignoriert"
    with session_scope() as s:
        ch = s.scalar(select(Channel).where((Channel.twitch_user_id == broadcaster) | (Channel.login == login)))
        if ch is None:
            return "unbekannter Kanal"
        ch.live_hint = hint
        ch.live_hint_at = utcnow()
    log.info("EventSub: %s ist %s", login or broadcaster, hint)
    return hint
