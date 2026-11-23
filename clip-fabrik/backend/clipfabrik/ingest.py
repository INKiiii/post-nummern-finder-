"""Ingest: Upload, Ordner-Überwachung, Dateien als Stream anlegen."""

from __future__ import annotations

import logging
import shutil
import time
from pathlib import Path

from sqlalchemy import select

from .config import get_settings
from .db import Stream, session_scope, utcnow
from .jobs import queue
from .media import ffmpeg

log = logging.getLogger(__name__)

VIDEO_EXT = {".mp4", ".mkv", ".mov", ".ts", ".flv", ".webm", ".m4v", ".avi"}


def create_stream_from_file(path: Path, *, source_type: str = "upload", title: str = "", channel_id: int | None = None,
                            auto_process: bool = True, move: bool = False) -> int:
    settings = get_settings()
    info = ffmpeg.probe(path)
    if not info.has_video:
        raise ValueError("Datei enthält kein Video")
    with session_scope() as s:
        st = Stream(channel_id=channel_id, source_type=source_type, title=title or path.stem, status="recorded",
                    dir="", source_path=str(path), duration=info.duration, started_at=utcnow(), ended_at=utcnow())
        s.add(st)
        s.flush()
        sdir = settings.streams_dir / f"{st.id}"
        sdir.mkdir(parents=True, exist_ok=True)
        st.dir = str(sdir)
        if move:
            dst = sdir / ("source" + path.suffix.lower())
            shutil.move(str(path), dst)
            st.source_path = str(dst)
        sid = st.id
    log.info("Quelle angelegt: Stream %s (%s, %.0fs)", sid, source_type, info.duration)
    if auto_process:
        queue.enqueue("process_stream", {"stream_id": sid}, priority=50, unique_key=f"process:{sid}", stream_id=sid)
    return sid


class FolderWatcher:
    """Überwacht DATA_DIR/inbox: neue Videodateien werden importiert, sobald ihre Größe 60 s stabil ist."""

    def __init__(self, inbox: Path | None = None, stable_seconds: float = 60.0) -> None:
        self.inbox = inbox or get_settings().inbox_dir
        self.stable_seconds = stable_seconds
        self.seen: dict[Path, tuple[int, float]] = {}

    def scan(self, now: float | None = None) -> list[int]:
        now = now or time.time()
        created: list[int] = []
        self.inbox.mkdir(parents=True, exist_ok=True)
        for f in sorted(self.inbox.iterdir()):
            if not f.is_file() or f.suffix.lower() not in VIDEO_EXT or f.name.startswith("."):
                continue
            size = f.stat().st_size
            prev = self.seen.get(f)
            if prev is None or prev[0] != size:
                self.seen[f] = (size, now)
                continue
            if now - prev[1] < self.stable_seconds:
                continue
            with session_scope() as s:
                exists = s.scalar(select(Stream.id).where(Stream.source_path == str(f)))
            if exists:
                continue
            try:
                created.append(create_stream_from_file(f, source_type="folder", move=True))
            except Exception as exc:  # noqa: BLE001
                log.error("Import aus Ordner fehlgeschlagen (%s): %s", f.name, exc)
                f.rename(f.with_suffix(f.suffix + ".fehler"))
            self.seen.pop(f, None)
        return created
