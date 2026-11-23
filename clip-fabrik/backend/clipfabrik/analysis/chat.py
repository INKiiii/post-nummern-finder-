"""Chat als Viral-Signal: Nachrichtenrate, Emote-Spam, Großbuchstaben, Events, Mod-Aktionen."""

from __future__ import annotations

import json
import math
import re
from collections import deque
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable

import numpy as np

# Gewicht pro Ereignis-Art (zusätzlich zur Nachrichtenrate)
EVENT_WEIGHTS = {
    "sub": 1.0,
    "resub": 1.0,
    "subgift": 1.5,
    "submysterygift": 3.0,
    "raid": 6.0,
    "bits": 0.0,  # wird über Bits-Menge gewichtet
    "timeout": 0.8,
    "ban": 1.2,
    "clear": 0.5,
}


@dataclass
class ChatEvent:
    t: float  # Epoch-Sekunden
    kind: str = "msg"  # msg | sub | resub | subgift | submysterygift | raid | bits | timeout | ban | clear
    user: str = ""
    text: str = ""
    emotes: int = 0  # Anzahl Twitch-Emotes laut IRC-Tags
    bits: int = 0
    viewers: int = 0  # bei Raid
    is_mod: bool = False
    is_broadcaster: bool = False
    shared: bool = False  # aus Shared-Chat (anderer Kanal)

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)

    @classmethod
    def from_dict(cls, d: dict) -> "ChatEvent":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


def load_events(path: Path) -> list[ChatEvent]:
    if not path.exists():
        return []
    out: list[ChatEvent] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(ChatEvent.from_dict(json.loads(line)))
            except (json.JSONDecodeError, TypeError):
                continue  # beschädigte Zeile (z. B. Absturz mitten im Schreiben) überspringen
    return out


_WORD = re.compile(r"\S+")


def message_features(text: str, twitch_emotes: int, emote_set: set[str]) -> tuple[float, float]:
    """(Emote-Anteil, Großbuchstaben-Anteil) einer Nachricht."""
    tokens = _WORD.findall(text)
    if not tokens:
        return 0.0, 0.0
    emote_tokens = sum(1 for t in tokens if t in emote_set) + twitch_emotes
    emote_ratio = min(1.0, emote_tokens / len(tokens))
    letters = [c for c in text if c.isalpha()]
    caps = (sum(1 for c in letters if c.isupper()) / len(letters)) if len(letters) >= 4 else 0.0
    return emote_ratio, caps


@dataclass
class ChatSeries:
    """Kennzahlen pro Sekunde, Index = Sekunde seit ``start``."""

    start: float
    rate: np.ndarray
    emote: np.ndarray
    caps: np.ndarray
    events: np.ndarray
    mod_actions: np.ndarray
    sample_texts: dict[int, list[str]] = field(default_factory=dict)

    def intensity(self, window: int = 5, baseline: int = 300) -> np.ndarray:
        """Chat-Intensität als lokaler Ausreißer-Wert (≈ z-Score), geglättet über ``window`` Sekunden."""
        n = len(self.rate)
        if n == 0:
            return np.zeros(0)
        k = np.ones(window) / window
        rate_s = np.convolve(self.rate, k, mode="same")
        # Basislinie: gleitender Median-Ersatz über längeres Fenster (Mittelwert, robust genug)
        kb = np.ones(min(baseline, n)) / min(baseline, n)
        base = np.convolve(self.rate, kb, mode="same")
        std = np.sqrt(np.maximum(np.convolve((self.rate - base) ** 2, kb, mode="same"), 0.04))
        z = (rate_s - base) / np.maximum(std, 0.5)
        emote_s = np.convolve(self.emote, k, mode="same")
        caps_s = np.convolve(self.caps, k, mode="same")
        ev_s = np.convolve(self.events, k, mode="same") * window
        # Emote-Spam und Caps zählen nur, wenn auch genug Nachrichten kommen
        busy = np.clip(rate_s / np.maximum(base, 0.2), 0, 4) / 4
        return z + 2.0 * emote_s * busy + 1.2 * caps_s * busy + np.log1p(ev_s)


def build_series(events: Iterable[ChatEvent], start: float, duration: float, emote_set: set[str]) -> ChatSeries:
    n = max(1, int(math.ceil(duration)))
    rate = np.zeros(n)
    emote = np.zeros(n)
    caps = np.zeros(n)
    evw = np.zeros(n)
    mods = np.zeros(n)
    samples: dict[int, list[str]] = {}
    for e in events:
        i = int(e.t - start)
        if i < 0 or i >= n:
            continue
        if e.kind == "msg":
            rate[i] += 1
            er, cr = message_features(e.text, e.emotes, emote_set)
            emote[i] += er
            caps[i] += cr
            if e.bits:
                evw[i] += min(5.0, e.bits / 200.0)
            lst = samples.setdefault(i, [])
            if len(lst) < 4 and e.text:
                lst.append(e.text[:80])
        else:
            w = EVENT_WEIGHTS.get(e.kind, 0.5)
            if e.kind == "raid":
                w += min(6.0, math.log1p(e.viewers))
            if e.kind == "bits":
                w = min(5.0, e.bits / 200.0)
            evw[i] += w
            if e.kind in ("timeout", "ban", "clear"):
                mods[i] += 1
    with np.errstate(invalid="ignore", divide="ignore"):
        emote = np.where(rate > 0, emote / np.maximum(rate, 1), 0)
        caps = np.where(rate > 0, caps / np.maximum(rate, 1), 0)
    return ChatSeries(start=start, rate=rate, emote=emote, caps=caps, events=evw, mod_actions=mods, sample_texts=samples)


@dataclass
class Spike:
    t: float  # Epoch der Spitze
    score: float
    rate: float
    baseline: float
    emote_ratio: float
    caps_ratio: float
    reason: str


class LiveSpikeDetector:
    """Erkennt Chat-Spitzen fortlaufend (Live-Modus).

    Vergleich: Nachrichten der letzten ``window`` Sekunden gegen die Basisrate der letzten
    ``baseline`` Sekunden. Nach einer Spitze gilt eine Sperrzeit, damit ein Moment nicht
    mehrfach auslöst.
    """

    def __init__(self, emote_set: set[str], *, window: float = 6.0, baseline: float = 300.0,
                 factor: float = 2.5, min_msgs: int = 8, cooldown: float = 45.0) -> None:
        self.emote_set = emote_set
        self.window = window
        self.baseline = baseline
        self.factor = factor
        self.min_msgs = min_msgs
        self.cooldown = cooldown
        self.events: deque[ChatEvent] = deque()
        self.last_spike: float = -1e9
        self.first_t: float | None = None

    def feed(self, e: ChatEvent) -> None:
        if self.first_t is None:
            self.first_t = e.t
        self.events.append(e)
        while self.events and self.events[0].t < e.t - self.baseline - self.window:
            self.events.popleft()

    def check(self, now: float) -> Spike | None:
        if now - self.last_spike < self.cooldown or self.first_t is None:
            return None
        recent = [e for e in self.events if now - self.window <= e.t <= now]
        older = [e for e in self.events if e.t < now - self.window]
        msgs = [e for e in recent if e.kind == "msg"]
        special = [e for e in recent if e.kind in ("raid", "submysterygift") or (e.kind == "bits" and e.bits >= 500)]
        span = max(30.0, min(self.baseline, (now - self.window) - self.first_t))
        base_rate = sum(1 for e in older if e.kind == "msg") / span * self.window
        emote_r = caps_r = 0.0
        if msgs:
            feats = [message_features(m.text, m.emotes, self.emote_set) for m in msgs]
            emote_r = sum(f[0] for f in feats) / len(feats)
            caps_r = sum(f[1] for f in feats) / len(feats)
        hot = len(msgs) >= self.min_msgs and len(msgs) >= self.factor * max(base_rate, 1.0)
        spammy = len(msgs) >= self.min_msgs and emote_r >= 0.5 and len(msgs) >= 1.5 * max(base_rate, 1.0)
        if not (hot or spammy or special):
            return None
        self.last_spike = now
        score = len(msgs) / max(base_rate, 1.0) + 2 * emote_r + caps_r + (3 if special else 0)
        reason = (
            "Raid/Geschenk-Abos" if special else
            "Emote-Spam" if spammy and not hot else
            f"Chat {len(msgs)} Nachr./{int(self.window)}s statt ~{base_rate:.1f}"
        )
        return Spike(t=now, score=round(score, 2), rate=len(msgs), baseline=round(base_rate, 2),
                     emote_ratio=round(emote_r, 2), caps_ratio=round(caps_r, 2), reason=reason)
