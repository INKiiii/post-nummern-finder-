"""Zeitstrahl einer Aufnahme aus Segmenten.

Die Aufnahme besteht aus 2-Minuten-Segmenten mit Wanduhr-Startzeit. Fehlen Stücke
(Verbindungsabbruch, Werbepause, Absturz), entstehen Lücken. Im zusammengesetzten Video sind
Lücken „zusammengeschoben“, Chat-Ereignisse kommen aber mit Wanduhrzeit. Diese Klasse rechnet
zwischen Wanduhr (Epoch-Sekunden) und Video-Offset (Sekunden im zusammengesetzten Video) um.
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass, field
from typing import Iterable

GAP_TOLERANCE = 3.0  # Sekunden: kleinere Abweichungen (Ankunfts-Jitter der HLS-Stücke) gelten nicht als Lücke


@dataclass
class Piece:
    offset: float  # Start im zusammengesetzten Video
    wall_start: float  # Epoch-Sekunden
    duration: float
    path: str = ""
    run: int = 0

    @property
    def wall_end(self) -> float:
        return self.wall_start + self.duration

    @property
    def offset_end(self) -> float:
        return self.offset + self.duration


@dataclass
class Gap:
    at: float  # Offset im Video, an dem die Lücke liegt
    wall_start: float
    seconds: float
    reason: str = "unbekannt"

    def to_dict(self) -> dict:
        return {"at": round(self.at, 2), "wall_start": self.wall_start, "seconds": round(self.seconds, 1), "reason": self.reason}


@dataclass
class Timeline:
    pieces: list[Piece] = field(default_factory=list)
    gaps: list[Gap] = field(default_factory=list)

    @classmethod
    def from_segments(cls, segs: Iterable[tuple[float, float, str, int]], gap_reasons: dict[int, str] | None = None) -> "Timeline":
        """``segs``: (wall_start_epoch, duration, path, run), wird nach Wanduhr sortiert."""
        items = sorted(segs, key=lambda x: x[0])
        pieces: list[Piece] = []
        gaps: list[Gap] = []
        offset = 0.0
        prev: Piece | None = None
        for wall_start, duration, path, run in items:
            if duration <= 0:
                continue
            if prev is not None:
                delta = wall_start - prev.wall_end
                if delta > GAP_TOLERANCE:
                    reason = (gap_reasons or {}).get(run) or ("Verbindungsabbruch" if run != prev.run else "Lücke im Stream")
                    gaps.append(Gap(at=offset, wall_start=prev.wall_end, seconds=delta, reason=reason))
                if delta < GAP_TOLERANCE:
                    # Wanduhr-Schätzungen schwanken: an das vorige Stück anschließen. Die Dauer bleibt
                    # unverändert, damit Offsets exakt zum zusammengesetzten Video passen.
                    wall_start = prev.wall_end
            p = Piece(offset=offset, wall_start=wall_start, duration=duration, path=path, run=run)
            pieces.append(p)
            offset += duration
            prev = p
        return cls(pieces=pieces, gaps=gaps)

    @classmethod
    def single(cls, wall_start: float, duration: float, path: str = "") -> "Timeline":
        return cls(pieces=[Piece(0.0, wall_start, duration, path)])

    @property
    def duration(self) -> float:
        return self.pieces[-1].offset_end if self.pieces else 0.0

    @property
    def wall_start(self) -> float:
        return self.pieces[0].wall_start if self.pieces else 0.0

    def wall_to_offset(self, wall: float, *, clamp: bool = True) -> float | None:
        """Wanduhr -> Video-Offset. In einer Lücke: mit clamp das Lückenende, sonst None."""
        if not self.pieces:
            return None
        starts = [p.wall_start for p in self.pieces]
        i = bisect.bisect_right(starts, wall) - 1
        if i < 0:
            return 0.0 if clamp else None
        p = self.pieces[i]
        if wall <= p.wall_end:
            return p.offset + (wall - p.wall_start)
        # nach Stück i, vor Stück i+1 -> Lücke (oder nach Ende)
        if not clamp:
            return None
        if i + 1 < len(self.pieces):
            return self.pieces[i + 1].offset
        return p.offset_end

    def offset_to_wall(self, offset: float) -> float:
        if not self.pieces:
            return 0.0
        offs = [p.offset for p in self.pieces]
        i = max(0, bisect.bisect_right(offs, offset) - 1)
        p = self.pieces[i]
        return p.wall_start + min(max(0.0, offset - p.offset), p.duration)

    def ranges_for(self, start: float, end: float) -> list[tuple[str, float, float]]:
        """Liefert (Datei, inpoint, outpoint) für einen Offset-Bereich über Segmentgrenzen hinweg."""
        out: list[tuple[str, float, float]] = []
        for p in self.pieces:
            if p.offset_end <= start or p.offset >= end:
                continue
            a = max(start, p.offset) - p.offset
            b = min(end, p.offset_end) - p.offset
            if b - a > 0.01:
                out.append((p.path, a, b))
        return out

    def gap_dicts(self) -> list[dict]:
        return [g.to_dict() for g in self.gaps]
