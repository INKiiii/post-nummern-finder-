"""Highlight-Auswahl: verbindet Signal-Vorfilter, Claude-Durchläufe, Verpacken, Ausschlüsse,
Dedupe/Vielfalt und Quote zu einem Ergebnis (Review-Liste, Archiv „Auch gut“, verworfen)."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Sequence

from ..analysis.signals import Window
from ..analysis.transcribe import Transcript, TWord
from ..llm.ai import (
    Assessment,
    CandidateInput,
    HeuristicAI,
    HighlightAI,
    Proposal,
    RankItem,
    WindowInput,
    local_safety_scan,
)
from ..media import ffmpeg
from . import dedupe as dd
from .packaging import build_cuts, map_words_to_output, package
from .scoring import is_hard_excluded, weighted_total

log = logging.getLogger(__name__)


@dataclass
class SelectionConfig:
    weights: dict[str, float]
    min_score: float = 7.0
    quota: int = 15
    target_min: float = 10.0
    target_max: float = 35.0
    hard_min: float = 8.0
    hard_max: float = 45.0
    vision: bool = False


@dataclass
class ClipDraft:
    start: float
    end: float
    cuts: list[tuple[float, float]]
    words: list[dict]  # relativ zum Clip
    transcript: str
    category: str
    title: str
    hook_text: str
    context_line: str
    reason: str
    scores: dict[str, int]
    total: float
    safety_flags: list[str]
    safety_note: str
    signals: dict
    excluded: bool
    manual: bool = False
    note: str = ""
    rank: int | None = None

    @property
    def duration(self) -> float:
        return sum(e - s for s, e in self.cuts)


@dataclass
class SelectionResult:
    review: list[ClipDraft] = field(default_factory=list)
    archive: list[ClipDraft] = field(default_factory=list)
    discarded: list[ClipDraft] = field(default_factory=list)
    stats: dict = field(default_factory=dict)


def transcript_lines(words: Sequence[TWord], start: float, end: float, max_len: float = 7.0) -> list[tuple[float, float, str]]:
    """Gruppiert Wörter zu Zeilen mit Zeitstempel (Umbruch an Satzende, Pausen oder nach 7 s)."""
    lines: list[tuple[float, float, str]] = []
    cur: list[TWord] = []
    for w in words:
        if w.end <= start or w.start >= end:
            continue
        if cur and (w.start - cur[-1].end > 0.8 or w.end - cur[0].start > max_len or cur[-1].text.endswith((".", "!", "?"))):
            lines.append((cur[0].start, cur[-1].end, " ".join(x.text for x in cur)))
            cur = []
        cur.append(w)
    if cur:
        lines.append((cur[0].start, cur[-1].end, " ".join(x.text for x in cur)))
    return lines


def window_inputs(windows: Sequence[Window], transcript: Transcript, chat_samples: Callable[[float, float], list[str]] | None = None) -> list[WindowInput]:
    words = transcript.words()
    out = []
    for i, w in enumerate(windows):
        out.append(WindowInput(
            id=i, start=w.start, end=w.end, anchor=w.anchor, signals=[s.to_dict() for s in w.signals],
            lines=transcript_lines(words, w.start, w.end), chat_samples=chat_samples(w.start, w.end) if chat_samples else [],
        ))
    return out


def _frames(source: Path | None, frames_dir: Path | None, key: str, times: Sequence[float]) -> list[Path]:
    if source is None or frames_dir is None:
        return []
    frames_dir.mkdir(parents=True, exist_ok=True)
    out = []
    for k, t in enumerate(times):
        p = frames_dir / f"{key}_{k}_{t:.1f}.jpg"
        if not p.exists():
            try:
                ffmpeg.extract_frame(source, t, p, width=512)
            except ffmpeg.FFmpegError as exc:
                log.warning("Frame %.1fs nicht extrahierbar: %s", t, exc)
                continue
        out.append(p)
    return out


def select_highlights(
    *,
    ai: HighlightAI,
    windows: Sequence[Window],
    transcript: Transcript,
    media_duration: float,
    cfg: SelectionConfig,
    source: Path | None = None,
    frames_dir: Path | None = None,
    chat_samples: Callable[[float, float], list[str]] | None = None,
    progress: Callable[[float, str], None] | None = None,
) -> SelectionResult:
    def prog(p: float, m: str) -> None:
        if progress:
            progress(p, m)

    res = SelectionResult()
    if not windows:
        res.stats = {"windows": 0, "proposals": 0, "assessed": 0}
        return res
    words = transcript.words()
    winputs = window_inputs(windows, transcript, chat_samples)

    # --- Durchlauf 1: Kandidaten
    prog(0.05, f"Claude sucht Kandidaten in {len(winputs)} Fenstern")
    proposals = ai.propose(winputs)
    covered = {p.window_id for p in proposals}
    manual_ids = {i for i, w in enumerate(windows) if any(s.type == "marker" for s in w.signals)}
    missing_manual = [winputs[i] for i in manual_ids if i not in covered]
    if missing_manual:
        # Manuell markierte Momente werden immer geschnitten
        proposals += HeuristicAI().propose(missing_manual)

    # --- Verpacken
    packed: list[tuple[Proposal, list[tuple[float, float]], list[TWord]]] = []
    for p in proposals:
        pr = package(p.start, p.end, words, punchline_at=p.punchline_at, target_min=cfg.target_min, target_max=cfg.target_max,
                     hard_min=cfg.hard_min, hard_max=cfg.hard_max, media_duration=media_duration)
        cuts = build_cuts((pr.start, pr.end), p.context)
        packed.append((p, cuts, pr.words))

    # --- Durchlauf 2: Raster-Bewertung pro Kandidat
    prog(0.35, f"Claude bewertet {len(packed)} Kandidaten")
    cands: list[CandidateInput] = []
    for i, (p, cuts, cw) in enumerate(packed):
        w = windows[p.window_id]
        main = cuts[-1]
        frames = _frames(source, frames_dir, f"c{i}", [main[0] + 1.0, min(main[1] - 0.5, p.punchline_at)]) if cfg.vision else []
        cands.append(CandidateInput(
            id=i, start=main[0], end=main[1], lines=transcript_lines(words, main[0], main[1]),
            context_before=" ".join(x.text for x in words if main[0] - 12 < x.start < main[0])[-400:],
            signals=w.summary(), category=p.category, idea=p.idea, hook_text=p.hook_text, strength=w.strength, frames=frames,
        ))
    assessments: dict[int, Assessment] = {a.id: a for a in ai.assess(cands)}

    drafts: list[ClipDraft] = []
    for i, (p, cuts, cw) in enumerate(packed):
        a = assessments.get(i)
        if a is None:
            continue
        w = windows[p.window_id]
        main = cuts[-1]
        if a.trim_start is not None or a.trim_end is not None:
            ns = a.trim_start if a.trim_start is not None and abs(a.trim_start - main[0]) <= 6 else main[0]
            ne = a.trim_end if a.trim_end is not None and abs(a.trim_end - main[1]) <= 6 else main[1]
            if ne - ns >= cfg.hard_min * 0.8:
                pr = package(ns, ne, words, punchline_at=min(p.punchline_at, ne), target_min=cfg.target_min,
                             target_max=cfg.target_max, hard_min=cfg.hard_min, hard_max=cfg.hard_max, media_duration=media_duration)
                cuts = build_cuts((pr.start, pr.end), p.context)
                main = cuts[-1]
        clip_words = [x for x in words if any(x.end > cs and x.start < ce for cs, ce in cuts)]
        text = " ".join(x.text for x in clip_words if x.end > main[0] and x.start < main[1])
        flags = list(dict.fromkeys(a.safety_flags + local_safety_scan(text)))
        total = weighted_total(a.scores, cfg.weights)
        manual = i < len(proposals) and p.window_id in manual_ids
        drafts.append(ClipDraft(
            start=main[0], end=main[1], cuts=[tuple(c) for c in cuts], words=map_words_to_output(clip_words, cuts),
            transcript=text, category=p.category, title=a.title or p.idea[:60], hook_text=a.hook_text or p.hook_text,
            context_line=p.context_line, reason=a.reason, scores=a.scores, total=total, safety_flags=flags,
            safety_note=a.safety_note, signals=w.to_dict(), excluded=is_hard_excluded(a.scores, flags), manual=manual,
        ))

    # --- Mindest-Score
    passing: list[ClipDraft] = []
    for d in drafts:
        if d.duration < cfg.hard_min * 0.75:
            d.note = "zu kurz"
            res.discarded.append(d)
        elif d.total >= cfg.min_score or d.manual:
            passing.append(d)
        else:
            d.note = f"unter Mindest-Score {cfg.min_score:g}"
            res.discarded.append(d)

    # --- Dedupe (lokal) + Durchlauf 3: Gesamt-Ranking
    items = [dd.DedupeItem(i, d.start, d.end, d.transcript, d.total + (5 if d.manual else 0), d.category) for i, d in enumerate(passing)]
    kept, dropped = dd.dedupe(items)
    for i, dup_of in dropped.items():
        passing[i].note = "Dublette"
        res.discarded.append(passing[i])
    prog(0.6, f"Claude rankt {len(kept)} Clips")
    order, dups = ai.rank([RankItem(k.id, passing[k.id].title, k.category, passing[k.id].total, k.text, k.start) for k in kept])
    ranked_items = []
    by_id = {k.id: k for k in kept}
    for cid in order:
        if cid in dups:
            passing[cid].note = "Dublette (Ranking)"
            res.discarded.append(passing[cid])
            continue
        if cid in by_id:
            ranked_items.append(by_id[cid])
    # Manuelle Marker nach vorn, dann Vielfalt
    ranked_items.sort(key=lambda k: not passing[k.id].manual)
    diverse = dd.diversify(ranked_items)

    # --- Quote: beste N in Review, Rest ins Archiv
    for pos, k in enumerate(diverse):
        d = passing[k.id]
        d.rank = pos + 1
        (res.review if pos < cfg.quota or d.manual else res.archive).append(d)
    res.stats = {
        "windows": len(windows), "proposals": len(proposals), "assessed": len(assessments),
        "passing": len(passing), "review": len(res.review), "archive": len(res.archive),
        "discarded": len(res.discarded), "mix": dd.format_mix([dd.DedupeItem(0, d.start, d.end, "", 0, d.category) for d in res.review]),
    }
    prog(0.7, f"{len(res.review)} Clips für die Review-Liste")
    return res
