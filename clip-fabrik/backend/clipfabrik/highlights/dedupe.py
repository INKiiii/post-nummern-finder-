"""Stufe 5: Dedupe und Vielfalt.

* Zeitliche Überlappung (gleicher Moment) und Text-Ähnlichkeit (gleicher Witz) -> Dublette.
* Text-Ähnlichkeit über Zeichen-3-Gramme (Kosinus), robust gegen kleine Transkriptionsfehler.
* Reihenfolge so, dass keine zwei Clips gleicher Kategorie direkt hintereinander kommen.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from typing import Sequence


@dataclass
class DedupeItem:
    id: int
    start: float
    end: float
    text: str
    score: float
    category: str = ""


def overlap_ratio(a0: float, a1: float, b0: float, b1: float) -> float:
    """Überlappung relativ zum kürzeren Clip (0..1)."""
    inter = max(0.0, min(a1, b1) - max(a0, b0))
    shorter = max(1e-6, min(a1 - a0, b1 - b0))
    return inter / shorter


def _grams(text: str, n: int = 3) -> Counter:
    t = re.sub(r"[^\wäöüß ]+", "", text.lower())
    t = re.sub(r"\s+", " ", t).strip()
    return Counter(t[i:i + n] for i in range(max(0, len(t) - n + 1)))


def text_similarity(a: str, b: str) -> float:
    ga, gb = _grams(a), _grams(b)
    if not ga or not gb:
        return 0.0
    dot = sum(ga[k] * gb.get(k, 0) for k in ga)
    na = math.sqrt(sum(v * v for v in ga.values()))
    nb = math.sqrt(sum(v * v for v in gb.values()))
    return dot / (na * nb)


def dedupe(items: Sequence[DedupeItem], *, overlap_threshold: float = 0.35, text_threshold: float = 0.62) -> tuple[list[DedupeItem], dict[int, int]]:
    """Behält pro Moment/Witz den besten Clip. Liefert (behalten, {verworfen_id: besser_id})."""
    kept: list[DedupeItem] = []
    dropped: dict[int, int] = {}
    for it in sorted(items, key=lambda x: -x.score):
        dup_of = None
        for k in kept:
            if overlap_ratio(it.start, it.end, k.start, k.end) >= overlap_threshold:
                dup_of = k.id
                break
            if len(it.text) > 25 and len(k.text) > 25 and text_similarity(it.text, k.text) >= text_threshold:
                dup_of = k.id
                break
        if dup_of is None:
            kept.append(it)
        else:
            dropped[it.id] = dup_of
    return kept, dropped


def diversify(ordered: Sequence[DedupeItem], *, max_similar: float = 0.45) -> list[DedupeItem]:
    """Greedy: nimmt immer den bestplatzierten Clip, der sich vom vorherigen unterscheidet
    (andere Kategorie und wenig Text-Ähnlichkeit). Geht es nicht anders, bleibt die Reihenfolge."""
    pool = list(ordered)
    out: list[DedupeItem] = []
    while pool:
        prev = out[-1] if out else None
        pick = 0
        if prev is not None:
            for i, cand in enumerate(pool):
                if cand.category != prev.category and text_similarity(cand.text, prev.text) < max_similar:
                    pick = i
                    break
        out.append(pool.pop(pick))
    return out


def format_mix(items: Sequence[DedupeItem]) -> dict[str, int]:
    return dict(Counter(i.category or "?" for i in items))
