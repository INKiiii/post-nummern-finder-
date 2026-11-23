"""Transkription mit faster-whisper (Wort-Zeitstempel, Deutsch, GPU wenn vorhanden) plus Cache."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Protocol

log = logging.getLogger(__name__)


@dataclass
class TWord:
    text: str
    start: float
    end: float
    prob: float = 1.0

    def to_dict(self) -> dict:
        return {"text": self.text, "start": round(self.start, 3), "end": round(self.end, 3), "prob": round(self.prob, 3)}


@dataclass
class TSegment:
    start: float
    end: float
    text: str
    words: list[TWord] = field(default_factory=list)


@dataclass
class Transcript:
    language: str
    duration: float
    segments: list[TSegment] = field(default_factory=list)
    model: str = ""

    def words(self) -> list[TWord]:
        return [w for s in self.segments for w in s.words]

    def words_between(self, start: float, end: float) -> list[TWord]:
        return [w for w in self.words() if w.end > start and w.start < end]

    def text_between(self, start: float, end: float) -> str:
        return " ".join(w.text for w in self.words_between(start, end)).strip()

    def shifted(self, offset: float) -> "Transcript":
        return Transcript(
            language=self.language,
            duration=self.duration,
            model=self.model,
            segments=[
                TSegment(s.start + offset, s.end + offset, s.text, [TWord(w.text, w.start + offset, w.end + offset, w.prob) for w in s.words])
                for s in self.segments
            ],
        )

    def to_dict(self) -> dict:
        return {
            "language": self.language,
            "duration": self.duration,
            "model": self.model,
            "segments": [
                {"start": s.start, "end": s.end, "text": s.text, "words": [w.to_dict() for w in s.words]} for s in self.segments
            ],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Transcript":
        return cls(
            language=d.get("language", "de"),
            duration=float(d.get("duration", 0)),
            model=d.get("model", ""),
            segments=[
                TSegment(
                    float(s["start"]),
                    float(s["end"]),
                    s.get("text", ""),
                    [TWord(w["text"], float(w["start"]), float(w["end"]), float(w.get("prob", 1.0))) for w in s.get("words", [])],
                )
                for s in d.get("segments", [])
            ],
        )


class Transcriber(Protocol):
    name: str

    def transcribe(self, wav: Path, language: str = "de", on_progress: Callable[[float], None] | None = None) -> Transcript: ...


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / float(w.getframerate())


_model_lock = threading.Lock()
_models: dict[tuple[str, str, str], Any] = {}


class FasterWhisperTranscriber:
    def __init__(self, model_size: str = "medium", device: str = "auto", compute_type: str = "auto") -> None:
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self.name = f"faster-whisper-{model_size}"

    def _model(self) -> Any:
        key = (self.model_size, self.device, self.compute_type)
        with _model_lock:
            if key not in _models:
                from faster_whisper import WhisperModel

                log.info("Lade Whisper-Modell %s (device=%s, compute=%s)", *key)
                _models[key] = WhisperModel(
                    self.model_size,
                    device=self.device,
                    compute_type=self.compute_type,
                    cpu_threads=max(1, (os.cpu_count() or 2) - 1),
                )
            return _models[key]

    def transcribe(self, wav: Path, language: str = "de", on_progress: Callable[[float], None] | None = None) -> Transcript:
        duration = wav_duration(wav)
        model = self._model()
        segments, info = model.transcribe(
            str(wav),
            language=language or None,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            beam_size=5,
            condition_on_previous_text=False,  # weniger Halluzinations-Schleifen bei langen Streams
        )
        out: list[TSegment] = []
        for seg in segments:
            words = [TWord(w.word.strip(), float(w.start), float(w.end), float(w.probability)) for w in (seg.words or []) if w.word.strip()]
            out.append(TSegment(float(seg.start), float(seg.end), seg.text.strip(), words))
            if on_progress and duration:
                on_progress(min(1.0, seg.end / duration))
        return Transcript(language=info.language or language, duration=duration, segments=out, model=self.name)


class FakeTranscriber:
    """Für Tests und Demo ohne Whisper-Modell.

    Liest ein Skript ``<wav>.script.json`` ([{start, end, text}]) und verteilt die Wörter
    gleichmäßig. Ohne Skript entstehen Platzhalter-Wörter in lauten Abschnitten.
    """

    name = "fake"

    def transcribe(self, wav: Path, language: str = "de", on_progress: Callable[[float], None] | None = None) -> Transcript:
        duration = wav_duration(wav)
        script_file = Path(str(wav) + ".script.json")
        script: list[dict] = []
        if script_file.exists():
            script = json.loads(script_file.read_text(encoding="utf-8"))
        else:
            from .audio import analyze_wav

            aa = analyze_wav(wav)
            t = 0
            while t < len(aa.loudness_db):
                if aa.loudness_db[t] > -35:
                    end = t
                    while end < len(aa.loudness_db) and aa.loudness_db[end] > -35 and end - t < 6:
                        end += 1
                    script.append({"start": float(t), "end": float(end), "text": "(Sprache ohne Transkript)"})
                    t = end
                else:
                    t += 1
        segs: list[TSegment] = []
        for item in script:
            tokens = item["text"].split()
            if not tokens:
                continue
            span = (item["end"] - item["start"]) / len(tokens)
            words = [TWord(tok, item["start"] + i * span, item["start"] + (i + 0.85) * span) for i, tok in enumerate(tokens)]
            segs.append(TSegment(item["start"], item["end"], item["text"], words))
        if on_progress:
            on_progress(1.0)
        return Transcript(language=language, duration=duration, segments=segs, model=self.name)


def whisper_available() -> bool:
    try:
        import faster_whisper  # noqa: F401

        return True
    except Exception:
        return False


def get_transcriber(*, live: bool = False) -> Transcriber:
    from ..config import get_settings

    s = get_settings()
    if s.fake_ai or not whisper_available():
        if not s.fake_ai:
            log.warning("faster-whisper nicht installiert: Platzhalter-Transkription aktiv")
        return FakeTranscriber()
    return FasterWhisperTranscriber(
        s.whisper_live_model if live else s.whisper_model, s.whisper_device, s.whisper_compute_type
    )


def file_fingerprint(path: Path) -> str:
    """Schneller Fingerabdruck (Größe + erste/letzte 4 MB) statt Hash über Gigabytes."""
    h = hashlib.sha256()
    size = path.stat().st_size
    h.update(str(size).encode())
    with open(path, "rb") as f:
        h.update(f.read(4 << 20))
        if size > 8 << 20:
            f.seek(-(4 << 20), os.SEEK_END)
            h.update(f.read())
    return h.hexdigest()[:32]


def cached_transcribe(
    wav: Path,
    cache_dir: Path,
    transcriber: Transcriber,
    language: str = "de",
    on_progress: Callable[[float], None] | None = None,
) -> Transcript:
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = f"{file_fingerprint(wav)}_{transcriber.name}_{language}"
    cache_file = cache_dir / f"transcript_{key}.json"
    if cache_file.exists():
        log.info("Transkript aus Cache: %s", cache_file.name)
        return Transcript.from_dict(json.loads(cache_file.read_text(encoding="utf-8")))
    tr = transcriber.transcribe(wav, language, on_progress)
    tmp = cache_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(tr.to_dict(), ensure_ascii=False), encoding="utf-8")
    tmp.replace(cache_file)
    return tr
