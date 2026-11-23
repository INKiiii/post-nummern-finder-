"""Dünne, fehlerklare Hülle um ffmpeg/ffprobe."""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Callable, Sequence

log = logging.getLogger(__name__)

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"


class FFmpegError(RuntimeError):
    def __init__(self, msg: str, stderr: str = "") -> None:
        tail = "\n".join(stderr.strip().splitlines()[-12:])
        super().__init__(f"{msg}\n{tail}" if tail else msg)
        self.stderr = stderr


@dataclass
class ProbeInfo:
    duration: float
    width: int
    height: int
    fps: float
    has_audio: bool
    has_video: bool


def run(
    args: Sequence[str],
    *,
    timeout: float | None = None,
    duration_hint: float | None = None,
    on_progress: Callable[[float], None] | None = None,
) -> str:
    """Startet ffmpeg. Mit ``on_progress`` wird ``-progress`` ausgewertet (Anteil 0..1)."""
    cmd = [FFMPEG, "-hide_banner", "-nostdin", "-y", *args]
    log.debug("ffmpeg %s", " ".join(map(str, args)))
    if on_progress and duration_hint:
        cmd = [FFMPEG, "-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", *args]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        stderr_chunks: list[str] = []

        import threading

        def _drain() -> None:
            assert proc.stderr is not None
            for line in proc.stderr:
                stderr_chunks.append(line)
                if len(stderr_chunks) > 400:
                    del stderr_chunks[:200]

        t = threading.Thread(target=_drain, daemon=True)
        t.start()
        assert proc.stdout is not None
        for line in proc.stdout:
            if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                try:
                    us = int(line.split("=", 1)[1].strip())
                    on_progress(min(1.0, us / 1_000_000 / duration_hint))
                except ValueError:
                    pass
        rc = proc.wait(timeout=timeout)
        t.join(timeout=5)
        stderr = "".join(stderr_chunks)
        if rc != 0:
            raise FFmpegError(f"ffmpeg fehlgeschlagen (Code {rc})", stderr)
        return stderr
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise FFmpegError(f"ffmpeg Zeitüberschreitung nach {timeout}s") from exc
    if res.returncode != 0:
        raise FFmpegError(f"ffmpeg fehlgeschlagen (Code {res.returncode})", res.stderr)
    return res.stderr


def probe(path: str | Path) -> ProbeInfo:
    res = subprocess.run(
        [FFPROBE, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if res.returncode != 0:
        raise FFmpegError(f"ffprobe kann {path} nicht lesen", res.stderr)
    data = json.loads(res.stdout or "{}")
    streams = data.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    dur = float(data.get("format", {}).get("duration") or 0.0)
    if not dur and v and v.get("duration"):
        dur = float(v["duration"])
    fps = 0.0
    if v and v.get("avg_frame_rate") and v["avg_frame_rate"] != "0/0":
        num, _, den = v["avg_frame_rate"].partition("/")
        fps = float(num) / float(den or 1) if float(den or 1) else 0.0
    return ProbeInfo(
        duration=dur,
        width=int(v.get("width", 0)) if v else 0,
        height=int(v.get("height", 0)) if v else 0,
        fps=fps,
        has_audio=a is not None,
        has_video=v is not None,
    )


def extract_audio(
    src: str | Path,
    dst: str | Path,
    *,
    start: float | None = None,
    duration: float | None = None,
    sample_rate: int = 16000,
    on_progress: Callable[[float], None] | None = None,
    duration_hint: float | None = None,
) -> Path:
    args: list[str] = []
    if start is not None:
        args += ["-ss", f"{start:.3f}"]
    args += ["-i", str(src)]
    if duration is not None:
        args += ["-t", f"{duration:.3f}"]
    args += ["-vn", "-ac", "1", "-ar", str(sample_rate), "-c:a", "pcm_s16le", str(dst)]
    run(args, duration_hint=duration or duration_hint, on_progress=on_progress)
    return Path(dst)


def concat_files(files: Sequence[str | Path], dst: str | Path, *, on_progress: Callable[[float], None] | None = None, duration_hint: float | None = None) -> Path:
    """Fügt Segmente verlustfrei zusammen (concat-Demuxer, -c copy)."""
    dst = Path(dst)
    lst = dst.with_suffix(".concat.txt")
    lst.write_text("".join(f"file '{Path(f).resolve().as_posix()}'\n" for f in files))
    try:
        run(
            ["-f", "concat", "-safe", "0", "-i", str(lst), "-map", "0:v?", "-map", "0:a?", "-c", "copy",
             "-fflags", "+genpts", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", str(dst)],
            on_progress=on_progress,
            duration_hint=duration_hint,
        )
    finally:
        lst.unlink(missing_ok=True)
    return dst


def extract_frame(src: str | Path, t: float, dst: str | Path, *, width: int | None = 640) -> Path:
    vf = ["-vf", f"scale={width}:-2"] if width else []
    run(["-ss", f"{max(0.0, t):.3f}", "-i", str(src), "-frames:v", "1", *vf, "-q:v", "3", str(dst)], timeout=120)
    return Path(dst)


@lru_cache(maxsize=1)
def available_encoders() -> frozenset[str]:
    try:
        res = subprocess.run([FFMPEG, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=30)
    except Exception:  # pragma: no cover
        return frozenset()
    names = set()
    for line in res.stdout.splitlines():
        m = re.match(r"\s*[VAS][\.A-Z]{5}\s+(\S+)", line)
        if m:
            names.add(m.group(1))
    return frozenset(names)


@lru_cache(maxsize=1)
def nvenc_available() -> bool:
    """NVENC nur nutzen, wenn ffmpeg es kennt UND ein Test-Encode klappt (GPU wirklich da)."""
    if "h264_nvenc" not in available_encoders():
        return False
    try:
        res = subprocess.run(
            [FFMPEG, "-hide_banner", "-nostdin", "-f", "lavfi", "-i", "color=black:s=256x256:d=0.2",
             "-c:v", "h264_nvenc", "-f", "null", "-"],
            capture_output=True,
            timeout=30,
        )
        return res.returncode == 0
    except Exception:  # pragma: no cover
        return False


def video_encoder_args(*, preview: bool = False) -> list[str]:
    if nvenc_available():
        return ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "30" if preview else "21", "-b:v", "0"]
    if preview:
        return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28"]
    return ["-c:v", "libx264", "-preset", "medium", "-crf", "20"]


def measure_loudness(path: str | Path) -> float:
    """Integrierte Lautheit (LUFS) per ebur128."""
    res = subprocess.run(
        [FFMPEG, "-hide_banner", "-nostdin", "-i", str(path), "-af", "ebur128", "-f", "null", "-"],
        capture_output=True,
        text=True,
        timeout=300,
    )
    m = re.findall(r"I:\s+(-?[\d.]+) LUFS", res.stderr)
    if not m:
        raise FFmpegError("Lautheit nicht messbar", res.stderr)
    return float(m[-1])
