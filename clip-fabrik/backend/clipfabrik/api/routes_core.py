"""Login, Status, Kanäle, Streams."""

from __future__ import annotations

import datetime as dt
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from .. import auth, settings_store
from ..analysis.transcribe import whisper_available
from ..config import get_settings
from ..db import Channel, Clip, Invite, Job, Stream, TwitchAccount, session_scope, utcnow
from ..jobs import queue
from ..storage import disk_status
from ..twitch.helix import Helix, TwitchError
from .serialize import channel_out, stream_out

router = APIRouter(prefix="/api")
protected = APIRouter(prefix="/api", dependencies=[Depends(auth.require_login)])


# ------------------------------------------------------------------ Login
class LoginIn(BaseModel):
    password: str


@router.post("/auth/login")
def login(body: LoginIn, request: Request, response: Response) -> dict:
    ip = auth.client_ip(request)
    if auth.is_locked(ip):
        raise HTTPException(429, "Zu viele Fehlversuche. Bitte 15 Minuten warten.")
    if not auth.verify_password(body.password):
        auth.record_attempt(ip, False)
        raise HTTPException(401, "Passwort falsch")
    auth.record_attempt(ip, True)
    response.set_cookie(auth.COOKIE_NAME, auth.create_session_token(), max_age=auth.SESSION_MAX_AGE, httponly=True,
                        secure=get_settings().secure_cookies, samesite="lax", path="/")
    return {"ok": True}


@router.post("/auth/logout")
def logout(response: Response) -> dict:
    response.delete_cookie(auth.COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/auth/me")
def me(request: Request) -> dict:
    return {"logged_in": auth.check_session_token(request.cookies.get(auth.COOKIE_NAME)),
            "password_set": bool(settings_store.get("admin_password_hash"))}


class PasswordIn(BaseModel):
    old: str
    new: str


@protected.post("/auth/password")
def change_password(body: PasswordIn, response: Response) -> dict:
    auth.change_password(body.old, body.new)
    response.set_cookie(auth.COOKIE_NAME, auth.create_session_token(), max_age=auth.SESSION_MAX_AGE, httponly=True,
                        secure=get_settings().secure_cookies, samesite="lax", path="/")
    return {"ok": True}


@router.get("/health")
def health() -> dict:
    return {"ok": True}


# ------------------------------------------------------------------ Status
@protected.get("/status")
def status() -> dict:
    s_ = get_settings()
    helix = Helix()
    warnings: list[str] = []
    with session_scope() as s:
        mod = s.scalar(select(TwitchAccount).where(TwitchAccount.role == "mod").order_by(TwitchAccount.id.desc()))
        jobs = dict(s.execute(select(Job.status, func.count()).group_by(Job.status)).all())
        pending = s.scalar(select(func.count()).select_from(Clip).where(Clip.bucket == "review", Clip.review_state == "pending")) or 0
        hb = settings_store.get("daemon_heartbeat", session=s)
        whb = settings_store.get("worker_heartbeat", session=s)
    ai_key = bool(settings_store.get("anthropic_api_key"))
    if not helix.configured:
        warnings.append("Twitch-App fehlt (Client-ID/Secret): keine automatische Live-Erkennung.")
    if not mod:
        warnings.append("Twitch-Mod-Login fehlt: Chat wird anonym gelesen, „Create Clip“ geht nicht.")
    if not ai_key and not s_.fake_ai:
        warnings.append("Kein Anthropic-API-Key: Heuristik-Modus mit deutlich schwächerer Auswahl.")
    if not whisper_available() and not s_.fake_ai:
        warnings.append("faster-whisper fehlt: keine echte Transkription.")
    if not s_.public_url.startswith("https://"):
        warnings.append("PUBLIC_URL ist kein HTTPS: Web-Push und EventSub brauchen HTTPS.")
    now = dt.datetime.now(dt.UTC).timestamp()
    if not hb or now - float(hb) > 120:
        warnings.append("Daemon (Aufnahme/Live-Erkennung) läuft nicht.")
    if not whb or now - float(whb) > 120:
        warnings.append("Worker (Analyse/Rendering) läuft nicht.")
    ds = disk_status()
    if ds["warn"]:
        warnings.append(f"Speicher knapp: {ds['free_gb']} GB frei.")
    return {
        "twitch_app": helix.configured, "twitch_mod": {"login": mod.login, "scopes": mod.scopes} if mod else None,
        "ai": "claude" if ai_key and not s_.fake_ai else "heuristik", "model": settings_store.get("claude_model"),
        "whisper": whisper_available() and not s_.fake_ai, "whisper_model": s_.whisper_model, "disk": ds, "jobs": jobs,
        "pending_review": pending, "warnings": warnings, "public_url": s_.public_url, "fake": s_.fake_ai,
    }


# ------------------------------------------------------------------ Kanäle
class ChannelIn(BaseModel):
    login: str = Field(min_length=2, max_length=40)
    consent: bool = False
    consent_note: str = ""
    live_enabled: bool = False
    post_enabled: bool = True
    clips_per_stream: int | None = None
    min_score: float | None = None
    language: str = "de"
    brand_voice: str = ""


class ChannelPatch(BaseModel):
    live_enabled: bool | None = None
    post_enabled: bool | None = None
    clips_per_stream: int | None = Field(default=None, ge=1, le=60)
    min_score: float | None = Field(default=None, ge=1, le=10)
    language: str | None = None
    brand_voice: str | None = None
    create_twitch_clips: bool | None = None
    chat_clip_command: bool | None = None
    vod_backup: bool | None = None
    layout: str | None = None
    facecam_rect: dict | None = None


def _channel_extra(s, ch: Channel) -> dict:
    current = s.scalar(select(Stream).where(Stream.channel_id == ch.id).order_by(Stream.id.desc()).limit(1))
    live_clips = 0
    if current is not None:
        live_clips = s.scalar(select(func.count()).select_from(Clip).where(Clip.stream_id == current.id, Clip.bucket != "discarded")) or 0
    pending = s.scalar(select(func.count()).select_from(Clip).join(Stream, Clip.stream_id == Stream.id).where(
        Stream.channel_id == ch.id, Clip.bucket == "review", Clip.review_state == "pending")) or 0
    return {"current": current, "live_clips": live_clips, "pending": pending}


@protected.get("/channels")
def list_channels() -> list[dict]:
    with session_scope() as s:
        return [channel_out(ch, **_channel_extra(s, ch)) for ch in s.scalars(select(Channel).order_by(Channel.id)).all()]


@protected.post("/channels")
def create_channel(body: ChannelIn) -> dict:
    if not body.consent:
        raise HTTPException(400, "Bitte bestätigen: Der Streamer hat der Nutzung seiner Streams zugestimmt.")
    login = body.login.strip().lstrip("@").lower()
    if "twitch.tv/" in login:
        login = login.rsplit("twitch.tv/", 1)[1].split("/")[0]
    info: dict = {}
    helix = Helix()
    if helix.configured:
        try:
            users = helix.get_users([login])
        except TwitchError as exc:
            raise HTTPException(502, f"Twitch nicht erreichbar: {exc}") from exc
        if not users:
            raise HTTPException(404, f"Twitch-Kanal „{login}“ nicht gefunden")
        info = users[0]
    with session_scope() as s:
        if s.scalar(select(Channel).where(Channel.login == login)):
            raise HTTPException(409, "Kanal existiert schon")
        ch = Channel(
            login=login, display_name=info.get("display_name", login), twitch_user_id=info.get("id"),
            profile_image_url=info.get("profile_image_url"), live_enabled=body.live_enabled, post_enabled=body.post_enabled,
            clips_per_stream=body.clips_per_stream or int(settings_store.get("default_clips_per_stream")),
            min_score=body.min_score or float(settings_store.get("default_min_score")), language=body.language,
            brand_voice=body.brand_voice, consent_confirmed=True, consent_at=utcnow(), consent_note=body.consent_note,
        )
        s.add(ch)
        s.flush()
        return channel_out(ch)


@protected.patch("/channels/{cid}")
def patch_channel(cid: int, body: ChannelPatch) -> dict:
    with session_scope() as s:
        ch = s.get(Channel, cid)
        if ch is None:
            raise HTTPException(404, "Kanal nicht gefunden")
        for k, v in body.model_dump(exclude_unset=True).items():
            if k == "layout" and v not in ("blur", "facecam_top"):
                raise HTTPException(400, "Layout unbekannt")
            setattr(ch, k, v)
        return channel_out(ch, **_channel_extra(s, ch))


@protected.delete("/channels/{cid}")
def delete_channel(cid: int) -> dict:
    with session_scope() as s:
        ch = s.get(Channel, cid)
        if ch is None:
            raise HTTPException(404, "Kanal nicht gefunden")
        if ch.status == "recording":
            raise HTTPException(409, "Kanal nimmt gerade auf")
        for st in s.scalars(select(Stream).where(Stream.channel_id == cid)).all():
            st.channel_id = None
        s.delete(ch)
    return {"ok": True}


class ClipNowIn(BaseModel):
    lookback: float | None = Field(default=None, ge=15, le=120)


@protected.post("/channels/{cid}/clip-now")
def clip_now(cid: int, body: ClipNowIn) -> dict:
    """Ein-Tipp-Knopf „Jetzt clippen“: markiert die letzten 30–60 s im laufenden Stream."""
    from ..daemon import create_marker

    with session_scope() as s:
        st = s.scalar(select(Stream).where(Stream.channel_id == cid, Stream.status == "recording").order_by(Stream.id.desc()))
        if st is None:
            raise HTTPException(409, "Kanal nimmt gerade nicht auf")
        sid = st.id
    mid = create_marker(sid, "manual", note="Jetzt clippen (Handy)", lookback=body.lookback)
    return {"ok": True, "marker_id": mid, "stream_id": sid}


@protected.post("/channels/{cid}/invite")
def channel_invite(cid: int) -> dict:
    """Einladungslink, mit dem der Streamer per Twitch-Login offiziell zustimmt."""
    with session_scope() as s:
        if s.get(Channel, cid) is None:
            raise HTTPException(404, "Kanal nicht gefunden")
        inv = Invite(token=secrets.token_urlsafe(24), platform="twitch", channel_id=cid, expires_at=utcnow() + dt.timedelta(days=7))
        s.add(inv)
        token = inv.token
    return {"url": f"{get_settings().public_url.rstrip('/')}/einladung/{token}", "expires_days": 7}


# ------------------------------------------------------------------ Streams
def _counts(s, sid: int) -> dict:
    rows = s.execute(select(Clip.bucket, Clip.review_state, func.count()).where(Clip.stream_id == sid)
                     .group_by(Clip.bucket, Clip.review_state)).all()
    out: dict[str, int] = {"review": 0, "archive": 0, "discarded": 0, "approved": 0, "rejected": 0, "pending": 0}
    for bucket, state, n in rows:
        out[bucket] = out.get(bucket, 0) + n
        out[state] = out.get(state, 0) + n
    return out


@protected.get("/streams")
def list_streams(channel_id: int | None = None, limit: int = 50) -> list[dict]:
    with session_scope() as s:
        q = select(Stream).order_by(Stream.id.desc()).limit(min(limit, 200))
        if channel_id:
            q = q.where(Stream.channel_id == channel_id)
        return [stream_out(st, counts=_counts(s, st.id)) for st in s.scalars(q).all()]


@protected.get("/streams/{sid}")
def get_stream(sid: int) -> dict:
    from .serialize import job_out

    with session_scope() as s:
        st = s.get(Stream, sid)
        if st is None:
            raise HTTPException(404, "Stream nicht gefunden")
        jobs = s.scalars(select(Job).where(Job.stream_id == sid).order_by(Job.id.desc()).limit(20)).all()
        return stream_out(st, counts=_counts(s, sid)) | {"jobs": [job_out(j) for j in jobs]}


class ProcessIn(BaseModel):
    confirmed: bool = False


@protected.post("/streams/{sid}/process")
def process_stream(sid: int, body: ProcessIn) -> dict:
    with session_scope() as s:
        st = s.get(Stream, sid)
        if st is None:
            raise HTTPException(404, "Stream nicht gefunden")
        if st.status == "recording":
            raise HTTPException(409, "Stream läuft noch")
    jid = queue.enqueue("process_stream", {"stream_id": sid, "confirmed": body.confirmed}, priority=50,
                        unique_key=f"process:{sid}", stream_id=sid)
    return {"job_id": jid}


@protected.delete("/streams/{sid}")
def delete_stream(sid: int) -> dict:
    import shutil
    from pathlib import Path

    from ..db import Marker, Publication, Segment

    with session_scope() as s:
        st = s.get(Stream, sid)
        if st is None:
            raise HTTPException(404, "Stream nicht gefunden")
        if st.status in ("recording", "processing"):
            raise HTTPException(409, "Stream wird gerade aufgenommen/verarbeitet")
        clip_ids = [c.id for c in s.scalars(select(Clip).where(Clip.stream_id == sid)).all()]
        if clip_ids and s.scalar(select(func.count()).select_from(Publication).where(Publication.clip_id.in_(clip_ids),
                                                                                   Publication.status.in_(("live", "processing")))):
            raise HTTPException(409, "Clips dieses Streams sind veröffentlicht – Stream bleibt erhalten")
        for model in (Segment, Marker):
            for row in s.scalars(select(model).where(model.stream_id == sid)).all():
                s.delete(row)
        for cid in clip_ids:
            for p in s.scalars(select(Publication).where(Publication.clip_id == cid)).all():
                s.delete(p)
            s.delete(s.get(Clip, cid))
        d = st.dir
        s.delete(st)
    shutil.rmtree(d, ignore_errors=True)
    shutil.rmtree(get_settings().clips_dir / str(sid), ignore_errors=True)
    _ = Path
    return {"ok": True}
