"""Lautstärke-, Stille- und Lach-Analyse auf 16-kHz-Mono-WAV (numpy, speicherschonend)."""

from __future__ import annotations

import json
import wave
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np


@dataclass
class AudioAnalysis:
    rate: int = 16000
    loudness_db: list[float] = field(default_factory=list)  # pro Sekunde, dBFS (RMS)
    laughter: list[float] = field(default_factory=list)  # 0..1 pro Sekunde (Heuristik)
    silences: list[tuple[float, float]] = field(default_factory=list)  # (start, end)

    @property
    def duration(self) -> float:
        return float(len(self.loudness_db))

    def to_json(self) -> str:
        return json.dumps(asdict(self))

    @classmethod
    def from_json(cls, s: str) -> "AudioAnalysis":
        d = json.loads(s)
        d["silences"] = [tuple(x) for x in d.get("silences", [])]
        return cls(**d)

    def mean_db(self, start: float, end: float) -> float:
        a, b = max(0, int(start)), max(int(start) + 1, int(end))
        seg = self.loudness_db[a:b]
        return float(np.mean(seg)) if seg else -90.0


SILENCE_DB = -42.0
MIN_SILENCE = 0.6


def analyze_wav(path: str | Path, *, chunk_seconds: int = 600) -> AudioAnalysis:
    """Liest das WAV blockweise und berechnet Lautheit (1 s), Lach-Wahrscheinlichkeit und Stillen."""
    with wave.open(str(path), "rb") as w:
        rate = w.getframerate()
        channels = w.getnchannels()
        width = w.getsampwidth()
        if width != 2:
            raise ValueError("Erwartet 16-bit PCM")
        loud: list[float] = []
        laugh: list[float] = []
        # 100-ms-Fenster für Stille
        frame_db: list[float] = []
        while True:
            raw = w.readframes(rate * chunk_seconds)
            if not raw:
                break
            x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            if channels > 1:
                x = x.reshape(-1, channels).mean(axis=1)
            n_sec = len(x) // rate
            rest = x[n_sec * rate:]
            secs = x[: n_sec * rate].reshape(n_sec, rate) if n_sec else np.zeros((0, rate), np.float32)
            if len(rest) > rate // 4:
                secs = np.vstack([secs, np.pad(rest, (0, rate - len(rest)))])
            for s in secs:
                rms = float(np.sqrt(np.mean(s * s)) + 1e-9)
                loud.append(round(20 * np.log10(rms), 2))
                laugh.append(round(_laughter_score(s, rate), 3))
                hop = rate // 10
                for i in range(10):
                    f = s[i * hop:(i + 1) * hop]
                    frame_db.append(20 * np.log10(float(np.sqrt(np.mean(f * f))) + 1e-9))
    silences = _silences(frame_db, 0.1)
    return AudioAnalysis(rate=rate, loudness_db=loud, laughter=laugh, silences=silences)


def _silences(frame_db: list[float], hop: float) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    start = None
    for i, db in enumerate(frame_db):
        if db < SILENCE_DB:
            if start is None:
                start = i
        else:
            if start is not None and (i - start) * hop >= MIN_SILENCE:
                out.append((round(start * hop, 2), round(i * hop, 2)))
            start = None
    if start is not None and (len(frame_db) - start) * hop >= MIN_SILENCE:
        out.append((round(start * hop, 2), round(len(frame_db) * hop, 2)))
    return out


def _laughter_score(s: np.ndarray, rate: int) -> float:
    """Heuristik für Gelächter: lautes Signal mit rhythmischer Hüllkurve (4–8 Hz „ha-ha-ha“).

    Kein ML-Modell, sondern ein grober Hinweis, der nur zusammen mit anderen Signalen zählt.
    """
    rms = float(np.sqrt(np.mean(s * s)))
    if rms < 0.02:
        return 0.0
    hop = rate // 100  # 10-ms-Hüllkurve
    env = np.sqrt(np.mean(s[: len(s) // hop * hop].reshape(-1, hop) ** 2, axis=1))
    env = env - env.mean()
    if np.allclose(env, 0):
        return 0.0
    spec = np.abs(np.fft.rfft(env * np.hanning(len(env))))
    freqs = np.fft.rfftfreq(len(env), d=0.01)
    band = spec[(freqs >= 3.5) & (freqs <= 8.0)].sum()
    total = spec[(freqs >= 0.5) & (freqs <= 25.0)].sum() + 1e-9
    ratio = band / total
    # hohe Spektralschwerpunkte (Lachen ist eher hell) leicht belohnen
    loudness_factor = min(1.0, rms / 0.12)
    return float(max(0.0, min(1.0, (ratio - 0.25) / 0.35)) * loudness_factor)


def zscores(values: list[float], window: int = 120) -> np.ndarray:
    """Gleitender z-Score (lokaler Ausreißer statt globaler Durchschnitt)."""
    x = np.asarray(values, dtype=np.float64)
    if len(x) == 0:
        return x
    # gleitender Mittelwert/Std via kumulative Summen
    pad = window // 2
    xp = np.pad(x, (pad, pad), mode="edge")
    c1 = np.cumsum(np.insert(xp, 0, 0.0))
    c2 = np.cumsum(np.insert(xp * xp, 0, 0.0))
    n = window
    mean = (c1[n:] - c1[:-n]) / n
    var = (c2[n:] - c2[:-n]) / n - mean * mean
    mean = mean[: len(x)]
    std = np.sqrt(np.maximum(var[: len(x)], 1e-6))
    return (x - mean) / np.maximum(std, 1.5)
