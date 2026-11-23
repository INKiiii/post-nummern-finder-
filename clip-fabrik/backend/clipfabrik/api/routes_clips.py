"""Clips: Review (Freigeben/Ablehnen/Später), Bearbeiten, Neu-Rendern, Sammelaktionen, Medien."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from .. import auth
from ..db import Clip, SocialAccount, Stream, session_scope, utcnow
from ..highlights.packaging import map_words_to_output
from ..analysis.transcribe import TWord
from ..jobs import queue
from ..publish.scheduler import schedule_clip
from .serialize import clip_out

router = APIRouter(prefix="/api/clips", dependencies=[Depends(auth.require_login)])


@router.get("")
def list_clips(bucket: str | None = "review", state: str | None = None, stream_id: int | None = None,
               channel_id: int | None = None, limit: int = 100, offset: int = 0, order: str = "rank") -> list[dict]:
    with session_scope() as s:
        q = select(Clip).join(Stream, Clip.stream_id == Stream.id)
        if bucket and bucket != "all":
            q = q.where(Clip.bucket == bucket)
        if state:
            q = q.where(Clip.review_state.in_(state.split(",")))
        if stream_id:
            q = q.where(Clip.stream_id == stream_id)
        if channel_id:
            q = q.where(Stream.channel_id == channel_id)
        if order == "score":
            q = q.order_by(Clip.total_score.desc())
        elif order == "new":
            q = q.order_by(Clip.id.desc())
        else:
            q = q.order_by(Clip.stream_id.desc(), Clip.rank.asc().nullslast(), Clip.total_score.desc())
        return [clip_out(c) for c in s.scalars(q.offset(offset).limit(min(limit, 300))).all()]


@router.get("/{cid}")
def get_clip(cid: int) -> dict:
    with session_scope() as s:
        c = s.get(Clip, cid)
        if c is None:
            raise HTTPException(404, "Clip nicht gefunden")
        return clip_out(c, full=True)


class ClipPatch(BaseModel):
    title: str | None = Field(default=None, max_length=300)
    hook_text: str | None = Field(default=None, max_length=200)
    context_line: str | None = Field(default=None, max_length=200)
    subtitle_lines: list[str] | None = None
    captions: dict | None = None
    platforms: list[int] | None = None
    start: float | None = None
    end: float | None = None


@router.patch("/{cid}")
def patch_clip(cid: int, body: ClipPatch) -> dict:
    """Bearbeiten. Trim (start/end) rechnet die Untertitel-Wörter neu; danach „Neu rendern“."""
    data = body.model_dump(exclude_unset=True)
    with session_scope() as s:
        c = s.get(Clip, cid)
        if c is None:
            raise HTTPException(404, "Clip nicht gefunden")
        if "start" in data or "end" in data:
            ns = float(data.get("start", c.start))
            ne = float(data.get("end", c.end))
            dur = c.stream.duration or ne
            ns, ne = max(0.0, ns), min(dur, ne) if dur else ne
            if ne - ns < 3:
                raise HTTPException(400, "Clip muss mindestens 3 Sekunden lang sein")
            if ne - ns > 90:
                raise HTTPException(400, "Clip darf höchstens 90 Sekunden lang sein")
            cuts = [list(x) for x in (c.cuts or [[c.start, c.end]])]
            # Rückblick-Cut behalten, wenn er weiter vor dem Hauptteil liegt
            cuts = [x for x in cuts[:-1] if x[1] < ns - 0.5] + [[ns, ne]]
            old_cuts = [tuple(x) for x in (c.cuts or [[c.start, c.end]])]
            abs_words = _absolute_words(c.words or [], old_cuts)
            abs_words += _transcript_words_for(c, ns, ne, abs_words)
            c.start, c.end, c.cuts = ns, ne, cuts
            c.words = map_words_to_output(abs_words, [tuple(x) for x in cuts])
            c.transcript = " ".join(w.text for w in abs_words if w.end > ns and w.start < ne)
            c.subtitle_lines = None
            c.render_status = "stale"
        for k in ("title", "hook_text", "context_line", "subtitle_lines", "captions", "platforms"):
            if k in data:
                setattr(c, k, data[k])
                if k in ("hook_text", "context_line", "subtitle_lines"):
                    c.render_status = "stale"
        if "captions" in data:
            c.safety_checked_at = None  # Texte geändert -> Safety-Check neu
        return clip_out(c, full=True)


def _absolute_words(words: list[dict], cuts: list[tuple[float, float]]) -> list[TWord]:
    out: list[TWord] = []
    acc = 0.0
    bounds = []
    for cs, ce in cuts:
        bounds.append((acc, acc + ce - cs, cs))
        acc += ce - cs
    for w in words:
        for a, b, cs in bounds:
            if a - 0.01 <= w["start"] < b + 0.01:
                out.append(TWord(w["text"], cs + w["start"] - a, cs + w["end"] - a))
                break
    return out


def _transcript_words_for(c: Clip, ns: float, ne: float, have: list[TWord]) -> list[TWord]:
    """Holt Wörter außerhalb des alten Bereichs aus dem Transkript-Cache (beim Verlängern)."""
    import json

    from ..config import get_settings

    lo = min((w.start for w in have), default=ns)
    hi = max((w.end for w in have), default=ne)
    if ns >= lo - 0.2 and ne <= hi + 0.2:
        return []
    out: list[TWord] = []
    sdir = Path(c.stream.dir)
    wav = sdir / "audio.wav"
    if not wav.exists():
        return []
    from ..analysis.transcribe import file_fingerprint

    fp = file_fingerprint(wav)
    for f in get_settings().cache_dir.glob(f"transcript_{fp}_*.json"):
        data = json.loads(f.read_text(encoding="utf-8"))
        for seg in data.get("segments", []):
            for w in seg.get("words", []):
                if (ns <= w["start"] < lo - 0.05) or (hi + 0.05 < w["end"] <= ne):
                    out.append(TWord(w["text"], float(w["start"]), float(w["end"])))
        break
    return out


class ReviewIn(BaseModel):
    action: Literal["approve", "reject", "later", "reset"]
    account_ids: list[int] | None = None
    safety_override: bool = False


def _approve(s, c: Clip, account_ids: list[int] | None, safety_override: bool) -> list[int]:
    if c.safety_flagged and not (safety_override or c.safety_override):
        raise HTTPException(409, "Safety-Hinweis: Dieser Clip braucht deine ausdrückliche Freigabe.")
    if safety_override:
        c.safety_override = True
    c.review_state = "approved"
    c.reviewed_at = utcnow()
    if c.bucket != "review":
        c.bucket = "review"
    if account_ids is None:
        account_ids = c.platforms or [a.id for a in s.scalars(select(SocialAccount).where(SocialAccount.enabled.is_(True))).all()]
    c.platforms = account_ids
    return account_ids


@router.post("/{cid}/review")
def review(cid: int, body: ReviewIn) -> dict:
    with session_scope() as s:
        c = s.get(Clip, cid)
        if c is None:
            raise HTTPException(404, "Clip nicht gefunden")
        accounts: list[int] = []
        if body.action == "approve":
            accounts = _approve(s, c, body.account_ids, body.safety_override)
            need_render = not c.render_path or c.render_status == "stale"
        elif body.action == "reject":
            c.review_state, c.reviewed_at = "rejected", utcnow()
            need_render = False
        elif body.action == "later":
            c.review_state, c.reviewed_at = "later", utcnow()
            need_render = False
        else:
            c.review_state, c.reviewed_at = "pending", None
            need_render = False
    if body.action == "approve":
        if need_render:
            queue.enqueue("render_clip", {"clip_id": cid, "preview": False}, priority=70, unique_key=f"render:{cid}:final", clip_id=cid)
        if accounts:
            schedule_clip(cid, accounts)
    if body.action == "reject":
        from ..db import Publication

        with session_scope() as s:
            for p in s.scalars(select(Publication).where(Publication.clip_id == cid, Publication.status == "scheduled")).all():
                p.status = "cancelled"
    return get_clip(cid)


class BulkIn(BaseModel):
    action: Literal["approve", "reject", "later", "archive", "review"]
    ids: list[int] | None = None
    min_score: float | None = None
    stream_id: int | None = None
    account_ids: list[int] | None = None


@router.post("/bulk")
def bulk(body: BulkIn) -> dict:
    """Sammelaktionen: z. B. alle Clips mit Score ab X freigeben, oder mehrere ausgewählte."""
    done: list[int] = []
    skipped: list[dict] = []
    with session_scope() as s:
        q = select(Clip).where(Clip.bucket == "review")
        if body.ids:
            q = select(Clip).where(Clip.id.in_(body.ids))
        else:
            q = q.where(Clip.review_state.in_(("pending", "later")))
        if body.min_score is not None:
            q = q.where(Clip.total_score >= body.min_score)
        if body.stream_id:
            q = q.where(Clip.stream_id == body.stream_id)
        clips = s.scalars(q).all()
        to_schedule: list[tuple[int, list[int]]] = []
        to_render: list[int] = []
        for c in clips:
            if body.action == "approve":
                if c.safety_flagged and not c.safety_override:
                    skipped.append({"id": c.id, "reason": "Safety-Hinweis – einzeln freigeben"})
                    continue
                accs = _approve(s, c, body.account_ids, False)
                to_schedule.append((c.id, accs))
                if not c.render_path or c.render_status == "stale":
                    to_render.append(c.id)
            elif body.action in ("reject", "later"):
                c.review_state = "rejected" if body.action == "reject" else "later"
                c.reviewed_at = utcnow()
            elif body.action in ("archive", "review"):
                c.bucket = body.action
            done.append(c.id)
    for cid in to_render:
        queue.enqueue("render_clip", {"clip_id": cid, "preview": False}, priority=70, unique_key=f"render:{cid}:final", clip_id=cid)
    for cid, accs in to_schedule:
        if accs:
            schedule_clip(cid, accs)
    return {"done": done, "skipped": skipped}


class RerenderIn(BaseModel):
    preview: bool = True


@router.post("/{cid}/rerender")
def rerender(cid: int, body: RerenderIn) -> dict:
    with session_scope() as s:
        c = s.get(Clip, cid)
        if c is None:
            raise HTTPException(404, "Clip nicht gefunden")
        c.render_status = "queued"
        final_too = c.review_state == "approved"
    if final_too:
        jid = queue.enqueue("render_clip", {"clip_id": cid, "preview": False, "then_preview": True}, priority=25,
                            unique_key=f"render:{cid}:final", clip_id=cid)
    else:
        jid = queue.enqueue("render_clip", {"clip_id": cid, "preview": True}, priority=25, unique_key=f"render:{cid}:preview", clip_id=cid)
    return {"job_id": jid}


@router.post("/{cid}/captions")
def regenerate_captions(cid: int) -> dict:
    return {"job_id": queue.enqueue("captions", {"clip_ids": [cid], "force": True}, priority=30, clip_id=cid)}


@router.post("/{cid}/safety-check")
def safety_check(cid: int) -> dict:
    return {"job_id": queue.enqueue("safety_check", {"clip_id": cid}, priority=30, unique_key=f"safety:{cid}", clip_id=cid)}


class MoveIn(BaseModel):
    bucket: Literal["review", "archive"]


@router.post("/{cid}/move")
def move(cid: int, body: MoveIn) -> dict:
    with session_scope() as s:
        c = s.get(Clip, cid)
        if c is None:
            raise HTTPException(404, "Clip nicht gefunden")
        c.bucket = body.bucket
        if c.review_state in ("rejected",) and body.bucket == "review":
            c.review_state = "pending"
        need_preview = body.bucket == "review" and not c.preview_path
        need_caps = body.bucket == "review" and not c.captions
    if need_preview:
        queue.enqueue("render_clip", {"clip_id": cid, "preview": True}, priority=40, unique_key=f"render:{cid}:preview", clip_id=cid)
    if need_caps:
        queue.enqueue("captions", {"clip_ids": [cid]}, priority=45, clip_id=cid)
    return get_clip(cid)


@router.get("/{cid}/media/{kind}")
def media(cid: int, kind: Literal["preview", "final", "thumb"], download: bool = False):
    with session_scope() as s:
        c = s.get(Clip, cid)
        if c is None:
            raise HTTPException(404, "Clip nicht gefunden")
        path = {"preview": c.preview_path, "final": c.render_path, "thumb": c.thumb_path}[kind]
        slug = c.slug or f"clip-{cid}"
    if not path or not Path(path).exists():
        raise HTTPException(404, "Datei (noch) nicht vorhanden")
    headers = {"Cache-Control": "private, max-age=86400"}
    if kind == "thumb":
        return FileResponse(path, media_type="image/jpeg", headers=headers)
    filename = f"{slug}.mp4" if kind == "final" else f"{slug}_vorschau.mp4"
    return FileResponse(path, media_type="video/mp4", headers=headers, filename=filename if download else None,
                        content_disposition_type="attachment" if download else "inline")
