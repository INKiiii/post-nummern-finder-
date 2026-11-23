"""Push-Pop-ups: Web-Push (PWA, VAPID), Telegram und ntfy als Fallback.

Pro Ereignis abschaltbar (Settings → Push). „Starker Clip“ hat eine Ratenbegrenzung
(Standard: höchstens 1 Push alle 10 Minuten); unterdrückte Pushes werden protokolliert und
am Stream-Ende in der Zusammenfassung erwähnt.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
from typing import Any

import httpx
from sqlalchemy import select

from .. import crypto, settings_store
from ..config import get_settings
from ..db import NotificationLog, PushSubscription, session_scope, utcnow

log = logging.getLogger(__name__)

EVENTS = {
    "stream_started": "Stream gestartet",
    "stream_ended": "Stream beendet",
    "clips_ready": "Neue Clips bereit",
    "strong_clip": "Starker Clip (Live)",
    "error": "Fehler",
    "publish_failed": "Veröffentlichung fehlgeschlagen",
}
RATE_LIMITED = {"strong_clip"}


def vapid_keys() -> tuple[str, str]:
    """(öffentlicher Schlüssel base64url, privater PEM). Wird beim ersten Aufruf erzeugt."""
    pub = settings_store.get("vapid_public_key")
    priv = settings_store.get("vapid_private_key")
    if pub and priv:
        return pub, priv
    import base64

    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid

    v = Vapid()
    v.generate_keys()
    raw_pub = v.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    pub = base64.urlsafe_b64encode(raw_pub).decode().rstrip("=")
    priv = v.private_pem().decode()
    settings_store.set_value("vapid_public_key", pub)
    settings_store.set_value("vapid_private_key", priv)
    log.info("VAPID-Schlüssel erzeugt")
    return pub, priv


def _rate_limited(event: str) -> bool:
    if event not in RATE_LIMITED:
        return False
    minutes = float(settings_store.get("push_min_interval_minutes") or 10)
    since = utcnow() - dt.timedelta(minutes=minutes)
    with session_scope() as s:
        last = s.scalar(
            select(NotificationLog).where(NotificationLog.event == event, NotificationLog.suppressed.is_(False),
                                          NotificationLog.created_at >= since).limit(1)
        )
    return last is not None


def notify(event: str, title: str, body: str = "", *, url: str = "/", stream_id: int | None = None,
           tag: str | None = None, force: bool = False) -> dict[str, Any]:
    """Schickt eine Benachrichtigung über alle eingerichteten Kanäle. Wirft nie (Fehler werden geloggt)."""
    enabled = settings_store.get("push_events") or {}
    if not force and not enabled.get(event, True):
        return {"skipped": "deaktiviert"}
    suppressed = not force and _rate_limited(event)
    entry_id = None
    with session_scope() as s:
        entry = NotificationLog(event=event, title=title, body=body, url=url, suppressed=suppressed, stream_id=stream_id)
        s.add(entry)
        s.flush()
        entry_id = entry.id
    if suppressed:
        log.info("Push „%s“ unterdrückt (Ratenbegrenzung)", title)
        return {"suppressed": True}
    delivered: dict[str, Any] = {}
    payload = {"title": title, "body": body, "url": url, "tag": tag or event, "event": event}
    try:
        delivered["webpush"] = _send_webpush(payload)
    except Exception as exc:  # noqa: BLE001
        log.error("Web-Push fehlgeschlagen: %s", exc)
        delivered["webpush"] = f"Fehler: {exc}"
    try:
        delivered["telegram"] = _send_telegram(title, body, url)
    except Exception as exc:  # noqa: BLE001
        log.error("Telegram fehlgeschlagen: %s", exc)
        delivered["telegram"] = f"Fehler: {exc}"
    try:
        delivered["ntfy"] = _send_ntfy(title, body, url)
    except Exception as exc:  # noqa: BLE001
        log.error("ntfy fehlgeschlagen: %s", exc)
        delivered["ntfy"] = f"Fehler: {exc}"
    with session_scope() as s:
        e = s.get(NotificationLog, entry_id)
        if e is not None:
            e.delivered = delivered
    return delivered


def _abs_url(url: str) -> str:
    return url if url.startswith("http") else get_settings().public_url.rstrip("/") + url


def _send_webpush(payload: dict) -> int:
    with session_scope() as s:
        subs = [(x.id, x.endpoint, x.keys) for x in s.scalars(select(PushSubscription)).all()]
    if not subs:
        return 0
    from pywebpush import WebPushException, webpush

    _pub, priv = vapid_keys()
    sent = 0
    for sid, endpoint, keys in subs:
        try:
            webpush(
                subscription_info={"endpoint": endpoint, "keys": keys},
                data=json.dumps(payload),
                vapid_private_key=priv,
                vapid_claims={"sub": get_settings().vapid_subject},
                ttl=3600,
            )
            sent += 1
        except WebPushException as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status in (404, 410):
                with session_scope() as s:
                    sub = s.get(PushSubscription, sid)
                    if sub is not None:
                        s.delete(sub)
                log.info("Abgelaufenes Push-Abo entfernt")
            else:
                log.error("Web-Push an Abo %s fehlgeschlagen: %s", sid, exc)
    return sent


def _send_telegram(title: str, body: str, url: str) -> bool | None:
    token = settings_store.get("telegram_bot_token")
    chat = settings_store.get("telegram_chat_id")
    if not token or not chat:
        return None
    r = httpx.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={"chat_id": chat, "text": f"*{title}*\n{body}\n{_abs_url(url)}", "parse_mode": "Markdown", "disable_web_page_preview": True},
        timeout=15,
    )
    r.raise_for_status()
    return True


def _send_ntfy(title: str, body: str, url: str) -> bool | None:
    target = settings_store.get("ntfy_url")
    if not target:
        return None
    r = httpx.post(
        target,
        content=(body or title).encode(),
        headers={"Title": title.encode("utf-8").decode("latin-1", "replace"), "Click": _abs_url(url), "Tags": "clapper"},
        timeout=15,
    )
    r.raise_for_status()
    return True


def suppressed_since(stream_id: int, since: dt.datetime) -> int:
    with session_scope() as s:
        return len(s.scalars(select(NotificationLog.id).where(
            NotificationLog.stream_id == stream_id, NotificationLog.suppressed.is_(True), NotificationLog.created_at >= since)).all())


__all__ = ["notify", "vapid_keys", "EVENTS", "crypto"]
