"""Aufnahme aus dem öffentlichen Stream: streamlink -> ffmpeg-Segmenter (MPEG-TS, 2-Minuten-Segmente).

* MPEG-TS-Segmente überleben Abstürze (kein Index am Dateiende nötig).
* Bricht die Verbindung ab, wird automatisch neu verbunden (neuer „Run“), die Lücke wird markiert.
* streamlink filtert Twitch-Werbung heraus; erkannte Werbepausen werden als Lückengrund gemerkt.
* Abo-only-Streams: klare Meldung statt Absturz.
"""

from __future__ import annotations

import csv
import datetime as dt
import logging
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

log = logging.getLogger(__name__)


@dataclass
class SegmentInfo:
    run: int
    idx: int
    path: Path
    wall_start: float
    duration: float
    complete: bool


@dataclass
class RecorderEvent:
    kind: str  # segment | ad | reconnect | unrecordable | error | stopped
    message: str = ""
    wall: float = field(default_factory=time.time)
    segment: SegmentInfo | None = None


def streamlink_cmd(url: str, quality: str = "best") -> list[str]:
    exe = shutil.which("streamlink")
    base = [exe] if exe else [sys.executable, "-m", "streamlink"]
    return base + [
        "--stdout", "--loglevel", "info",
        "--retry-streams", "5", "--retry-open", "3",
        "--stream-segment-attempts", "5", "--stream-segment-timeout", "20",
        "--hls-live-edge", "3",
        url, f"{quality},best",
    ]


def segmenter_cmd(out_pattern: str, list_file: str, segment_seconds: int) -> list[str]:
    return [
        shutil.which("ffmpeg") or "ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin",
        "-fflags", "+genpts+discardcorrupt", "-i", "pipe:0",
        "-map", "0:v?", "-map", "0:a?", "-c", "copy",
        "-f", "segment", "-segment_time", str(segment_seconds), "-segment_format", "mpegts",
        "-reset_timestamps", "1", "-segment_list", list_file, "-segment_list_type", "csv",
        "-segment_list_flags", "+live", out_pattern,
    ]


class Recorder:
    def __init__(self, *, url: str, out_dir: Path, segment_seconds: int = 120,
                 on_event: Callable[[RecorderEvent], None], still_live: Callable[[], bool] | None = None,
                 quality: str = "best") -> None:
        self.url = url
        self.out_dir = out_dir
        self.segment_seconds = segment_seconds
        self.on_event = on_event
        self.still_live = still_live or (lambda: True)
        self.quality = quality
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._procs: tuple[subprocess.Popen, subprocess.Popen] | None = None
        self.run_index = 0
        self.active = False
        self.unrecordable = False
        self.segments_done = 0

    def start(self) -> None:
        self.out_dir.mkdir(parents=True, exist_ok=True)
        existing = sorted(self.out_dir.glob("list_r*.csv"))
        self.run_index = len(existing)
        self._thread = threading.Thread(target=self._loop, name=f"rec-{self.out_dir.parent.name}", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 30.0) -> None:
        self._stop.set()
        self._terminate()
        if self._thread:
            self._thread.join(timeout=timeout)

    def _terminate(self) -> None:
        if not self._procs:
            return
        sl, ff = self._procs
        try:
            if sl.poll() is None:
                sl.send_signal(signal.SIGINT)
        except ProcessLookupError:
            pass

    # --------------------------------------------------------------------------------
    def _loop(self) -> None:
        backoff = 3.0
        while not self._stop.is_set():
            started = time.time()
            reason = self._run_once(self.run_index)
            self.run_index += 1
            if self._stop.is_set():
                break
            if self.unrecordable:
                self.on_event(RecorderEvent("unrecordable", reason or "Stream nicht aufnehmbar"))
                break
            if not self.still_live():
                break
            if time.time() - started > 120:
                backoff = 3.0
            self.on_event(RecorderEvent("reconnect", f"Verbindung weg ({reason}), neuer Versuch in {backoff:.0f}s"))
            self._stop.wait(backoff)
            backoff = min(60.0, backoff * 2)
        self.active = False
        self.on_event(RecorderEvent("stopped", "Aufnahme beendet"))

    def _run_once(self, run: int) -> str:
        list_file = self.out_dir / f"list_r{run:02d}.csv"
        pattern = str(self.out_dir / f"seg_r{run:02d}_%05d.ts")
        sl = subprocess.Popen(streamlink_cmd(self.url, self.quality), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              start_new_session=True)
        ff = subprocess.Popen(segmenter_cmd(pattern, str(list_file), self.segment_seconds), stdin=sl.stdout,
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
        assert sl.stdout is not None
        sl.stdout.close()  # ffmpeg besitzt jetzt die Pipe
        self._procs = (sl, ff)
        self.active = True
        last_reason = ""
        errlines: list[str] = []

        def read_streamlink_log() -> None:
            nonlocal last_reason
            assert sl.stderr is not None
            for raw in sl.stderr:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                errlines.append(line)
                low = line.lower()
                if "advertisement" in low or "ad break" in low or "pre-roll" in low or "ad segments" in low:
                    self.on_event(RecorderEvent("ad", line))
                if "subscribers only" in low or "subscriber-only" in low or "sub-only" in low:
                    self.unrecordable = True
                    last_reason = "Abo-only-Stream: öffentlich nicht aufnehmbar"
                elif "no playable streams" in low or "could not find" in low:
                    last_reason = "keine abspielbaren Streams (offline?)"
                elif "error" in low:
                    last_reason = line[-200:]
                log.debug("streamlink: %s", line)

        reader = threading.Thread(target=read_streamlink_log, daemon=True)
        reader.start()

        seen_rows = 0
        current_idx = 0
        first_seen: float | None = None
        last_complete_wall: float | None = None
        while True:
            # neue fertige Segmente aus der CSV-Liste übernehmen
            if list_file.exists():
                rows = self._read_list(list_file)
                for row in rows[seen_rows:]:
                    name, start_t, end_t = row
                    dur = max(0.0, end_t - start_t)
                    # Ende = letzter Schreibzeitpunkt der Datei (nicht der Moment, in dem ffmpeg sie schließt:
                    # nach einem Verbindungsabbruch wäre das zu spät und die Lücke verschwände)
                    wall_start = self._last_write(self.out_dir / name) - dur
                    if last_complete_wall is not None and abs(wall_start - last_complete_wall) < 3:
                        wall_start = last_complete_wall
                    last_complete_wall = wall_start + dur
                    idx = int(name.rsplit("_", 1)[1].split(".")[0])
                    info = SegmentInfo(run, idx, self.out_dir / name, wall_start, dur, True)
                    self.segments_done += 1
                    current_idx = idx + 1
                    self.on_event(RecorderEvent("segment", f"Segment {name}", segment=info))
                seen_rows = len(rows)
            # laufendes Segment melden (für Live-Analyse)
            cur = self.out_dir / f"seg_r{run:02d}_{current_idx:05d}.ts"
            if cur.exists() and cur.stat().st_size > 0:
                if first_seen is None:
                    first_seen = time.time()
                start = last_complete_wall if last_complete_wall is not None else first_seen
                self.on_event(RecorderEvent("segment", "laufend", segment=SegmentInfo(run, current_idx, cur, start, 0.0, False)))
            if ff.poll() is not None:
                break
            if self._stop.wait(2.0):
                # Stop: streamlink beenden, ffmpeg schließt das letzte Segment sauber ab
                self._terminate()
                try:
                    ff.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    ff.terminate()
                if list_file.exists():
                    rows = self._read_list(list_file)
                    for row in rows[seen_rows:]:
                        name, start_t, end_t = row
                        dur = max(0.0, end_t - start_t)
                        wall_start = self._last_write(self.out_dir / name) - dur
                        if last_complete_wall is not None and abs(wall_start - last_complete_wall) < 3:
                            wall_start = last_complete_wall
                        last_complete_wall = wall_start + dur
                        idx = int(name.rsplit("_", 1)[1].split(".")[0])
                        self.on_event(RecorderEvent("segment", f"Segment {name}",
                                                    segment=SegmentInfo(run, idx, self.out_dir / name, wall_start, dur, True)))
                    seen_rows = len(rows)
                break
        for p in (sl, ff):
            if p.poll() is None:
                try:
                    os.killpg(p.pid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    p.terminate()
                try:
                    p.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    p.kill()
        reader.join(timeout=5)
        self._procs = None
        if ff.returncode not in (0, None) and not last_reason:
            err = (ff.stderr.read().decode("utf-8", "replace")[-300:] if ff.stderr else "")
            last_reason = f"ffmpeg Code {ff.returncode}: {err}"
        return last_reason or (errlines[-1][-200:] if errlines else "Stream-Ende")

    @staticmethod
    def _last_write(path: Path) -> float:
        try:
            return path.stat().st_mtime
        except OSError:
            return time.time()

    @staticmethod
    def _read_list(path: Path) -> list[tuple[str, float, float]]:
        rows: list[tuple[str, float, float]] = []
        try:
            with open(path, newline="") as f:
                for r in csv.reader(f):
                    if len(r) >= 3:
                        try:
                            rows.append((r[0], float(r[1]), float(r[2])))
                        except ValueError:
                            continue
        except OSError:
            pass
        return rows


def wall_to_dt(w: float) -> dt.datetime:
    return dt.datetime.fromtimestamp(w, dt.UTC).replace(tzinfo=None)
