"""Stufe 7 / Phase 3: Lernschleife.

Freigaben, Ablehnungen und spätere Views werden als kompakte Beispiele in den
Bewertungs-Prompt gelegt. So passt die Auswahl mit der Zeit zum Humor des Streamers
und zu dem, was beim Publikum ankommt.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import Clip, Publication, Stream


def clip_views(clip: Clip) -> int:
    return int(sum((p.metrics or {}).get("views", 0) or 0 for p in clip.publications))


def select_examples(s: Session, channel_id: int | None, n: int = 6) -> dict[str, list[Clip]]:
    q = select(Clip).join(Stream, Clip.stream_id == Stream.id).where(Clip.review_state.in_(("approved", "rejected")))
    if channel_id is not None:
        q = q.where(Stream.channel_id == channel_id)
    clips = s.scalars(q.order_by(Clip.reviewed_at.desc().nullslast(), Clip.id.desc()).limit(300)).all()
    approved = [c for c in clips if c.review_state == "approved"]
    rejected = [c for c in clips if c.review_state == "rejected"]
    published = [c for c in approved if any(p.status == "live" for p in c.publications)]
    top = sorted(published, key=clip_views, reverse=True)
    flop = [c for c in sorted(published, key=clip_views) if c not in top[: max(1, n // 3)]]
    n_top = max(1, n // 3)
    n_flop = 1 if len(published) >= 4 else 0
    n_rej = max(1, n // 3)
    chosen_top = top[:n_top]
    chosen_flop = flop[:n_flop]
    rest_appr = [c for c in approved if c not in chosen_top and c not in chosen_flop][: max(0, n - n_top - n_flop - n_rej)]
    return {"top": chosen_top, "flop": chosen_flop, "approved": rest_appr, "rejected": rejected[:n_rej]}


def build_examples_text(s: Session, channel_id: int | None, n: int = 6) -> str:
    groups = select_examples(s, channel_id, n)
    lines: list[str] = []

    def snippet(c: Clip) -> str:
        t = (c.transcript or "").replace("\n", " ")
        return t[:240] + ("…" if len(t) > 240 else "")

    for c in groups["top"]:
        lines.append(f"✓ TOP ({clip_views(c):,} Views) [{c.category}] „{snippet(c)}“".replace(",", "."))
    for c in groups["flop"]:
        lines.append(f"↓ FLOP ({clip_views(c):,} Views, freigegeben aber schwach) [{c.category}] „{snippet(c)}“".replace(",", "."))
    for c in groups["approved"]:
        lines.append(f"✓ FREIGEGEBEN [{c.category}] „{snippet(c)}“")
    for c in groups["rejected"]:
        lines.append(f"✗ ABGELEHNT [{c.category}] „{snippet(c)}“")
    return "\n".join(lines)


def top_flop(s: Session, limit: int = 10) -> dict[str, list[dict]]:
    pubs = s.scalars(select(Publication).where(Publication.status == "live")).all()
    by_clip: dict[int, dict] = {}
    for p in pubs:
        d = by_clip.setdefault(p.clip_id, {"clip_id": p.clip_id, "title": p.clip.title, "views": 0, "likes": 0, "comments": 0,
                                           "shares": 0, "platforms": [], "thumb": bool(p.clip.thumb_path)})
        m = p.metrics or {}
        for k in ("views", "likes", "comments", "shares"):
            d[k] += int(m.get(k, 0) or 0)
        d["platforms"].append({"platform": p.platform, "url": p.external_url, **{k: m.get(k, 0) for k in ("views", "likes")}})
    rows = sorted(by_clip.values(), key=lambda d: d["views"], reverse=True)
    return {"top": rows[:limit], "flop": list(reversed(rows[-limit:])) if len(rows) > limit else list(reversed(rows))}
