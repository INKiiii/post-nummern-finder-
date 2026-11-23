"""Speicherplatz-Management: Anzeige, Warnung, Aufräumen nach Aufbewahrungsfristen."""

from __future__ import annotations

import datetime as dt
import logging
import shutil
import time
from pathlib import Path

from sqlalchemy import select

from . import settings_store
from .config import get_settings
from .db import Clip, Segment, Stream, session_scope, utcnow

log = logging.getLogger(__name__)


def disk_status() -> dict:
    s = get_settings()
    usage = shutil.disk_usage(s.data_dir)
    free_pct = usage.free / usage.total * 100 if usage.total else 0
    warn_pct = float(settings_store.get("disk_warn_percent") or 15)
    stop_gb = float(settings_store.get("disk_stop_gb") or 3)
    return {
        "total_gb": round(usage.total / 1e9, 1),
        "used_gb": round(usage.used / 1e9, 1),
        "free_gb": round(usage.free / 1e9, 1),
        "free_percent": round(free_pct, 1),
        "warn": free_pct < warn_pct,
        "critical": usage.free / 1e9 < stop_gb,
        "data_gb": round(dir_size(s.data_dir) / 1e9, 2),
    }


def dir_size(p: Path) -> int:
    total = 0
    if not p.exists():
        return 0
    for f in p.rglob("*"):
        try:
            if f.is_file():
                total += f.stat().st_size
        except OSError:
            continue
    return total


def enough_space_for_recording() -> bool:
    return not disk_status()["critical"]


def _rm(path: str | Path | None) -> int:
    if not path:
        return 0
    p = Path(path)
    try:
        if p.is_dir():
            n = dir_size(p)
            shutil.rmtree(p, ignore_errors=True)
            return n
        if p.exists():
            n = p.stat().st_size
            p.unlink()
            return n
    except OSError as exc:
        log.warning("Löschen fehlgeschlagen %s: %s", p, exc)
    return 0


def cleanup(now: dt.datetime | None = None) -> dict:
    """Löscht Rohmaterial nach X Tagen (Clips bleiben), Dateien abgelehnter Clips nach Y Tagen."""
    now = now or utcnow()
    raw_days = int(settings_store.get("raw_retention_days") or 7)
    rej_days = int(settings_store.get("rejected_retention_days") or 14)
    freed = 0
    streams_cleaned = 0
    clips_cleaned = 0
    with session_scope() as s:
        old = s.scalars(select(Stream).where(
            Stream.raw_deleted.is_(False), Stream.status.in_(("done", "failed", "unrecordable")),
            Stream.ended_at.is_not(None), Stream.ended_at < now - dt.timedelta(days=raw_days),
        )).all()
        for st in old:
            d = Path(st.dir)
            freed += _rm(d / "segments")
            freed += _rm(d / "audio.wav")
            freed += _rm(d / "frames")
            if st.source_type == "twitch":
                freed += _rm(st.source_path)
            elif st.source_path and Path(st.source_path).is_relative_to(get_settings().uploads_dir):
                freed += _rm(st.source_path)
            st.raw_deleted = True
            for seg in s.scalars(select(Segment).where(Segment.stream_id == st.id)).all():
                s.delete(seg)
            streams_cleaned += 1
        rejected = s.scalars(select(Clip).where(
            Clip.review_state == "rejected", Clip.reviewed_at.is_not(None), Clip.reviewed_at < now - dt.timedelta(days=rej_days),
            (Clip.preview_path.is_not(None)) | (Clip.render_path.is_not(None)),
        )).all()
        for c in rejected:
            freed += _rm(c.preview_path) + _rm(c.render_path)
            c.preview_path = None
            c.render_path = None
            c.render_status = "none"
            clips_cleaned += 1
    # Exporte nach 3 Tagen, Frame-Cache nach 7 Tagen
    cutoff = time.time() - 3 * 86400
    for f in get_settings().exports_dir.glob("*"):
        if f.stat().st_mtime < cutoff:
            freed += _rm(f)
    if streams_cleaned or clips_cleaned:
        log.info("Aufgeräumt: %d Streams, %d Clips, %.2f GB frei", streams_cleaned, clips_cleaned, freed / 1e9)
    return {"streams": streams_cleaned, "clips": clips_cleaned, "freed_gb": round(freed / 1e9, 2)}
