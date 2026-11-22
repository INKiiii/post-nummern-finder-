"""Untertitel: Wort für Wort in Großbuchstaben mit Highlight-Wort.

Bekannter Stolperstein (libass):
    SRT-Untertitel haben kein eigenes Koordinatensystem. ffmpeg wandelt sie intern in ASS um,
    und libass rechnet dann in der Standard-Auflösung PlayResX=384 / PlayResY=288.
    ``FontSize`` und ``MarginV`` im ``force_style`` beziehen sich also auf 288 Pixel Höhe,
    nicht auf 1920. FontSize=60 wäre auf 1080x1920 ein ~400 px hoher Buchstabe (aus dem Bild),
    richtig sind FontSize≈11 (≈73 px) und MarginV≈45 (≈300 px Abstand nach unten).

Lösung hier:
    * Hauptweg: eigene ASS-Datei mit ``PlayResX=1080`` / ``PlayResY=1920``. Dann sind alle Werte
      echte Pixel, und libass skaliert für die 540p-Vorschau automatisch mit.
    * Fallback ``srt``: ``force_style`` mit umgerechneten Werten (``srt_force_style``).
Der Test ``test_subtitles_render.py`` rendert ein Frame und prüft Sichtbarkeit, Größe und Lage.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Sequence

LIBASS_DEFAULT_PLAYRES_Y = 288
LIBASS_DEFAULT_PLAYRES_X = 384


@dataclass
class Word:
    text: str
    start: float
    end: float

    @classmethod
    def from_dict(cls, d: dict) -> "Word":
        return cls(text=str(d.get("text", d.get("word", ""))).strip(), start=float(d["start"]), end=float(d["end"]))

    def to_dict(self) -> dict:
        return {"text": self.text, "start": round(self.start, 3), "end": round(self.end, 3)}


@dataclass
class SubtitleStyle:
    width: int = 1080
    height: int = 1920
    font: str = "DejaVu Sans"
    font_size: int = 78  # Pixel bei 1920 Höhe
    outline: int = 6
    shadow: int = 2
    margin_v: int = 520  # Abstand vom unteren Rand (Pixel), über der TikTok-/Reels-Leiste
    primary: str = "&H00FFFFFF"  # weiß  (ASS: &HAABBGGRR)
    highlight: str = "&H0000E5FF"  # gelb
    outline_color: str = "&H00000000"
    max_words: int = 3
    max_chars: int = 18
    hook_font_size: int = 58
    hook_margin_v: int = 250


def _ass_escape(text: str) -> str:
    return text.replace("\\", "＼").replace("{", "(").replace("}", ")").replace("\n", " ")


def fmt_ass_time(t: float) -> str:
    t = max(0.0, t)
    cs = int(round(t * 100))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def fmt_srt_time(t: float) -> str:
    t = max(0.0, t)
    ms = int(round(t * 1000))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


_PUNCT_END = re.compile(r"[.!?…,;:]$")


def chunk_words(words: Sequence[Word], max_words: int = 3, max_chars: int = 18, pause: float = 0.45) -> list[list[Word]]:
    """Gruppiert Wörter zu kurzen Zeilen (max. 3 Wörter), Umbruch an Satzzeichen und Pausen."""
    chunks: list[list[Word]] = []
    cur: list[Word] = []
    for i, w in enumerate(words):
        if not w.text:
            continue
        if cur:
            gap = w.start - cur[-1].end
            text_len = sum(len(x.text) + 1 for x in cur) + len(w.text)
            if len(cur) >= max_words or text_len > max_chars or gap > pause or _PUNCT_END.search(cur[-1].text):
                chunks.append(cur)
                cur = []
        cur.append(w)
    if cur:
        chunks.append(cur)
    return chunks


def build_ass(
    words: Sequence[Word],
    *,
    duration: float,
    style: SubtitleStyle | None = None,
    hook_text: str | None = None,
    hook_duration: float = 2.6,
    context_line: str | None = None,
    lines: Sequence[str] | None = None,
) -> str:
    """Erzeugt ASS mit echter Auflösung (PlayRes = Videogröße).

    ``lines``: vom Nutzer bearbeitete Untertitel-Zeilen (überschreiben den Text pro Chunk,
    Zeitpunkte bleiben aus der Transkription).
    """
    st = style or SubtitleStyle()
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {st.width}
PlayResY: {st.height}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Word,{st.font},{st.font_size},{st.primary},{st.highlight},{st.outline_color},&H64000000,1,0,0,0,100,100,1,0,1,{st.outline},{st.shadow},2,60,60,{st.margin_v},1
Style: Hook,{st.font},{st.hook_font_size},&H00111111,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,1,0,0,0,100,100,0,0,3,18,0,8,70,70,{st.hook_margin_v},1
Style: Context,{st.font},{int(st.hook_font_size * 0.62)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,3,10,0,8,80,80,{st.hook_margin_v + st.hook_font_size + 70},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events: list[str] = []
    if hook_text:
        events.append(
            f"Dialogue: 2,{fmt_ass_time(0)},{fmt_ass_time(min(hook_duration, duration))},Hook,,0,0,0,,"
            f"{{\\fad(80,200)}}{_ass_escape(hook_text.upper())}"
        )
    if context_line:
        events.append(
            f"Dialogue: 2,{fmt_ass_time(0)},{fmt_ass_time(min(hook_duration + 0.8, duration))},Context,,0,0,0,,"
            f"{{\\fad(80,200)}}{_ass_escape(context_line)}"
        )
    chunks = chunk_words(words, st.max_words, st.max_chars)
    for ci, chunk in enumerate(chunks):
        override = None
        if lines is not None and ci < len(lines) and lines[ci] is not None:
            override = str(lines[ci]).split()
        texts = [w.text for w in chunk]
        if override is not None:
            # bearbeiteter Text: auf Wörter des Chunks verteilen (bei anderer Wortzahl ganze Zeile)
            if len(override) == len(chunk):
                texts = override
            else:
                start = chunk[0].start
                end = chunks[ci + 1][0].start if ci + 1 < len(chunks) else min(duration, chunk[-1].end + 0.6)
                end = max(end, start + 0.3)
                txt = _ass_escape(" ".join(override).upper())
                events.append(f"Dialogue: 1,{fmt_ass_time(start)},{fmt_ass_time(end)},Word,,0,0,0,,{txt}")
                continue
        chunk_end_limit = chunks[ci + 1][0].start if ci + 1 < len(chunks) else min(duration, chunk[-1].end + 0.6)
        for wi, w in enumerate(chunk):
            start = w.start if wi > 0 else chunk[0].start
            end = chunk[wi + 1].start if wi + 1 < len(chunk) else chunk_end_limit
            end = max(end, start + 0.08)
            parts = []
            for k, t in enumerate(texts):
                t = _ass_escape(t.upper())
                if k == wi:
                    parts.append(f"{{\\c{st.highlight}\\fscx108\\fscy108}}{t}{{\\c{st.primary}\\fscx100\\fscy100}}")
                else:
                    parts.append(t)
            pop = "{\\fscx92\\fscy92\\t(0,90,\\fscx100\\fscy100)}" if wi == 0 else ""
            events.append(
                f"Dialogue: 1,{fmt_ass_time(start)},{fmt_ass_time(end)},Word,,0,0,0,,{pop}{' '.join(parts)}"
            )
    return head + "\n".join(events) + "\n"


def build_srt(words: Sequence[Word], *, duration: float, lines: Sequence[str] | None = None, max_words: int = 3) -> str:
    """Einfache SRT (Fallback). Ein Eintrag pro Chunk, Großbuchstaben."""
    out: list[str] = []
    chunks = chunk_words(words, max_words)
    for i, chunk in enumerate(chunks):
        start = chunk[0].start
        end = chunks[i + 1][0].start if i + 1 < len(chunks) else min(duration, chunk[-1].end + 0.6)
        text = lines[i] if lines is not None and i < len(lines) and lines[i] else " ".join(w.text for w in chunk)
        out.append(f"{i + 1}\n{fmt_srt_time(start)} --> {fmt_srt_time(max(end, start + 0.2))}\n{text.upper()}\n")
    return "\n".join(out)


def px_to_libass_units(px: float, video_height: int) -> int:
    """Rechnet Pixel (bei ``video_height``) in libass-SRT-Einheiten (Basis 288) um."""
    return max(1, int(round(px * LIBASS_DEFAULT_PLAYRES_Y / video_height)))


def srt_force_style(video_height: int = 1920, *, font: str = "DejaVu Sans", font_px: float = 73, margin_px: float = 300, outline_px: float = 6) -> str:
    """force_style für SRT. Für 1080x1920: FontSize=11, MarginV=45 (siehe Modul-Doku)."""
    fs = px_to_libass_units(font_px, video_height)
    mv = px_to_libass_units(margin_px, video_height)
    ol = max(1, px_to_libass_units(outline_px, video_height))
    return (
        f"FontName={font},FontSize={fs},Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,"
        f"BorderStyle=1,Outline={ol},Shadow=0,Alignment=2,MarginV={mv}"
    )


def chunk_texts(words: Iterable[Word]) -> list[str]:
    """Zeilen, wie sie in der Oberfläche zum Bearbeiten angezeigt werden."""
    return [" ".join(w.text for w in c) for c in chunk_words(list(words))]


def filter_path_escape(path: str) -> str:
    """Pfad für ffmpeg-Filtergraph (ass=/subtitles=) escapen."""
    return path.replace("\\", "/").replace(":", r"\:").replace("'", r"\'").replace(",", r"\,")
