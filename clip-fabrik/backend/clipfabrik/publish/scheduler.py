"""Zeitplaner: verteilt freigegebene Clips auf Sendefenster, mit Tageslimit pro Konto,
Mindestabstand und zufälligem Versatz – keine Massen-Uploads auf einen Schlag."""

from __future__ import annotations

import datetime as dt
import logging
import random
from dataclasses import dataclass
from zoneinfo import ZoneInfo

from sqlalchemy import select

from .. import settings_store
from ..db import Clip, Publication, SocialAccount, session_scope, utcnow
from ..jobs import queue

log = logging.getLogger(__name__)

RETRY_DELAYS = [60, 300, 900, 3600, 4 * 3600]  # Sekunden: 1 min, 5 min, 15 min, 1 h, 4 h
MAX_ATTEMPTS = len(RETRY_DELAYS) + 1


@dataclass
class Slotting:
    windows: list[tuple[str, str]]
    tz: str
    daily_limit: int
    min_gap: dt.timedelta
    jitter: dt.timedelta


def _parse_hm(s: str) -> dt.time:
    h, m = s.split(":")
    return dt.time(int(h), int(m))


def plan_slots(count: int, cfg: Slotting, *, start: dt.datetime, existing: list[dt.datetime] | None = None,
               rng: random.Random | None = None, max_days: int = 60) -> list[dt.datetime]:
    """Plant ``count`` Sendezeiten (UTC, naiv) ab ``start``.

    Regeln: nur innerhalb der Fenster (Lokalzeit), höchstens ``daily_limit`` pro Tag inklusive bestehender
    Termine, Mindestabstand ``min_gap`` zu allen Terminen, zufälliger Versatz bis ``jitter``.
    """
    rng = rng or random.Random()
    tz = ZoneInfo(cfg.tz)
    taken = sorted(existing or [])
    out: list[dt.datetime] = []
    local_start = start.replace(tzinfo=dt.UTC).astimezone(tz)
    day = local_start.date()
    windows = [(_parse_hm(a), _parse_hm(b)) for a, b in cfg.windows] or [(dt.time(10, 0), dt.time(22, 0))]
    for _ in range(max_days):
        if len(out) >= count:
            break
        day_taken = [t for t in taken + out if t.replace(tzinfo=dt.UTC).astimezone(tz).date() == day]
        free = cfg.daily_limit - len(day_taken)
        if free > 0:
            for wa, wb in windows:
                ws = dt.datetime.combine(day, wa, tzinfo=tz).astimezone(dt.UTC).replace(tzinfo=None)
                we = dt.datetime.combine(day, wb, tzinfo=tz).astimezone(dt.UTC).replace(tzinfo=None)
                cursor = max(ws, start)
                while cursor < we and free > 0 and len(out) < count:
                    cand = cursor + dt.timedelta(seconds=rng.uniform(0, cfg.jitter.total_seconds()))
                    if cand >= we:
                        break
                    conflict = [t for t in taken + out if abs((t - cand).total_seconds()) < cfg.min_gap.total_seconds()]
                    if conflict:
                        cursor = max(conflict) + cfg.min_gap
                        continue
                    out.append(cand.replace(microsecond=0))
                    free -= 1
                    cursor = cand + cfg.min_gap
        day += dt.timedelta(days=1)
    return out


def slotting_for(acc: SocialAccount) -> Slotting:
    return Slotting(
        windows=[tuple(w) for w in (acc.windows or settings_store.get("publish_windows") or [])],
        tz=settings_store.get("publish_timezone") or "Europe/Berlin",
        daily_limit=max(1, acc.daily_limit),
        min_gap=dt.timedelta(minutes=max(5, acc.min_gap_minutes)),
        jitter=dt.timedelta(minutes=max(0, acc.jitter_minutes)),
    )


def schedule_clip(clip_id: int, account_ids: list[int]) -> list[int]:
    """Legt Veröffentlichungen für einen freigegebenen Clip an und plant sie ein."""
    created: list[int] = []
    with session_scope() as s:
        clip = s.get(Clip, clip_id)
        if clip is None:
            return []
        for aid in account_ids:
            acc = s.get(SocialAccount, aid)
            if acc is None or not acc.enabled:
                continue
            exists = s.scalar(select(Publication).where(Publication.clip_id == clip_id, Publication.account_id == aid,
                                                        Publication.status.notin_(("cancelled", "failed"))))
            if exists:
                continue
            max_pos = max([p.position for p in s.scalars(select(Publication).where(Publication.account_id == aid)).all()] or [0])
            pub = Publication(clip_id=clip_id, account_id=aid, platform=acc.platform, status="scheduled", position=max_pos + 1)
            s.add(pub)
            s.flush()
            created.append(pub.id)
    for aid in {a for a in account_ids}:
        replan_account(aid)
    return created


def replan_account(account_id: int, now: dt.datetime | None = None) -> None:
    """Verteilt alle geplanten Veröffentlichungen eines Kontos neu (Reihenfolge = position)."""
    now = now or utcnow()
    with session_scope() as s:
        acc = s.get(SocialAccount, account_id)
        if acc is None:
            return
        pending = s.scalars(select(Publication).where(Publication.account_id == account_id, Publication.status == "scheduled")
                            .order_by(Publication.position, Publication.id)).all()
        fixed = [p.published_at or p.scheduled_at for p in s.scalars(select(Publication).where(
            Publication.account_id == account_id, Publication.status.in_(("running", "processing", "live")))).all()
            if (p.published_at or p.scheduled_at) and (p.published_at or p.scheduled_at) > now - dt.timedelta(days=1)]
        slots = plan_slots(len(pending), slotting_for(acc), start=now + dt.timedelta(minutes=2), existing=[f for f in fixed if f],
                           rng=random.Random(account_id * 7919 + len(pending)))
        for p, t in zip(pending, slots):
            p.scheduled_at = t


def reorder(account_id: int, publication_ids: list[int]) -> None:
    with session_scope() as s:
        for pos, pid in enumerate(publication_ids, start=1):
            p = s.get(Publication, pid)
            if p is not None and p.account_id == account_id and p.status == "scheduled":
                p.position = pos
    replan_account(account_id)


def tick(now: dt.datetime | None = None) -> int:
    """Fällige Veröffentlichungen als Jobs einreihen (vom Daemon alle 30 s aufgerufen)."""
    now = now or utcnow()
    n = 0
    with session_scope() as s:
        due = s.scalars(select(Publication).where(
            Publication.status == "scheduled", Publication.scheduled_at.is_not(None), Publication.scheduled_at <= now,
            (Publication.next_retry_at.is_(None)) | (Publication.next_retry_at <= now),
        ).order_by(Publication.scheduled_at)).all()
        ids = [p.id for p in due]
    for pid in ids:
        queue.enqueue("publish", {"publication_id": pid}, priority=60, unique_key=f"publish:{pid}", max_attempts=1)
        n += 1
    return n


def retry_delay(attempt: int) -> int:
    return RETRY_DELAYS[min(attempt - 1, len(RETRY_DELAYS) - 1)]
