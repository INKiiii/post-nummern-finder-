"""Eine Veröffentlichung ausführen: Safety-Check, Original rendern, Quota prüfen, hochladen, Status setzen."""

from __future__ import annotations

import datetime as dt
import logging
from pathlib import Path

from .. import settings_store
from ..db import Clip, Publication, SocialAccount, session_scope, utcnow
from ..push.notify import notify
from . import quota
from .base import PublishError, UploadRequest
from .registry import adapter_for, get_tokens
from .scheduler import MAX_ATTEMPTS, retry_delay

log = logging.getLogger(__name__)


def _set(pub_id: int, **values) -> None:
    with session_scope() as s:
        p = s.get(Publication, pub_id)
        if p is not None:
            for k, v in values.items():
                setattr(p, k, v)


def run_publication(pub_id: int, ctx=None) -> str:
    from ..jobs.handlers import _render_clip, run_safety_check

    with session_scope() as s:
        pub = s.get(Publication, pub_id)
        if pub is None or pub.status != "scheduled":
            return "nicht (mehr) geplant"
        clip = s.get(Clip, pub.clip_id)
        acc = s.get(SocialAccount, pub.account_id)
        if clip.review_state != "approved":
            pub.status = "cancelled"
            pub.error = "Clip nicht freigegeben"
            return "abgebrochen"
        pub.status = "running"
        pub.attempts += 1
        attempts = pub.attempts
        platform = acc.platform
        account_meta = {"external_id": acc.external_id, "api_approved": acc.api_approved, **(acc.meta or {})}
        draft = acc.post_mode == "draft"
        privacy = acc.privacy
        q = quota.remaining(s, acc)
        acc_name = acc.name

    try:
        if q["left"] <= 0:
            raise PublishError(f"Tageslimit für {acc_name} erreicht ({q['used']}/{q['cap']})", retry=True)
        # 1) Safety-Check vor jeder Veröffentlichung
        if settings_store.get("safety_check_before_publish"):
            with session_scope() as s:
                c = s.get(Clip, clip.id)
                fresh = c.safety_checked_at and c.safety_checked_at > utcnow() - dt.timedelta(hours=24)
                override = c.safety_override
            if not fresh:
                if ctx:
                    ctx.progress(0.1, "Safety-Check")
                run_safety_check(clip.id)
            with session_scope() as s:
                c = s.get(Clip, clip.id)
                if c.safety_flagged and not c.safety_override:
                    flags = ", ".join((c.safety or {}).get("flags", [])) or "Hinweis"
                    p = s.get(Publication, pub_id)
                    p.status = "needs_safety"
                    p.error = f"Safety-Check: {flags} – ausdrückliche Freigabe nötig"
                    notify("publish_failed", "Freigabe nötig", f"„{c.title}“: {flags}", url=f"/clips/{c.id}")
                    return "Safety-Freigabe nötig"
                _ = override
        # 2) Original (1080x1920) rendern, falls noch nicht da
        with session_scope() as s:
            c = s.get(Clip, clip.id)
            video = c.render_path
            stale = c.render_status in ("stale",)
        if not video or not Path(video).exists() or stale:
            if ctx:
                ctx.progress(0.25, "Rendere Original 1080x1920")
            video = str(_render_clip(clip.id, preview=False))
        # 3) Texte
        with session_scope() as s:
            c = s.get(Clip, clip.id)
            cap = (c.captions or {}).get(platform if platform != "mock" else "youtube", {})
            title = cap.get("title") or c.title or c.hook_text or "Clip"
            if platform == "tiktok":
                desc, tags_h = cap.get("description", title), cap.get("hashtags", [])
            elif platform == "instagram":
                desc, tags_h = cap.get("caption", title), cap.get("hashtags", [])
            else:
                desc, tags_h = cap.get("description", title), []
            yt_tags = cap.get("tags", []) if platform in ("youtube", "mock") else []
        req = UploadRequest(video=Path(video), title=title, description=desc, hashtags=tags_h, tags=yt_tags, privacy=privacy, draft=draft)
        # 4) Hochladen
        if ctx:
            ctx.progress(0.5, f"Lade hoch zu {platform}")
        adapter = adapter_for(platform)
        tokens = get_tokens(pub.account_id)
        try:
            res = adapter.upload(tokens, account_meta, req)
        except PublishError as exc:
            if exc.auth:
                tokens = adapter.refresh(tokens)
                from .registry import save_tokens

                save_tokens(pub.account_id, tokens)
                res = adapter.upload(tokens, account_meta, req)
            else:
                raise
        with session_scope() as s:
            acc = s.get(SocialAccount, pub.account_id)
            quota.consume(s, acc)
            p = s.get(Publication, pub_id)
            p.status = "live" if res.status == "live" else "processing"
            p.external_id = res.external_id
            p.external_url = res.url
            p.published_at = utcnow()
            p.error = res.note or None
        log.info("Veröffentlicht: Clip %s auf %s (%s)", clip.id, platform, res.external_id)
        return f"{platform}: {res.status} {res.url or res.external_id}"
    except PublishError as exc:
        msg = str(exc)
        low = msg.lower()
        if "kontingent" in low or "tageslimit" in low or "limit erreicht" in low or "limit des kanals" in low:
            with session_scope() as s:
                acc = s.get(SocialAccount, pub.account_id)
                if "Tageslimit für" not in msg:
                    quota.mark_exhausted(s, acc)
            # auf morgen verschieben, kein Fehlversuch
            from .scheduler import replan_account

            _set(pub_id, status="scheduled", error=msg, attempts=max(0, attempts - 1),
                 scheduled_at=utcnow() + dt.timedelta(hours=12))
            replan_account(pub.account_id, now=utcnow() + dt.timedelta(hours=12))
            return f"verschoben: {msg}"
        if exc.retry and attempts < MAX_ATTEMPTS:
            delay = retry_delay(attempts)
            _set(pub_id, status="scheduled", error=f"{msg} – neuer Versuch in {delay // 60} min",
                 next_retry_at=utcnow() + dt.timedelta(seconds=delay))
            return f"Fehler, neuer Versuch in {delay}s: {msg}"
        _set(pub_id, status="failed", error=msg)
        if exc.auth:
            with session_scope() as s:
                acc = s.get(SocialAccount, pub.account_id)
                acc.status = "expired"
                acc.last_error = msg
        notify("publish_failed", "Veröffentlichung fehlgeschlagen", f"{platform}: {msg}", url="/warteschlange")
        return f"fehlgeschlagen: {msg}"
    except Exception as exc:  # noqa: BLE001 - nichts verschlucken: als Fehler mit Meldung speichern
        log.exception("Veröffentlichung %s", pub_id)
        if attempts < MAX_ATTEMPTS:
            delay = retry_delay(attempts)
            _set(pub_id, status="scheduled", error=f"{type(exc).__name__}: {exc} – neuer Versuch in {delay // 60} min",
                 next_retry_at=utcnow() + dt.timedelta(seconds=delay))
        else:
            _set(pub_id, status="failed", error=f"{type(exc).__name__}: {exc}")
            notify("publish_failed", "Veröffentlichung fehlgeschlagen", f"{platform}: {exc}", url="/warteschlange")
        raise
