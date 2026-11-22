"""Stufe 2/3: gewichteter Gesamt-Score und harte Ausschlüsse."""

from __future__ import annotations

from typing import Mapping, Sequence

RUBRIC_KEYS = ("hook", "payoff", "clarity", "emotion", "meme", "risk")
RISK_EXCLUDE = 8


def weighted_total(scores: Mapping[str, float], weights: Mapping[str, float]) -> float:
    """Gewichteter Mittelwert 1..10. Risiko wird umgedreht (10 = riskant -> trägt 1 bei)."""
    num = 0.0
    den = 0.0
    for k in RUBRIC_KEYS:
        w = float(weights.get(k, 1.0))
        if w <= 0 or k not in scores:
            continue
        v = float(scores[k])
        if k == "risk":
            v = 11.0 - v
        num += w * v
        den += w
    return round(num / den, 2) if den else 0.0


def is_hard_excluded(scores: Mapping[str, float], flags: Sequence[str]) -> bool:
    """Harte Ausschlüsse: jede Safety-Markierung oder Risiko ≥ 8 -> nur mit ausdrücklicher Freigabe."""
    return bool(flags) or float(scores.get("risk", 1)) >= RISK_EXCLUDE
