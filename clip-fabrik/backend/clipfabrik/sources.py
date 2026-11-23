"""Quellen eines Streams: Zeitstrahl aus Segmenten, Ausschnitte für Live-Analyse und Rendering."""

from __future__ import annotations

import calendar
import datetime as dt
import logging
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .analysis.timeline import Gap, Piece, Timeline
from .db import Segment, Stream
from .media import ffmpeg

log = logging.getLogger(__name__)


def epoch(t: dt.datetime) -> float:
    """Naive UTC-Zeit -> Epoch-Sekunden."""
    return calendar.timegm(t.utctimetuple()) + t.microsecond / 1e6


def from_epoch(e: float) -> dt.datetime:
    return dt.datetime.fromtimestamp(e, dt.UTC).replace(tzinfo=None)


def timeline_for(s: Session, stream: Stream, *, include_incomplete: bool = False) -> Timeline:
    meta_tl = (stream.meta or {}).get("timeline")
    if stream.source_path and Path(stream.source_path).exists() and meta_tl:
        return timeline_from_meta(meta_tl, stream.source_path)
    if stream.source_type != "twitch":
        if stream.source_path and stream.duration:
            return Timeline.single(epoch(stream.started_at), stream.duration, stream.source_path)
    q = select(Segment).where(Segment.stream_id == stream.id)
    if not include_incomplete:
        q = q.where(Segment.complete.is_(True))
    segs = s.scalars(q.order_by(Segment.wall_start)).all()
    if not segs and meta_tl:
        return timeline_from_meta(meta_tl, stream.source_path or "")
    return Timeline.from_segments([(epoch(x.wall_start), x.duration, x.path, x.run) for x in segs])


def timeline_to_meta(tl: Timeline) -> dict:
    return {
        "pieces": [[p.offset, p.wall_start, p.duration, p.run] for p in tl.pieces],
        "gaps": [g.to_dict() for g in tl.gaps],
    }


def timeline_from_meta(meta: dict, path: str) -> Timeline:
    pieces = [Piece(offset=o, wall_start=w, duration=d, path=path, run=r) for o, w, d, r in meta.get("pieces", [])]
    # Nach dem Zusammensetzen liegt alles in einer Datei: Pfad + Offsets bleiben gültig
    gaps = [Gap(at=g["at"], wall_start=g["wall_start"], seconds=g["seconds"], reason=g.get("reason", "")) for g in meta.get("gaps", [])]
    return Timeline(pieces=pieces, gaps=gaps)


def materialize(tl: Timeline, start: float, end: float, work_dir: Path, *, key: str = "excerpt") -> tuple[Path, float]:
    """Liefert (Datei, Verschiebung), aus der der Bereich [start, end] geschnitten werden kann.

    Liegt alles in einer Datei (zusammengesetzte Aufnahme/Upload): diese Datei, Verschiebung 0.
    Sonst werden die betroffenen ganzen Segmente verlustfrei aneinandergehängt (exakte Offsets).
    """
    pieces = [p for p in tl.pieces if p.offset_end > start - 2 and p.offset < end + 2]
    if not pieces:
        raise FileNotFoundError(f"Kein Material für {start:.1f}–{end:.1f}s")
    paths = {p.path for p in pieces}
    if len(paths) == 1 and len(tl.pieces) >= 1 and all(p.path == pieces[0].path for p in tl.pieces):
        return Path(pieces[0].path), 0.0
    if len(pieces) == 1:
        return Path(pieces[0].path), pieces[0].offset
    work_dir.mkdir(parents=True, exist_ok=True)
    out = work_dir / f"{key}_{int(pieces[0].offset)}_{int(pieces[-1].offset_end)}.ts"
    lst = work_dir / f"{key}.txt"
    lst.write_text("".join(f"file '{Path(p.path).resolve().as_posix()}'\n" for p in pieces))
    ffmpeg.run(["-f", "concat", "-safe", "0", "-i", str(lst), "-map", "0:v?", "-map", "0:a?", "-c", "copy", "-f", "mpegts", str(out)], timeout=600)
    lst.unlink(missing_ok=True)
    return out, pieces[0].offset
