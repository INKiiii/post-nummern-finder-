"""Datenbank: SQLAlchemy-Modelle und Session-Verwaltung (SQLite im WAL-Modus)."""

from __future__ import annotations

import datetime as dt
from contextlib import contextmanager
from typing import Any, Iterator

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    create_engine,
    event,
)
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.UTC).replace(tzinfo=None)


class Base(DeclarativeBase):
    type_annotation_map = {dict[str, Any]: JSON, list[Any]: JSON}


# --------------------------------------------------------------------------------------
# Einstellungen, Login, Cache
# --------------------------------------------------------------------------------------


class AppSetting(Base):
    __tablename__ = "app_settings"
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON, nullable=True)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class LoginAttempt(Base):
    __tablename__ = "login_attempts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ip: Mapped[str] = mapped_column(String(64), index=True)
    success: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow, index=True)


class LLMCache(Base):
    """Cache für Claude-Antworten (gleicher Prompt -> keine zweite Abrechnung)."""

    __tablename__ = "llm_cache"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    model: Mapped[str] = mapped_column(String(80))
    purpose: Mapped[str] = mapped_column(String(40))
    response: Mapped[Any] = mapped_column(JSON)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)


class LLMUsage(Base):
    """Tatsächliche API-Kosten pro Stream (für Kostenkontrolle)."""

    __tablename__ = "llm_usage"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    stream_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    purpose: Mapped[str] = mapped_column(String(40))
    model: Mapped[str] = mapped_column(String(80))
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_read_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_write_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    cached: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)


# --------------------------------------------------------------------------------------
# Twitch: Kanäle, Streams, Segmente, Marker
# --------------------------------------------------------------------------------------


class TwitchAccount(Base):
    """Mein eigenes (Mod-)Twitch-Konto oder das des Streamers (Zustimmung)."""

    __tablename__ = "twitch_accounts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    role: Mapped[str] = mapped_column(String(20), default="mod")  # mod | streamer
    twitch_user_id: Mapped[str] = mapped_column(String(40))
    login: Mapped[str] = mapped_column(String(80))
    display_name: Mapped[str] = mapped_column(String(120), default="")
    scopes: Mapped[list[Any]] = mapped_column(JSON, default=list)
    tokens_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    expires_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)


class Channel(Base):
    __tablename__ = "channels"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    login: Mapped[str] = mapped_column(String(80), unique=True)
    display_name: Mapped[str] = mapped_column(String(120), default="")
    twitch_user_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    profile_image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Modus
    live_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    post_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    clips_per_stream: Mapped[int] = mapped_column(Integer, default=15)
    min_score: Mapped[float] = mapped_column(Float, default=7.0)
    language: Mapped[str] = mapped_column(String(10), default="de")
    brand_voice: Mapped[str] = mapped_column(Text, default="")
    create_twitch_clips: Mapped[bool] = mapped_column(Boolean, default=False)
    chat_clip_command: Mapped[bool] = mapped_column(Boolean, default=True)
    vod_backup: Mapped[bool] = mapped_column(Boolean, default=False)
    layout: Mapped[str] = mapped_column(String(20), default="blur")  # blur | facecam_top
    facecam_rect: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    # Zustimmung
    consent_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    consent_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    consent_note: Mapped[str] = mapped_column(Text, default="")
    streamer_authorized: Mapped[bool] = mapped_column(Boolean, default=False)
    # Laufzeit-Status
    status: Mapped[str] = mapped_column(String(20), default="offline")
    live_hint: Mapped[str | None] = mapped_column(String(20), nullable=True)  # aus EventSub
    live_hint_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    last_checked_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    eventsub_ids: Mapped[list[Any]] = mapped_column(JSON, default=list)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)

    streams: Mapped[list["Stream"]] = relationship(back_populates="channel")


class Stream(Base):
    """Eine Quelle: Twitch-Aufnahme, Upload, Ordner-Import oder URL-Import."""

    __tablename__ = "streams"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    channel_id: Mapped[int | None] = mapped_column(ForeignKey("channels.id"), nullable=True, index=True)
    source_type: Mapped[str] = mapped_column(String(20), default="twitch")
    title: Mapped[str] = mapped_column(String(300), default="")
    game: Mapped[str] = mapped_column(String(200), default="")
    twitch_stream_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    status: Mapped[str] = mapped_column(String(30), default="recording")
    # recording | recorded | waiting_approval | processing | done | failed | unrecordable
    dir: Mapped[str] = mapped_column(String(500))
    source_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    started_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)
    ended_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    duration: Mapped[float] = mapped_column(Float, default=0.0)
    gaps: Mapped[list[Any]] = mapped_column(JSON, default=list)
    cost_estimate_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    cost_actual_usd: Mapped[float] = mapped_column(Float, default=0.0)
    live_mode: Mapped[bool] = mapped_column(Boolean, default=False)
    post_mode: Mapped[bool] = mapped_column(Boolean, default=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    raw_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    meta: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)

    channel: Mapped[Channel | None] = relationship(back_populates="streams")
    segments: Mapped[list["Segment"]] = relationship(back_populates="stream", order_by="Segment.idx")


class Segment(Base):
    __tablename__ = "segments"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    stream_id: Mapped[int] = mapped_column(ForeignKey("streams.id"), index=True)
    idx: Mapped[int] = mapped_column(Integer)
    run: Mapped[int] = mapped_column(Integer, default=0)
    path: Mapped[str] = mapped_column(String(500))
    wall_start: Mapped[dt.datetime] = mapped_column(DateTime)
    duration: Mapped[float] = mapped_column(Float, default=0.0)
    complete: Mapped[bool] = mapped_column(Boolean, default=False)

    stream: Mapped[Stream] = relationship(back_populates="segments")


class Marker(Base):
    """Markierter Moment (manuell, !clip, Twitch-Clip, Live-Automatik)."""

    __tablename__ = "markers"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    stream_id: Mapped[int] = mapped_column(ForeignKey("streams.id"), index=True)
    wall_time: Mapped[dt.datetime] = mapped_column(DateTime)
    lookback: Mapped[float] = mapped_column(Float, default=45.0)
    source: Mapped[str] = mapped_column(String(20))  # manual | chat_command | twitch_clip | auto
    note: Mapped[str] = mapped_column(String(300), default="")
    signal: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    twitch_clip_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    twitch_clip_url: Mapped[str | None] = mapped_column(String(300), nullable=True)
    handled: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)


# --------------------------------------------------------------------------------------
# Clips
# --------------------------------------------------------------------------------------


class Clip(Base):
    __tablename__ = "clips"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    stream_id: Mapped[int] = mapped_column(ForeignKey("streams.id"), index=True)
    origin: Mapped[str] = mapped_column(String(20), default="post")  # post | live | manual
    # review: pending | approved | rejected | later ; bucket: review | archive | discarded
    review_state: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    bucket: Mapped[str] = mapped_column(String(20), default="review", index=True)
    rank: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Schnitt (Sekunden im Quell-Zeitstrahl). cuts = Liste von {start, end}; letzter = Hauptteil
    start: Mapped[float] = mapped_column(Float)
    end: Mapped[float] = mapped_column(Float)
    cuts: Mapped[list[Any]] = mapped_column(JSON, default=list)
    # Inhalt
    title: Mapped[str] = mapped_column(String(300), default="")
    hook_text: Mapped[str] = mapped_column(String(200), default="")
    context_line: Mapped[str] = mapped_column(String(200), default="")
    category: Mapped[str] = mapped_column(String(40), default="")
    reason: Mapped[str] = mapped_column(Text, default="")
    transcript: Mapped[str] = mapped_column(Text, default="")
    words: Mapped[list[Any]] = mapped_column(JSON, default=list)  # relativ zum Clip-Ausgang
    subtitle_lines: Mapped[list[Any] | None] = mapped_column(JSON, nullable=True)
    signals: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # Bewertung
    scores: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    total_score: Mapped[float] = mapped_column(Float, default=0.0, index=True)
    safety: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    safety_flagged: Mapped[bool] = mapped_column(Boolean, default=False)
    safety_override: Mapped[bool] = mapped_column(Boolean, default=False)
    safety_checked_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    live_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    # Texte pro Plattform
    captions: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    platforms: Mapped[list[Any]] = mapped_column(JSON, default=list)
    # Dateien
    slug: Mapped[str] = mapped_column(String(200), default="")
    preview_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    render_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    thumb_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    render_version: Mapped[int] = mapped_column(Integer, default=0)
    render_status: Mapped[str] = mapped_column(String(20), default="none")  # none|queued|rendering|done|failed
    render_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    marker_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reviewed_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow, index=True)

    stream: Mapped[Stream] = relationship()
    publications: Mapped[list["Publication"]] = relationship(back_populates="clip")

    @property
    def duration(self) -> float:
        if self.cuts:
            return float(sum((c["end"] - c["start"]) if isinstance(c, dict) else (c[1] - c[0]) for c in self.cuts))
        return float(self.end - self.start)


# --------------------------------------------------------------------------------------
# Jobs
# --------------------------------------------------------------------------------------


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    type: Mapped[str] = mapped_column(String(40), index=True)
    unique_key: Mapped[str | None] = mapped_column(String(120), nullable=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    state: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # Checkpoints
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    priority: Mapped[int] = mapped_column(Integer, default=100)  # kleiner = wichtiger
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    progress_msg: Mapped[str] = mapped_column(String(300), default="")
    step: Mapped[str] = mapped_column(String(60), default="")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    run_after: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)
    locked_by: Mapped[str | None] = mapped_column(String(80), nullable=True)
    heartbeat_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    stream_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    clip_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)
    started_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)

    __table_args__ = (Index("ix_jobs_claim", "status", "priority", "run_after"),)


# --------------------------------------------------------------------------------------
# Veröffentlichung
# --------------------------------------------------------------------------------------


class SocialAccount(Base):
    __tablename__ = "social_accounts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    platform: Mapped[str] = mapped_column(String(20), index=True)  # tiktok | instagram | youtube | mock
    name: Mapped[str] = mapped_column(String(200), default="")
    external_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    owner: Mapped[str] = mapped_column(String(20), default="me")  # me | streamer
    status: Mapped[str] = mapped_column(String(20), default="connected")  # connected | expired | error
    tokens_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    token_expires_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    scopes: Mapped[list[Any]] = mapped_column(JSON, default=list)
    daily_limit: Mapped[int] = mapped_column(Integer, default=5)
    api_approved: Mapped[bool] = mapped_column(Boolean, default=False)  # Audit/App-Prüfung durch
    post_mode: Mapped[str] = mapped_column(String(20), default="direct")  # direct | draft
    privacy: Mapped[str] = mapped_column(String(30), default="")
    windows: Mapped[list[Any] | None] = mapped_column(JSON, nullable=True)
    min_gap_minutes: Mapped[int] = mapped_column(Integer, default=60)
    jitter_minutes: Mapped[int] = mapped_column(Integer, default=12)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    meta: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)


class Invite(Base):
    """Einladungslink, mit dem der Streamer am Handy selbst ein Konto verbindet."""

    __tablename__ = "invites"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token: Mapped[str] = mapped_column(String(80), unique=True)
    platform: Mapped[str] = mapped_column(String(20))  # tiktok | instagram | youtube | twitch
    channel_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    note: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime)
    used_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    account_id: Mapped[int | None] = mapped_column(Integer, nullable=True)


class OAuthState(Base):
    __tablename__ = "oauth_states"
    state: Mapped[str] = mapped_column(String(80), primary_key=True)
    platform: Mapped[str] = mapped_column(String(20))
    purpose: Mapped[str] = mapped_column(String(30))  # login | account | invite | streamer
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)


class Publication(Base):
    __tablename__ = "publications"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    clip_id: Mapped[int] = mapped_column(ForeignKey("clips.id"), index=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("social_accounts.id"), index=True)
    platform: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default="scheduled", index=True)
    # scheduled | running | processing | live | failed | cancelled | needs_safety
    position: Mapped[int] = mapped_column(Integer, default=0)
    scheduled_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_retry_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    external_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    external_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    published_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    metrics: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    metrics_updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)

    clip: Mapped[Clip] = relationship(back_populates="publications")
    account: Mapped[SocialAccount] = relationship()


class QuotaUsage(Base):
    __tablename__ = "quota_usage"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(Integer, index=True)
    day: Mapped[str] = mapped_column(String(10), index=True)  # YYYY-MM-DD (Plattform-Zeitzone)
    units: Mapped[int] = mapped_column(Integer, default=0)
    uploads: Mapped[int] = mapped_column(Integer, default=0)


# --------------------------------------------------------------------------------------
# Push
# --------------------------------------------------------------------------------------


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    endpoint: Mapped[str] = mapped_column(String(1000), unique=True)
    keys: Mapped[dict[str, Any]] = mapped_column(JSON)
    user_agent: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)


class NotificationLog(Base):
    __tablename__ = "notification_log"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event: Mapped[str] = mapped_column(String(40), index=True)
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, default="")
    url: Mapped[str] = mapped_column(String(300), default="/")
    delivered: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    suppressed: Mapped[bool] = mapped_column(Boolean, default=False)
    stream_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow, index=True)


# --------------------------------------------------------------------------------------
# Engine / Session
# --------------------------------------------------------------------------------------

_engine: Engine | None = None
_SessionLocal: sessionmaker[Session] | None = None


def _sqlite_pragmas(dbapi_conn, _record) -> None:  # pragma: no cover - trivial
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA busy_timeout=15000")
    cur.close()


def init_engine(url: str | None = None) -> Engine:
    global _engine, _SessionLocal
    from .config import get_settings

    url = url or get_settings().db_url
    engine = create_engine(
        url,
        connect_args={"check_same_thread": False, "timeout": 30} if url.startswith("sqlite") else {},
        pool_pre_ping=True,
    )
    if url.startswith("sqlite"):
        event.listen(engine, "connect", _sqlite_pragmas)
    Base.metadata.create_all(engine)
    _engine = engine
    _SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
    return engine


def get_engine() -> Engine:
    if _engine is None:
        init_engine()
    assert _engine is not None
    return _engine


def SessionLocal() -> Session:
    if _SessionLocal is None:
        init_engine()
    assert _SessionLocal is not None
    return _SessionLocal()


@contextmanager
def session_scope() -> Iterator[Session]:
    s = SessionLocal()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def reset_engine() -> None:
    global _engine, _SessionLocal
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _SessionLocal = None
