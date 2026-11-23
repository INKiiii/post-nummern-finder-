"""Stufe 4: knackig verpacken.

* Start und Ende auf Wortgrenzen, nie mitten im Satz.
* Füllwörter und Leerlauf am Anfang/Ende weg.
* Länge: Ziel 10–35 s, hart 8–45 s; beim Kürzen bleibt die Pointe erhalten.
* Wörter werden in den Ausgabe-Zeitstrahl umgerechnet (auch mit Rückblick-Cut).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Sequence

from ..analysis.transcribe import TWord

LEADING_FILLERS = {"äh", "ähm", "öh", "öhm", "hm", "hmm", "mh", "also", "ja", "ok", "okay", "so", "halt", "naja", "genau", "und", "aber", "ne", "gut"}
TRAILING_FILLERS = {"äh", "ähm", "öh", "öhm", "hm", "hmm", "mh", "und", "aber", "also"}
SENTENCE_END = re.compile(r"[.!?…]$|[.!?…][\"'»“”)]$")
PAUSE = 0.45
PRE_ROLL = 0.12
POST_ROLL = 0.35


def _norm(w: str) -> str:
    return re.sub(r"[^\wäöüß]", "", w.lower())


@dataclass
class PackResult:
    start: float
    end: float
    words: list[TWord] = field(default_factory=list)  # absolute Zeiten
    too_short: bool = False
    notes: list[str] = field(default_factory=list)

    @property
    def duration(self) -> float:
        return self.end - self.start


def _is_boundary_before(words: Sequence[TWord], i: int) -> bool:
    """Beginnt bei Wort i ein neuer Satz/Gedanke?"""
    if i <= 0:
        return True
    prev = words[i - 1]
    return bool(SENTENCE_END.search(prev.text)) or words[i].start - prev.end >= PAUSE


def _is_boundary_after(words: Sequence[TWord], i: int) -> bool:
    if i >= len(words) - 1:
        return True
    return bool(SENTENCE_END.search(words[i].text)) or words[i + 1].start - words[i].end >= PAUSE


def package(
    start: float,
    end: float,
    words: Sequence[TWord],
    *,
    punchline_at: float | None = None,
    target_min: float = 10.0,
    target_max: float = 35.0,
    hard_min: float = 8.0,
    hard_max: float = 45.0,
    media_duration: float | None = None,
) -> PackResult:
    """Verpackt einen vorgeschlagenen Bereich.

    An Wortgrenzen wird nur eingerastet, wo am Rand gesprochen wird. Stille/Gameplay am Rand
    bleibt erhalten (ein markierter Moment ohne Reden schrumpft nicht auf ein paar Wörter).
    """
    words = sorted(words, key=lambda w: w.start)
    n = len(words)
    limit_end = media_duration if media_duration else float("inf")
    start, end = max(0.0, start), min(limit_end, end)
    notes: list[str] = []

    def start_at(i: int) -> float:
        s_ = max(0.0, words[i].start - PRE_ROLL)
        if i > 0:
            s_ = max(s_, words[i - 1].end + 0.02)
        return s_

    def end_at(i: int) -> float:
        e_ = words[i].end + POST_ROLL
        if i + 1 < n:
            e_ = min(e_, words[i + 1].start - 0.03)
        return min(e_, limit_end)

    # --- Start: einrasten, wenn am Anfang gesprochen wird; Füllwörter weg
    s = start
    si = next((i for i, w in enumerate(words) if w.end > start + 0.05), None)
    if si is not None and words[si].start <= start + 2.5:
        if words[si].start < start - 0.6 and si + 1 < n:
            si += 1  # angeschnittenes Wort
        back = si
        while back > 0 and not _is_boundary_before(words, back) and start - words[back - 1].start <= 3.0:
            back -= 1
        if _is_boundary_before(words, back):
            si = back
        while (si < n - 1 and _norm(words[si].text) in LEADING_FILLERS and words[si + 1].start - words[si].start < 1.5
               and words[si + 1].start < end):
            si += 1
        s = start_at(si)

    # --- Ende: wenn am Ende gesprochen wird, Satz zu Ende führen; Füllwörter weg
    e = end
    ei = max((i for i, w in enumerate(words) if w.start < end - 0.05), default=None)
    if ei is not None and words[ei].end >= end - 2.5 and words[ei].start >= s:
        while ei < n - 1 and not _is_boundary_after(words, ei) and words[ei + 1].end <= end + 4.0:
            ei += 1
        while ei > 0 and _norm(words[ei].text) in TRAILING_FILLERS and words[ei - 1].start >= s:
            ei -= 1
        e = end_at(ei)
    punch = punchline_at if punchline_at is not None else e

    # --- zu lang: vorne kürzen (an Satzgrenzen), Pointe behalten
    if e - s > target_max:
        cands = [i for i in range(n) if words[i].start >= s and _is_boundary_before(words, i)
                 and e - start_at(i) <= target_max and words[i].start <= punch - 3.0]
        if cands:
            s = start_at(cands[0])
            notes.append("vorne auf Satzanfang gekürzt")
        else:
            s = e - target_max
            nxt = next((i for i, w in enumerate(words) if w.start >= s), None)
            if nxt is not None and words[nxt].start < e and words[nxt].start - s < 2.0:
                s = start_at(nxt)
            notes.append("vorne gekürzt (kein Satzanfang passend)")
    if e - s > hard_max:
        e = s + hard_max
        last = max((i for i, w in enumerate(words) if w.end <= e and w.start >= s), default=None)
        if last is not None:
            e = end_at(last)
        notes.append("hinten auf Maximallänge gekürzt")

    # --- zu kurz: vorne Kontext dazunehmen (Satzanfang), sonst zeitlich erweitern
    if e - s < target_min:
        cands = [i for i in range(n) if words[i].start < s and _is_boundary_before(words, i)
                 and target_min <= e - start_at(i) <= target_max]
        if cands:
            s = start_at(cands[-1])
            notes.append("vorne um Kontext erweitert")
        else:
            ns = max(0.0, e - target_min)
            inside = next((i for i, w in enumerate(words) if w.start < ns < w.end), None)
            if inside is not None:
                ns = start_at(inside)
            if ns < s:
                s = ns
                notes.append("vorne erweitert")
    if e - s < target_min and e < limit_end:
        later = [i for i, w in enumerate(words) if w.start >= e - 0.05]
        new_e = e
        for i in later:
            if words[i].end - s > target_min + 4 or words[i].start - new_e > 1.5:
                break
            new_e = end_at(i)
            if _is_boundary_after(words, i) and new_e - s >= target_min:
                break
        if new_e > e:
            e = new_e
            notes.append("hinten bis Satzende erweitert")
    if e - s < hard_min:
        pad = (hard_min - (e - s)) / 2
        s, e = max(0.0, s - pad), min(limit_end, e + pad)

    used = [w for w in words if w.end > s and w.start < e]
    return PackResult(s, e, used, too_short=(e - s) < hard_min, notes=notes)


def map_words_to_output(words: Sequence[TWord], cuts: Sequence[tuple[float, float]]) -> list[dict]:
    """Rechnet absolute Wortzeiten in Zeiten im fertigen Clip um (Cuts werden aneinandergehängt)."""
    out: list[dict] = []
    acc = 0.0
    for cs, ce in cuts:
        for w in words:
            if w.end <= cs or w.start >= ce:
                continue
            ws, we = max(w.start, cs), min(w.end, ce)
            out.append({"text": w.text, "start": round(acc + ws - cs, 3), "end": round(acc + we - cs, 3)})
        acc += ce - cs
    return out


def build_cuts(main: tuple[float, float], context: tuple[float, float] | None, *, max_context: float = 4.0) -> list[tuple[float, float]]:
    """Optionaler Rückblick-Cut (max. 4 s, muss vor dem Hauptteil liegen und darf nicht überlappen)."""
    cuts: list[tuple[float, float]] = []
    if context:
        cs, ce = context
        ce = min(ce, cs + max_context, main[0] - 0.5)
        if ce - cs >= 1.0:
            cuts.append((round(cs, 3), round(ce, 3)))
    cuts.append((round(main[0], 3), round(main[1], 3)))
    return cuts
