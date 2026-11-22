"""Rendering hochkant (1080x1920) mit ffmpeg.

* Layout ``blur``: unscharfer, abgedunkelter Hintergrund, Stream mittig.
* Layout ``facecam_top``: Facecam-Ausschnitt oben, Gameplay unten (Rechteck aus den Kanal-Settings).
* Untertitel als ASS (echte Pixel) oder SRT mit umgerechnetem force_style.
* Lautheit normalisiert (loudnorm, −14 LUFS), kurze Ein-/Ausblendung gegen Knackser (loop-fähig).
* NVENC, wenn eine GPU da ist, sonst x264. Vorschau in 540x960.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Sequence

from . import ffmpeg
from .subtitles import SubtitleStyle, Word, build_ass, build_srt, filter_path_escape, srt_force_style

log = logging.getLogger(__name__)

FINAL_SIZE = (1080, 1920)
PREVIEW_SIZE = (540, 960)


@dataclass
class RenderSpec:
    source: Path
    cuts: Sequence[tuple[float, float]]  # Quell-Zeitbereiche, werden aneinandergehängt
    out_path: Path
    words: Sequence[Word] = field(default_factory=list)  # relativ zum Ausgangsvideo
    hook_text: str | None = None
    context_line: str | None = None
    subtitle_lines: Sequence[str] | None = None
    layout: str = "blur"
    facecam_rect: dict | None = None  # {x,y,w,h} als Anteile 0..1 der Quelle
    preview: bool = False
    subtitle_style: str = "ass"  # ass | srt
    loudnorm: bool = True
    source_size: tuple[int, int] | None = None

    @property
    def duration(self) -> float:
        return float(sum(e - s for s, e in self.cuts))


def _layout_filter(layout: str, W: int, H: int, src_w: int, src_h: int, facecam: dict | None) -> str:
    """Filter von [vin] nach [vl]."""
    if src_w and src_h and src_h >= src_w:
        # Quelle ist schon hochkant: füllen und zuschneiden
        return f"[vin]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1[vl]"
    if layout == "facecam_top" and facecam:
        fx, fy = float(facecam.get("x", 0)), float(facecam.get("y", 0))
        fw, fh = float(facecam.get("w", 0.25)), float(facecam.get("h", 0.25))
        top_h = int(round(H * 0.36 / 2) * 2)
        bot_h = H - top_h
        aspect = W / bot_h
        return (
            "[vin]split=2[cam][game];"
            f"[cam]crop=iw*{fw:.4f}:ih*{fh:.4f}:iw*{fx:.4f}:ih*{fy:.4f},"
            f"scale={W}:{top_h}:force_original_aspect_ratio=increase,crop={W}:{top_h},setsar=1[camv];"
            f"[game]crop='min(iw,ih*{aspect:.5f})':ih,scale={W}:{bot_h}:force_original_aspect_ratio=increase,"
            f"crop={W}:{bot_h},setsar=1[gamev];"
            "[camv][gamev]vstack=inputs=2[vl]"
        )
    bw, bh = max(2, W // 4 // 2 * 2), max(2, H // 4 // 2 * 2)
    return (
        "[vin]split=2[bgsrc][fgsrc];"
        f"[bgsrc]scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh},"
        f"boxblur=12:3,scale={W}:{H},eq=brightness=-0.07:saturation=1.15,setsar=1[bg];"
        f"[fgsrc]scale={W}:-2,setsar=1[fg];"
        "[bg][fg]overlay=(W-w)/2:(H-h)/2[vl]"
    )


def render(spec: RenderSpec, *, on_progress: Callable[[float], None] | None = None, style: SubtitleStyle | None = None) -> Path:
    if not spec.cuts:
        raise ValueError("Keine Schnittbereiche")
    W, H = PREVIEW_SIZE if spec.preview else FINAL_SIZE
    spec.out_path.parent.mkdir(parents=True, exist_ok=True)
    src_w, src_h = spec.source_size or (0, 0)
    if not src_w:
        info = ffmpeg.probe(spec.source)
        src_w, src_h = info.width, info.height
        has_audio = info.has_audio
    else:
        has_audio = True
    duration = spec.duration

    args: list[str] = []
    for s, e in spec.cuts:
        args += ["-ss", f"{max(0.0, s):.3f}", "-t", f"{max(0.05, e - s):.3f}", "-i", str(spec.source)]
    if not has_audio:
        args += ["-f", "lavfi", "-t", f"{duration:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]

    n = len(spec.cuts)
    parts: list[str] = []
    for i in range(n):
        parts.append(f"[{i}:v]setpts=PTS-STARTPTS,fps=30[v{i}]")
        if has_audio:
            parts.append(f"[{i}:a]asetpts=PTS-STARTPTS,aresample=48000[a{i}]")
    if n > 1:
        if has_audio:
            parts.append("".join(f"[v{i}][a{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=1[vin][ain0]")
        else:
            parts.append("".join(f"[v{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[vin]")
            parts.append(f"[{n}:a]anull[ain0]")
    else:
        parts.append("[v0]null[vin]")
        parts.append("[a0]anull[ain0]" if has_audio else f"[{n}:a]anull[ain0]")
    parts.append(_layout_filter(spec.layout, W, H, src_w, src_h, spec.facecam_rect))

    sub_file: Path | None = None
    if spec.words or spec.hook_text or spec.context_line:
        if spec.subtitle_style == "srt":
            sub_file = spec.out_path.with_suffix(".srt")
            sub_file.write_text(build_srt(list(spec.words), duration=duration, lines=spec.subtitle_lines), encoding="utf-8")
            fs = srt_force_style(1920).replace(",", r"\,")
            parts.append(f"[vl]subtitles='{filter_path_escape(str(sub_file))}':force_style='{fs}',format=yuv420p[vout]")
        else:
            sub_file = spec.out_path.with_suffix(".ass")
            sub_file.write_text(
                build_ass(
                    list(spec.words),
                    duration=duration,
                    style=style,
                    hook_text=spec.hook_text,
                    context_line=spec.context_line,
                    lines=spec.subtitle_lines,
                ),
                encoding="utf-8",
            )
            parts.append(f"[vl]ass='{filter_path_escape(str(sub_file))}',format=yuv420p[vout]")
    else:
        parts.append("[vl]format=yuv420p[vout]")

    afilters = []
    if spec.loudnorm:
        afilters.append("loudnorm=I=-14:TP=-1.5:LRA=11")
    fade_out = max(0.0, duration - 0.08)
    afilters += ["afade=t=in:d=0.04", f"afade=t=out:st={fade_out:.3f}:d=0.08", "aresample=48000"]
    parts.append(f"[ain0]{','.join(afilters)}[aout]")

    filter_complex = ";".join(parts)
    out_tmp = spec.out_path.with_name(spec.out_path.stem + ".tmp.mp4")
    args += [
        "-filter_complex", filter_complex,
        "-map", "[vout]", "-map", "[aout]",
        *ffmpeg.video_encoder_args(preview=spec.preview),
        "-r", "30", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k" if spec.preview else "160k", "-ar", "48000",
        "-t", f"{duration:.3f}",
        "-movflags", "+faststart",
        str(out_tmp),
    ]
    try:
        ffmpeg.run(args, on_progress=on_progress, duration_hint=duration, timeout=max(600, duration * 30))
        out_tmp.replace(spec.out_path)
    finally:
        out_tmp.unlink(missing_ok=True)
    log.info("Gerendert: %s (%.1fs, %s)", spec.out_path.name, duration, "Vorschau" if spec.preview else "final")
    return spec.out_path


def make_thumbnail(video: Path, dst: Path, t: float = 1.0) -> Path:
    return ffmpeg.extract_frame(video, t, dst, width=360)
