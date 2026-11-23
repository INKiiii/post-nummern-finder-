"""Konten (OAuth), Einladungslinks, Warteschlange, Quota, Export, Twitch-Login und EventSub."""

from __future__ import annotations

import datetime as dt
import json
import logging
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from .. import auth, crypto
from ..config import get_settings
from ..db import Channel, Invite, Job, OAuthState, Publication, SocialAccount, session_scope, utcnow
from ..jobs import queue
from ..publish import quota as quota_mod
from ..publish.base import PublishError
from ..publish.registry import PLATFORMS, adapter_for, available_platforms
from ..publish.scheduler import reorder, replan_account
from ..twitch import eventsub
from ..twitch.helix import MOD_SCOPES, STREAMER_SCOPES, Helix, TwitchError, store_user_tokens
from .serialize import account_out, pub_out

log = logging.getLogger(__name__)
public = APIRouter(prefix="/api")
router = APIRouter(prefix="/api", dependencies=[Depends(auth.require_login)])

DEFAULT_LIMITS = {"tiktok": 3, "instagram": 3, "youtube": 3, "mock": 10}


def _base() -> str:
    return get_settings().public_url.rstrip("/")


def _new_state(platform: str, purpose: str, data: dict | None = None) -> str:
    st = secrets.token_urlsafe(24)
    with session_scope() as s:
        s.add(OAuthState(state=st, platform=platform, purpose=purpose, data=data or {}))
        # alte States aufräumen
        s.query(OAuthState).filter(OAuthState.created_at < utcnow() - dt.timedelta(hours=2)).delete()
    return st


def _pop_state(state: str, platform: str) -> OAuthState:
    with session_scope() as s:
        row = s.get(OAuthState, state)
        if row is None or row.platform != platform or row.created_at < utcnow() - dt.timedelta(hours=2):
            raise HTTPException(400, "Login-Vorgang abgelaufen oder ungültig – bitte neu starten")
        s.delete(row)
        s.expunge(row)
        return row


# ------------------------------------------------------------------ Konten
@router.get("/accounts")
def list_accounts() -> dict:
    with session_scope() as s:
        accounts = s.scalars(select(SocialAccount).order_by(SocialAccount.platform, SocialAccount.id)).all()
        out = []
        for a in accounts:
            try:
                q = quota_mod.remaining(s, a)
            except PublishError:
                q = None
            out.append(account_out(a, q))
    platforms = []
    for p in available_platforms():
        ad = adapter_for(p)
        platforms.append({"platform": p, "label": ad.label, "configured": ad.configured(), "hint": ad.approval_hint()})
    return {"accounts": out, "platforms": platforms}


@router.post("/accounts/connect/{platform}")
def connect(platform: str) -> dict:
    ad = adapter_for(platform)
    if not ad.configured():
        raise HTTPException(400, f"{ad.label}: App-Zugangsdaten fehlen (siehe README → API-Freigaben)")
    state = _new_state(platform, "account", {"owner": "me"})
    return {"url": ad.authorize_url(f"{_base()}/api/oauth/{platform}/callback", state)}


@public.get("/oauth/{platform}/callback")
def oauth_callback(platform: str, code: str | None = None, state: str | None = None, error: str | None = None,
                   error_description: str | None = None):
    if error:
        return RedirectResponse(f"/konten?fehler={error_description or error}")
    if not code or not state:
        raise HTTPException(400, "Code fehlt")
    st = _pop_state(state, platform)
    ad = adapter_for(platform)
    try:
        tokens = ad.exchange_code(code, f"{_base()}/api/oauth/{platform}/callback")
        ident = ad.identity(tokens)
    except PublishError as exc:
        target = "/einladung/fertig?fehler=" if st.purpose == "invite" else "/konten?fehler="
        return RedirectResponse(target + str(exc))
    with session_scope() as s:
        acc = s.scalar(select(SocialAccount).where(SocialAccount.platform == platform, SocialAccount.external_id == ident.external_id))
        if acc is None:
            acc = SocialAccount(platform=platform, external_id=ident.external_id, daily_limit=DEFAULT_LIMITS.get(platform, 3))
            s.add(acc)
        acc.name = ident.name
        acc.owner = "streamer" if st.purpose == "invite" else "me"
        acc.meta = {**(acc.meta or {}), **ident.meta}
        acc.tokens_enc = crypto.encrypt_json(tokens.to_json())
        acc.token_expires_at = tokens.expires_at
        acc.scopes = tokens.scopes
        acc.status = "connected"
        acc.last_error = None
        s.flush()
        acc_id = acc.id
        if st.purpose == "invite" and st.data.get("invite"):
            inv = s.scalar(select(Invite).where(Invite.token == st.data["invite"]))
            if inv:
                inv.used_at = utcnow()
                inv.account_id = acc_id
    if st.purpose == "invite":
        return RedirectResponse(f"/einladung/fertig?plattform={platform}")
    return RedirectResponse(f"/konten?verbunden={platform}")


class AccountPatch(BaseModel):
    name: str | None = None
    daily_limit: int | None = Field(default=None, ge=0, le=100)
    api_approved: bool | None = None
    post_mode: str | None = None
    privacy: str | None = None
    windows: list[list[str]] | None = None
    min_gap_minutes: int | None = Field(default=None, ge=5, le=1440)
    jitter_minutes: int | None = Field(default=None, ge=0, le=120)
    enabled: bool | None = None


@router.patch("/accounts/{aid}")
def patch_account(aid: int, body: AccountPatch) -> dict:
    with session_scope() as s:
        a = s.get(SocialAccount, aid)
        if a is None:
            raise HTTPException(404, "Konto nicht gefunden")
        for k, v in body.model_dump(exclude_unset=True).items():
            if k == "post_mode" and v not in ("direct", "draft"):
                raise HTTPException(400, "post_mode: direct oder draft")
            setattr(a, k, v)
    replan_account(aid)
    with session_scope() as s:
        a = s.get(SocialAccount, aid)
        return account_out(a, quota_mod.remaining(s, a))


@router.delete("/accounts/{aid}")
def delete_account(aid: int) -> dict:
    with session_scope() as s:
        a = s.get(SocialAccount, aid)
        if a is None:
            raise HTTPException(404, "Konto nicht gefunden")
        for p in s.scalars(select(Publication).where(Publication.account_id == aid, Publication.status == "scheduled")).all():
            p.status = "cancelled"
        a.enabled = False
        a.tokens_enc = None
        a.status = "disconnected"
    return {"ok": True}


# ------------------------------------------------------------------ Einladungen (Streamer bestätigt am Handy)
class InviteIn(BaseModel):
    platform: str
    channel_id: int | None = None
    note: str = ""


@router.post("/invites")
def create_invite(body: InviteIn) -> dict:
    if body.platform not in (*PLATFORMS, "twitch", "mock"):
        raise HTTPException(400, "Plattform unbekannt")
    with session_scope() as s:
        inv = Invite(token=secrets.token_urlsafe(24), platform=body.platform, channel_id=body.channel_id, note=body.note[:200],
                     expires_at=utcnow() + dt.timedelta(days=7))
        s.add(inv)
        token = inv.token
    return {"url": f"{_base()}/einladung/{token}", "expires_days": 7}


@public.get("/invites/{token}")
def invite_info(token: str) -> dict:
    with session_scope() as s:
        inv = s.scalar(select(Invite).where(Invite.token == token))
        if inv is None or inv.expires_at < utcnow():
            raise HTTPException(404, "Einladung ungültig oder abgelaufen")
        ch = s.get(Channel, inv.channel_id) if inv.channel_id else None
        labels = {"tiktok": "TikTok", "instagram": "Instagram", "youtube": "YouTube", "twitch": "Twitch", "mock": "Test"}
        return {"platform": inv.platform, "label": labels.get(inv.platform, inv.platform), "used": inv.used_at is not None,
                "channel": (ch.display_name or ch.login) if ch else None, "note": inv.note,
                "expires_at": inv.expires_at.isoformat() + "Z"}


@public.get("/invites/{token}/start")
def invite_start(token: str):
    with session_scope() as s:
        inv = s.scalar(select(Invite).where(Invite.token == token))
        if inv is None or inv.expires_at < utcnow():
            raise HTTPException(404, "Einladung ungültig oder abgelaufen")
        platform, channel_id = inv.platform, inv.channel_id
    if platform == "twitch":
        helix = Helix()
        if not helix.configured:
            raise HTTPException(400, "Twitch-App nicht eingerichtet")
        state = _new_state("twitch", "streamer", {"invite": token, "channel_id": channel_id})
        return RedirectResponse(helix.authorize_url(f"{_base()}/api/twitch/callback", STREAMER_SCOPES, state))
    ad = adapter_for(platform)
    state = _new_state(platform, "invite", {"invite": token})
    return RedirectResponse(ad.authorize_url(f"{_base()}/api/oauth/{platform}/callback", state))


# ------------------------------------------------------------------ Twitch-Login (Mod-Konto) und EventSub
@router.get("/twitch/login")
def twitch_login() -> dict:
    helix = Helix()
    if not helix.configured:
        raise HTTPException(400, "Twitch Client-ID/Secret fehlen (Einstellungen → Twitch)")
    state = _new_state("twitch", "login")
    return {"url": helix.authorize_url(f"{_base()}/api/twitch/callback", MOD_SCOPES, state)}


@public.get("/twitch/callback")
def twitch_callback(code: str | None = None, state: str | None = None, error: str | None = None, error_description: str | None = None):
    if error or not code or not state:
        return RedirectResponse(f"/konten?fehler={error_description or error or 'Twitch-Login abgebrochen'}")
    st = _pop_state(state, "twitch")
    helix = Helix()
    try:
        tokens = helix.exchange_code(code, f"{_base()}/api/twitch/callback")
        info = helix.validate(tokens["access_token"])
    except TwitchError as exc:
        return RedirectResponse(f"/konten?fehler={exc}")
    if st.purpose == "streamer":
        with session_scope() as s:
            ch = s.get(Channel, st.data.get("channel_id")) if st.data.get("channel_id") else None
            ok = ch is not None and (ch.twitch_user_id == info.get("user_id") or ch.login == info.get("login", "").lower())
            if ok:
                ch.streamer_authorized = True
                ch.consent_note = (ch.consent_note + f" | Twitch-Login des Streamers am {utcnow():%d.%m.%Y}").strip(" |")
            inv = s.scalar(select(Invite).where(Invite.token == st.data.get("invite")))
            if inv:
                inv.used_at = utcnow()
        if not ok:
            return RedirectResponse("/einladung/fertig?fehler=Das Twitch-Konto gehört nicht zu diesem Kanal")
        return RedirectResponse("/einladung/fertig?plattform=twitch")
    missing = [sc for sc in MOD_SCOPES if sc not in info.get("scopes", [])]
    store_user_tokens(tokens, info, "mod")
    if missing:
        return RedirectResponse(f"/konten?twitch=ok&fehlt={','.join(missing)}")
    return RedirectResponse("/konten?twitch=ok")


@router.delete("/twitch/login")
def twitch_logout() -> dict:
    from ..db import TwitchAccount

    with session_scope() as s:
        for a in s.scalars(select(TwitchAccount).where(TwitchAccount.role == "mod")).all():
            s.delete(a)
    return {"ok": True}


@public.post("/twitch/eventsub")
async def eventsub_webhook(request: Request):
    body = await request.body()
    h = request.headers
    msg_id = h.get("Twitch-Eventsub-Message-Id", "")
    ts = h.get("Twitch-Eventsub-Message-Timestamp", "")
    sig = h.get("Twitch-Eventsub-Message-Signature", "")
    if not eventsub.verify_signature(eventsub.eventsub_secret(), msg_id, ts, body, sig):
        raise HTTPException(403, "Signatur ungültig")
    if not eventsub.timestamp_fresh(ts):
        raise HTTPException(403, "Nachricht zu alt")
    if eventsub.is_duplicate(msg_id):
        return PlainTextResponse("", status_code=204)
    data = json.loads(body or b"{}")
    mtype = h.get("Twitch-Eventsub-Message-Type", "")
    if mtype == "webhook_callback_verification":
        return PlainTextResponse(data.get("challenge", ""), media_type="text/plain")
    if mtype == "revocation":
        log.warning("EventSub widerrufen: %s", data.get("subscription", {}).get("status"))
        with session_scope() as s:
            uid = data.get("subscription", {}).get("condition", {}).get("broadcaster_user_id")
            ch = s.scalar(select(Channel).where(Channel.twitch_user_id == uid))
            if ch:
                ch.eventsub_ids = []
        return PlainTextResponse("", status_code=204)
    if mtype == "notification":
        eventsub.handle_notification(data.get("subscription", {}).get("type", ""), data.get("event", {}))
    return PlainTextResponse("", status_code=204)


# ------------------------------------------------------------------ Warteschlange
@router.get("/queue")
def get_queue() -> dict:
    with session_scope() as s:
        active = s.scalars(select(Publication).where(Publication.status.in_(("scheduled", "running", "processing", "needs_safety")))
                           .order_by(Publication.scheduled_at.asc().nullslast(), Publication.position)).all()
        recent = s.scalars(select(Publication).where(Publication.status.in_(("live", "failed", "cancelled")))
                           .order_by(Publication.id.desc()).limit(40)).all()
        accounts = s.scalars(select(SocialAccount).where(SocialAccount.enabled.is_(True))).all()
        quotas = []
        for a in accounts:
            try:
                quotas.append(quota_mod.remaining(s, a))
            except PublishError:
                continue
        return {"active": [pub_out(p) for p in active], "recent": [pub_out(p) for p in recent], "quotas": quotas}


class ReorderIn(BaseModel):
    account_id: int
    publication_ids: list[int]


@router.post("/queue/reorder")
def queue_reorder(body: ReorderIn) -> dict:
    reorder(body.account_id, body.publication_ids)
    return get_queue()


@router.post("/queue/{pid}/{action}")
def queue_action(pid: int, action: str) -> dict:
    with session_scope() as s:
        p = s.get(Publication, pid)
        if p is None:
            raise HTTPException(404, "Eintrag nicht gefunden")
        aid = p.account_id
        if action == "cancel":
            if p.status not in ("scheduled", "needs_safety", "failed"):
                raise HTTPException(409, "Läuft schon oder ist veröffentlicht")
            p.status = "cancelled"
        elif action == "retry":
            if p.status not in ("failed", "needs_safety", "cancelled"):
                raise HTTPException(409, "Nur fehlgeschlagene/abgebrochene Einträge")
            if p.status == "needs_safety":
                c = p.clip
                if c.safety_flagged and not c.safety_override:
                    raise HTTPException(409, "Erst Safety-Hinweis im Clip ausdrücklich freigeben")
            p.status, p.attempts, p.error, p.next_retry_at = "scheduled", 0, None, None
        elif action == "now":
            if p.status != "scheduled":
                raise HTTPException(409, "Nur geplante Einträge")
            p.scheduled_at = utcnow()
            p.next_retry_at = None
        else:
            raise HTTPException(400, "Aktion unbekannt")
    if action in ("cancel", "retry"):
        replan_account(aid)
    if action == "now":
        from ..publish.scheduler import tick

        tick()
    return get_queue()


# ------------------------------------------------------------------ Export
class ExportIn(BaseModel):
    clip_ids: list[int]
    name: str | None = None


@router.post("/export")
def start_export(body: ExportIn) -> dict:
    if not body.clip_ids:
        raise HTTPException(400, "Keine Clips ausgewählt")
    name = body.name or f"clipfabrik_{utcnow():%Y-%m-%d_%H%M}"
    return {"job_id": queue.enqueue("export_package", {"clip_ids": body.clip_ids, "name": name}, priority=35)}


@router.get("/export/{jid}")
def export_status(jid: int) -> dict:
    with session_scope() as s:
        j = s.get(Job, jid)
        if j is None or j.type != "export_package":
            raise HTTPException(404, "Export nicht gefunden")
        return {"status": j.status, "progress": j.progress, "msg": j.progress_msg, "error": j.error,
                "download_url": f"/api/export/{jid}/download" if j.status == "done" else None}


@router.get("/export/{jid}/download")
def export_download(jid: int):
    from pathlib import Path

    with session_scope() as s:
        j = s.get(Job, jid)
        path = (j.state or {}).get("path") if j else None
    if not path or not Path(path).exists():
        raise HTTPException(404, "Export-Datei nicht (mehr) vorhanden")
    return FileResponse(path, media_type="application/zip", filename=Path(path).name)
