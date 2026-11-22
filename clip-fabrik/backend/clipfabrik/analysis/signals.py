"""Stufe 1 der Qualitäts-Pipeline: Signal-Vorfilter.

Kandidaten entstehen nur an Momenten mit mindestens einem starken Signal:
Chat-Spitze, Lautstärke-Ausreißer, Gelächter, Stille nach Pointe, Wortwiederholung,
Reaktionswörter, Sub-/Raid-/Bits-Events, Mod-Aktionen, manuelle Marker.
Nur diese Fenster gehen später an Claude (spart Kosten und erhöht die Trefferquote).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Sequence

import numpy as np

from .audio import AudioAnalysis, zscores
from .chat import ChatSeries
from .transcribe import TWord

REACTION_PHRASES = [
    "ach du scheiße", "ach du kacke", "oh mein gott", "was zur hölle", "was zum teufel", "nicht dein ernst",
    "ist nicht wahr", "ich kann nicht mehr", "ich sterbe", "ich raste aus", "bist du dumm", "wie geil",
    "lass mich", "ne oder", "nein nein nein", "auf keinen fall", "das gibt's nicht", "das gibts nicht",
]
REACTION_WORDS = {
    "alter", "digga", "diggah", "krass", "junge", "wtf", "boah", "uff", "nein", "was", "hä", "omg", "hilfe",
    "safe", "brutal", "geil", "lol", "lmao", "wow", "wallah", "bruder", "nice", "scheiße", "fuck", "kacke",
}
LAUGH_TOKENS = re.compile(r"\b(ha(ha)+|he(he)+|hi(hi)+|lach\w*|\[lachen\]|\(lacht\))\b", re.I)
_NORM = re.compile(r"[^\wäöüß']+", re.I)

CHAT_LAG = 6.0  # Chat reagiert typischerweise einige Sekunden nach dem Moment


@dataclass
class Signal:
    type: str
    t: float  # Offset im Video
    strength: float
    detail: str = ""
    before: float | None = None  # eigene Fensterbreite (z. B. manueller Marker mit Rückblick)
    after: float | None = None

    def to_dict(self) -> dict:
        return {"type": self.type, "t": round(self.t, 1), "strength": round(self.strength, 2), "detail": self.detail}


@dataclass
class Window:
    start: float
    end: float
    anchor: float
    signals: list[Signal] = field(default_factory=list)

    @property
    def strength(self) -> float:
        if not self.signals:
            return 0.0
        types = {s.type for s in self.signals}
        best = max(s.strength for s in self.signals)
        # Bonus, wenn mehrere unterschiedliche Signale zusammenkommen
        return round(best + 0.6 * (len(types) - 1), 2)

    def summary(self) -> str:
        return ", ".join(f"{s.type}{f' ({s.detail})' if s.detail else ''}" for s in sorted(self.signals, key=lambda s: -s.strength)[:5])

    def to_dict(self) -> dict:
        return {
            "start": round(self.start, 2), "end": round(self.end, 2), "anchor": round(self.anchor, 2),
            "strength": self.strength, "signals": [s.to_dict() for s in self.signals],
        }


def _norm(w: str) -> str:
    return _NORM.sub("", w.lower())


def transcript_signals(words: Sequence[TWord]) -> list[Signal]:
    sigs: list[Signal] = []
    norm = [_norm(w.text) for w in words]
    # Wortwiederholungen (gleiches Wort ≥3x in 6 s, z. B. „nein nein nein“)
    for i, w in enumerate(norm):
        if len(w) < 2:
            continue
        j = i
        count = 1
        while j + 1 < len(words) and words[j + 1].start - words[i].start <= 6.0:
            j += 1
            if norm[j] == w:
                count += 1
        if count >= 3 and (i == 0 or norm[i - 1] != w):
            sigs.append(Signal("wiederholung", words[i].start, 1.6 + 0.3 * (count - 3), f"„{w}“ x{count}"))
    # Reaktionswörter / -phrasen
    text_stream = " ".join(norm)
    positions = []
    acc = 0
    for w in norm:
        positions.append(acc)
        acc += len(w) + 1
    for phrase in REACTION_PHRASES:
        start = 0
        while (k := text_stream.find(phrase, start)) >= 0:
            idx = max(0, np.searchsorted(positions, k, side="right") - 1)
            sigs.append(Signal("reaktion", words[idx].start, 2.2, f"„{phrase}“"))
            start = k + len(phrase)
    for i, w in enumerate(norm):
        if w in REACTION_WORDS:
            nearby = sum(1 for k in range(max(0, i - 6), min(len(norm), i + 7)) if norm[k] in REACTION_WORDS)
            if nearby >= 2:
                sigs.append(Signal("reaktion", words[i].start, 1.2 + 0.2 * min(nearby, 5), f"„{w}“"))
        if LAUGH_TOKENS.search(words[i].text):
            sigs.append(Signal("gelächter", words[i].start, 1.8, "im Transkript"))
    return sigs


def audio_signals(aa: AudioAnalysis, words: Sequence[TWord]) -> list[Signal]:
    sigs: list[Signal] = []
    if not aa.loudness_db:
        return sigs
    z = zscores(aa.loudness_db, window=180)
    for t in range(1, len(z) - 1):
        if z[t] >= 2.3 and z[t] >= z[t - 1] and z[t] >= z[t + 1] and aa.loudness_db[t] > -30:
            sigs.append(Signal("lautstärke", float(t), min(4.0, 1.0 + z[t] / 2), f"+{z[t]:.1f}σ"))
    lg = np.asarray(aa.laughter)
    t = 0
    while t < len(lg):
        if lg[t] >= 0.55:
            e = t
            while e < len(lg) and lg[e] >= 0.4:
                e += 1
            if e - t >= 2:
                sigs.append(Signal("gelächter", float(t), min(3.5, 1.5 + 0.4 * (e - t)), f"{e - t}s"))
            t = e
        else:
            t += 1
    # Stille nach Pointe: ≥1,2 s Stille direkt nach lautem/gesprochenem Abschnitt
    word_ends = np.array([w.end for w in words]) if words else np.array([])
    for s, e in aa.silences:
        if e - s < 1.2 or s < 3:
            continue
        before = aa.mean_db(s - 3, s)
        spoke = word_ends.size and np.any((word_ends > s - 2.0) & (word_ends <= s + 0.3))
        if before > -28 and spoke:
            sigs.append(Signal("stille_nach_pointe", float(s), 1.6, f"{e - s:.1f}s Pause"))
    return sigs


def chat_signals(series: ChatSeries, wall_to_offset, *, lag: float = CHAT_LAG) -> list[Signal]:
    sigs: list[Signal] = []
    if len(series.rate) == 0:
        return sigs
    inten = series.intensity()
    for i in range(1, len(inten) - 1):
        if inten[i] >= 3.0 and inten[i] >= inten[i - 1] and inten[i] >= inten[i + 1] and series.rate[max(0, i - 3):i + 3].sum() >= 6:
            off = wall_to_offset(series.start + i - lag)
            if off is None:
                continue
            emote = float(series.emote[max(0, i - 3):i + 3].mean())
            detail = f"{int(series.rate[max(0, i - 3):i + 3].sum())} Nachr./6s" + (", Emote-Spam" if emote > 0.4 else "")
            sigs.append(Signal("chat", off, min(5.0, 1.5 + inten[i] / 2.5), detail))
        if series.events[i] >= 2.5:
            off = wall_to_offset(series.start + i - 2)
            if off is not None:
                sigs.append(Signal("event", off, min(4.0, 1.0 + series.events[i] / 3), "Sub/Raid/Bits"))
        if series.mod_actions[max(0, i - 5):i + 5].sum() >= 3 and series.mod_actions[i] > 0:
            off = wall_to_offset(series.start + i - lag)
            if off is not None:
                sigs.append(Signal("mod_aktion", off, 1.3, "Timeouts/Bans gehäuft"))
    return sigs


def build_windows(
    signals: Sequence[Signal],
    duration: float,
    *,
    before: float = 32.0,
    after: float = 18.0,
    merge_gap: float = 20.0,
    min_strength: float = 1.5,
    max_per_hour: int = 40,
    hard_cap: int | None = None,
) -> list[Window]:
    """Fasst Signale zu Kandidatenfenstern zusammen und begrenzt deren Zahl (Kostenkontrolle)."""
    strong = sorted((s for s in signals if s.strength >= min_strength), key=lambda s: s.t)
    windows: list[Window] = []
    for s in strong:
        b = s.before if s.before is not None else before
        a = s.after if s.after is not None else after
        if windows and s.t - windows[-1].anchor <= merge_gap:
            w = windows[-1]
            w.signals.append(s)
            if s.strength > max(x.strength for x in w.signals[:-1]):
                w.anchor = s.t
            w.end = min(duration, max(w.end, s.t + a))
            w.start = max(0.0, min(w.start, s.t - b))
        else:
            windows.append(Window(start=max(0.0, s.t - b), end=min(duration, s.t + a), anchor=s.t, signals=[s]))
    # Begrenzen: pro Stunde die stärksten
    cap = max(4, int(max_per_hour * max(duration, 1) / 3600 + 0.999))
    if hard_cap:
        cap = min(cap, hard_cap)
    if len(windows) > cap:
        # Marker-Fenster werden nie verworfen
        keep = sorted(windows, key=lambda w: (not any(x.type == "marker" for x in w.signals), -w.strength))[:cap]
        windows = sorted(keep, key=lambda w: w.start)
    return windows


def marker_signals(marker_offsets: Sequence[tuple[float, float, str]]) -> list[Signal]:
    """Manuelle Marker (Offset, Rückblick, Quelle) sind immer starke Signale."""
    return [
        Signal("marker", off - lookback / 2, 9.0, src, before=lookback / 2 + 4, after=lookback / 2 + 4)
        for off, lookback, src in marker_offsets
    ]
