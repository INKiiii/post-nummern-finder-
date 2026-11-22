"""Automatischer Render-Test: Untertitel müssen sichtbar, richtig groß und richtig platziert sein.

Hintergrund (libass): SRT-Untertitel werden in PlayResY=288 gerechnet. FontSize/MarginV im
force_style beziehen sich auf 288 Pixel Höhe. Der Test rendert echte Frames und prüft die
Pixel – so fällt ein falscher Wert (z. B. FontSize=60) sofort auf.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from clipfabrik.media.subtitles import SubtitleStyle, Word, build_ass, build_srt, filter_path_escape, srt_force_style

W, H = 1080, 1920


def _frame(tmp: Path, vf: str | None, size: tuple[int, int] = (W, H), t: float = 1.0, name: str = "f") -> np.ndarray:
    out = tmp / f"{name}.png"
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"color=c=0x404040:s={size[0]}x{size[1]}:d=3:r=10",
           "-ss", str(t), "-frames:v", "1"]
    if vf:
        cmd += ["-vf", vf]
    cmd.append(str(out))
    subprocess.run(cmd, check=True)
    return np.asarray(Image.open(out).convert("RGB")).astype(int)


def _bbox(with_subs: np.ndarray, without: np.ndarray) -> tuple[int, int, int, int, int]:
    """Bounding-Box der geänderten Pixel: (x0, y0, x1, y1, Anzahl)."""
    diff = np.abs(with_subs - without).sum(axis=2) > 60
    ys, xs = np.nonzero(diff)
    if len(ys) == 0:
        return (0, 0, 0, 0, 0)
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()), int(diff.sum())


WORDS = [Word("Das", 0.5, 0.8), Word("war", 0.8, 1.1), Word("krass!", 1.1, 1.6), Word("Echt", 1.8, 2.0)]


def test_srt_force_style_values_for_1080x1920():
    style = srt_force_style(1920)
    assert "FontSize=11" in style
    assert "MarginV=45" in style


def test_ass_subtitles_visible_and_sized(tmp_path: Path):
    ass = tmp_path / "s.ass"
    ass.write_text(build_ass(WORDS, duration=3.0), encoding="utf-8")
    base = _frame(tmp_path, None, name="base")
    subbed = _frame(tmp_path, f"ass='{filter_path_escape(str(ass))}'", name="ass")
    x0, y0, x1, y1, n = _bbox(subbed, base)
    assert n > 2000, "Untertitel nicht sichtbar"
    height = y1 - y0
    st = SubtitleStyle()
    # Glyphenhöhe inkl. Outline: grob 0,7–1,6 × FontSize
    assert 0.6 * st.font_size <= height <= 1.8 * st.font_size, f"Höhe {height}px passt nicht zu FontSize {st.font_size}"
    assert 0 < x0 and x1 < W - 1, "Untertitel ragen seitlich aus dem Bild"
    bottom_margin = H - y1
    assert abs(bottom_margin - st.margin_v) < 80, f"Abstand unten {bottom_margin}px statt ~{st.margin_v}px"
    # Highlight-Wort ist gelb (R und G hoch, B niedrig)
    region = subbed[y0:y1 + 1, x0:x1 + 1]
    yellow = (region[:, :, 0] > 200) & (region[:, :, 1] > 180) & (region[:, :, 2] < 90)
    assert yellow.sum() > 200, "Highlight-Wort fehlt"


def test_ass_scales_for_540p_preview(tmp_path: Path):
    ass = tmp_path / "s.ass"
    ass.write_text(build_ass(WORDS, duration=3.0), encoding="utf-8")
    full = _bbox(_frame(tmp_path, f"ass='{filter_path_escape(str(ass))}'", name="a1"), _frame(tmp_path, None, name="b1"))
    small = _bbox(_frame(tmp_path, f"ass='{filter_path_escape(str(ass))}'", size=(540, 960), name="a2"),
                  _frame(tmp_path, None, size=(540, 960), name="b2"))
    h_full, h_small = full[3] - full[1], small[3] - small[1]
    assert small[4] > 300
    assert 0.35 < h_small / h_full < 0.65, "Vorschau skaliert die Untertitel nicht mit"


def test_srt_with_correct_libass_units(tmp_path: Path):
    srt = tmp_path / "s.srt"
    srt.write_text(build_srt(WORDS, duration=3.0), encoding="utf-8")
    style = srt_force_style(1920).replace(",", r"\,")
    vf = f"subtitles='{filter_path_escape(str(srt))}':force_style='{style}'"
    x0, y0, x1, y1, n = _bbox(_frame(tmp_path, vf, name="srt"), _frame(tmp_path, None, name="base"))
    assert n > 2000, "SRT-Untertitel nicht sichtbar"
    assert 45 <= y1 - y0 <= 140, f"SRT-Text {y1 - y0}px hoch – FontSize falsch umgerechnet?"
    assert 220 <= H - y1 <= 380, f"Abstand unten {H - y1}px statt ~300px (MarginV=45 in 288er-Einheiten)"
    assert x0 > 0 and x1 < W - 1


def test_wrong_srt_font_size_is_detected(tmp_path: Path):
    """Gegenprobe: FontSize=60 (in Pixel gedacht) ergibt riesige Buchstaben – genau den bekannten Fehler."""
    srt = tmp_path / "s.srt"
    srt.write_text(build_srt(WORDS, duration=3.0), encoding="utf-8")
    vf = f"subtitles='{filter_path_escape(str(srt))}':force_style='FontSize=60\\,MarginV=45\\,Outline=2'"
    x0, y0, x1, y1, n = _bbox(_frame(tmp_path, vf, name="bad"), _frame(tmp_path, None, name="base"))
    too_big = (y1 - y0) > 250 or x0 <= 1 or x1 >= W - 2
    assert too_big, "Gegenprobe: falsche Schriftgröße hätte auffallen müssen"


@pytest.mark.parametrize("lines", [None, ["DAS WAR", "ECHT"]])
def test_build_ass_structure(lines):
    ass = build_ass(WORDS, duration=3.0, hook_text="Er hat es nicht kommen sehen", lines=lines)
    assert "PlayResX: 1080" in ass and "PlayResY: 1920" in ass
    assert "ER HAT ES NICHT KOMMEN SEHEN" in ass
    dialogues = [ln for ln in ass.splitlines() if ln.startswith("Dialogue: 1")]
    assert dialogues, "keine Wort-Events"
    assert all(ln.split(",", 9)[9].upper() == ln.split(",", 9)[9] or "\\c" in ln for ln in dialogues)
