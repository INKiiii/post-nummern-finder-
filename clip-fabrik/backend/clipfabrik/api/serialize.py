"""JSON-Darstellung der Modelle für das Frontend."""

from __future__ import annotations

import datetime as dt
from typing import Any

from ..db import Channel, Clip, Job, Publication, SocialAccount, Stream
from ..llm.prompts import SAFETY_LABELS
from ..media.subtitles import Word, chunk_texts


def iso(t: dt.datetime | None) -> str | None:
    return (t.isoformat() + "Z") if t else None


def clip_out(c: Clip, *, full: bool = False) -> dict[str, Any]:
    flags = (c.safety or {}).get("flags", [])
    d: dict[str, Any] = {
        "id": c.id, "stream_id": c.stream_id, "origin": c.origin, "review_state": c.review_state, "bucket": c.bucket,
        "rank": c.rank, "start": c.start, "end": c.end, "duration": round(c.duration, 1), "title": c.title,
        "hook_text": c.hook_text, "context_line": c.context_line, "category": c.category, "reason": c.reason,
        "scores": c.scores, "total_score": c.total_score, "safety_flagged": c.safety_flagged, "safety_override": c.safety_override,
        "safety_flags": flags, "safety_labels": [SAFETY_LABELS.get(f, f) for f in flags], "safety_note": (c.safety or {}).get("note", ""),
        "live_confirmed": c.live_confirmed, "render_status": c.render_status, "render_error": c.render_error,
        "has_preview": bool(c.preview_path), "has_final": bool(c.render_path), "version": c.render_version,
        "preview_url": f"/api/clips/{c.id}/media/preview?v={c.render_version}" if c.preview_path else None,
        "thumb_url": f"/api/clips/{c.id}/media/thumb?v={c.render_version}" if c.thumb_path else None,
        "final_url": f"/api/clips/{c.id}/media/final?v={c.render_version}" if c.render_path else None,
        "platforms": c.platforms or [], "created_at": iso(c.created_at), "reviewed_at": iso(c.reviewed_at),
        "channel": (c.stream.channel.display_name or c.stream.channel.login) if c.stream and c.stream.channel else (c.stream.title if c.stream else ""),
        "publications": [pub_out(p, with_clip=False) for p in c.publications] if full else
        [{"platform": p.platform, "status": p.status} for p in c.publications],
    }
    if full:
        words = [Word.from_dict(w) for w in c.words or []]
        d.update({
            "transcript": c.transcript, "words": c.words, "cuts": c.cuts, "signals": c.signals,
            "subtitle_lines": c.subtitle_lines if c.subtitle_lines is not None else chunk_texts(words),
            "captions": c.captions or {}, "safety": c.safety or {},
            "stream_duration": c.stream.duration if c.stream else None, "slug": c.slug,
        })
    return d


def channel_out(ch: Channel, *, current: Stream | None = None, live_clips: int = 0, pending: int = 0) -> dict[str, Any]:
    return {
        "id": ch.id, "login": ch.login, "display_name": ch.display_name or ch.login, "profile_image_url": ch.profile_image_url,
        "status": ch.status, "live_enabled": ch.live_enabled, "post_enabled": ch.post_enabled, "clips_per_stream": ch.clips_per_stream,
        "min_score": ch.min_score, "language": ch.language, "brand_voice": ch.brand_voice, "create_twitch_clips": ch.create_twitch_clips,
        "chat_clip_command": ch.chat_clip_command, "vod_backup": ch.vod_backup, "layout": ch.layout, "facecam_rect": ch.facecam_rect,
        "consent_confirmed": ch.consent_confirmed, "consent_at": iso(ch.consent_at), "streamer_authorized": ch.streamer_authorized,
        "last_error": ch.last_error, "last_checked_at": iso(ch.last_checked_at),
        "current_stream": stream_out(current) if current else None, "live_clips": live_clips, "pending_review": pending,
    }


def stream_out(st: Stream, *, counts: dict | None = None) -> dict[str, Any]:
    return {
        "id": st.id, "channel_id": st.channel_id, "source_type": st.source_type, "title": st.title, "game": st.game,
        "status": st.status, "started_at": iso(st.started_at), "ended_at": iso(st.ended_at), "duration": round(st.duration or 0, 1),
        "gaps": st.gaps or [], "cost_estimate_usd": st.cost_estimate_usd, "cost_actual_usd": round(st.cost_actual_usd or 0, 4),
        "live_mode": st.live_mode, "post_mode": st.post_mode, "error": st.error, "raw_deleted": st.raw_deleted,
        "selection": (st.meta or {}).get("selection"), "ads": len((st.meta or {}).get("ads", [])),
        "reconnects": len((st.meta or {}).get("reconnects", [])), "counts": counts or {},
        "channel": (st.channel.display_name or st.channel.login) if st.channel else None,
    }


def job_out(j: Job) -> dict[str, Any]:
    return {
        "id": j.id, "type": j.type, "status": j.status, "progress": round(j.progress or 0, 3), "progress_msg": j.progress_msg,
        "step": j.step, "attempts": j.attempts, "max_attempts": j.max_attempts, "error": j.error, "stream_id": j.stream_id,
        "clip_id": j.clip_id, "created_at": iso(j.created_at), "started_at": iso(j.started_at), "finished_at": iso(j.finished_at),
        "run_after": iso(j.run_after),
    }


def pub_out(p: Publication, *, with_clip: bool = True) -> dict[str, Any]:
    d = {
        "id": p.id, "clip_id": p.clip_id, "account_id": p.account_id, "platform": p.platform, "status": p.status,
        "position": p.position, "scheduled_at": iso(p.scheduled_at), "attempts": p.attempts, "next_retry_at": iso(p.next_retry_at),
        "error": p.error, "external_url": p.external_url, "published_at": iso(p.published_at), "metrics": p.metrics or {},
        "account_name": p.account.name if p.account else "",
    }
    if with_clip and p.clip:
        d["clip"] = {"id": p.clip.id, "title": p.clip.title, "total_score": p.clip.total_score, "duration": round(p.clip.duration, 1),
                     "thumb_url": f"/api/clips/{p.clip.id}/media/thumb?v={p.clip.render_version}" if p.clip.thumb_path else None}
    return d


def account_out(a: SocialAccount, quota: dict | None = None) -> dict[str, Any]:
    return {
        "id": a.id, "platform": a.platform, "name": a.name, "owner": a.owner, "status": a.status, "daily_limit": a.daily_limit,
        "api_approved": a.api_approved, "post_mode": a.post_mode, "privacy": a.privacy, "windows": a.windows,
        "min_gap_minutes": a.min_gap_minutes, "jitter_minutes": a.jitter_minutes, "enabled": a.enabled, "last_error": a.last_error,
        "token_expires_at": iso(a.token_expires_at), "quota": quota,
    }
