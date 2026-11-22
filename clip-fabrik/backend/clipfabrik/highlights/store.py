"""Clips anlegen, mit Live-Funden abgleichen und Dateinamen vergeben."""

from __future__ import annotations

import datetime as dt
import re
import unicodedata
from typing import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import Clip, Stream
from .dedupe import overlap_ratio
from .pipeline import ClipDraft


def slugify(text: str, max_len: int = 50) -> str:
    t = text.replace("ß", "ss").replace("ä", "ae").replace("ö", "oe").replace("ü", "ue")
    t = t.replace("Ä", "Ae").replace("Ö", "Oe").replace("Ü", "Ue")
    t = unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode()
    t = re.sub(r"[^A-Za-z0-9]+", "-", t).strip("-").lower()
    return (t[:max_len].rstrip("-")) or "clip"


def clip_slug(stream: Stream, title: str, score: float) -> str:
    who = stream.channel.login if stream.channel else (stream.source_type or "upload")
    day = (stream.started_at or dt.datetime.now()).strftime("%Y-%m-%d")
    return f"{slugify(who, 24)}_{day}_{slugify(title, 40)}_s{score:.1f}".replace(".", "-")


def draft_to_clip(d: ClipDraft, stream: Stream, *, bucket: str, origin: str) -> Clip:
    return Clip(
        stream_id=stream.id, origin="manual" if d.manual and origin != "post" else origin, bucket=bucket,
        review_state="pending", rank=d.rank, start=d.start, end=d.end, cuts=[list(c) for c in d.cuts],
        title=d.title, hook_text=d.hook_text, context_line=d.context_line, category=d.category, reason=d.reason,
        transcript=d.transcript, words=d.words, signals=d.signals, scores=d.scores, total_score=d.total,
        safety={"flags": d.safety_flags, "note": d.safety_note, "source": "bewertung"}, safety_flagged=d.excluded,
        slug=clip_slug(stream, d.title, d.total),
    )


def store_selection(s: Session, stream: Stream, review: Sequence[ClipDraft], archive: Sequence[ClipDraft],
                    discarded: Sequence[ClipDraft], *, origin: str = "post", keep_discarded: bool = True) -> dict:
    """Speichert die Auswahl. Bestehende Live-Clips desselben Moments werden bestätigt/verbessert statt doppelt angelegt."""
    existing = s.scalars(select(Clip).where(Clip.stream_id == stream.id)).all()
    created: list[int] = []
    confirmed: list[int] = []
    for bucket, drafts in (("review", review), ("archive", archive), ("discarded", discarded if keep_discarded else [])):
        for d in drafts:
            match = next((c for c in existing if overlap_ratio(d.start, d.end, c.start, c.end) >= 0.35), None)
            if match is not None:
                if bucket != "discarded":
                    match.live_confirmed = match.origin in ("live", "manual") or match.live_confirmed
                    # nur ungeprüfte Clips verbessern (Entscheidungen des Nutzers nie überschreiben)
                    if match.review_state == "pending" and d.total > match.total_score:
                        match.start, match.end, match.cuts = d.start, d.end, [list(c) for c in d.cuts]
                        match.words, match.transcript = d.words, d.transcript
                        match.scores, match.total_score, match.reason = d.scores, d.total, d.reason
                        match.title, match.hook_text = d.title or match.title, d.hook_text or match.hook_text
                        match.render_status = "stale"
                    if bucket == "review" and match.bucket != "review":
                        match.bucket = "review"
                    match.rank = d.rank
                    confirmed.append(match.id)
                continue
            c = draft_to_clip(d, stream, bucket=bucket, origin=origin)
            if bucket == "discarded":
                c.reason = (c.reason + f" [{d.note}]").strip()
            s.add(c)
            s.flush()
            existing.append(c)
            created.append(c.id)
    return {"created": created, "confirmed": confirmed}
