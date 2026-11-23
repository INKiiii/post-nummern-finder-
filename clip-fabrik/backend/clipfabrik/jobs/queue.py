"""Eigene Job-Queue auf SQLite.

* ``enqueue`` legt Jobs an (optional mit ``unique_key`` gegen Dubletten).
* ``claim`` holt atomar den wichtigsten fälligen Job (BEGIN IMMEDIATE).
* Jeder laufende Job schreibt einen Heartbeat. Stirbt der Worker (Absturz, Neustart),
  werden Jobs mit altem Heartbeat wieder eingereiht und setzen beim letzten Checkpoint fort.
* Fehler: Wiederholung mit exponentiellem Backoff bis ``max_attempts``, danach ``failed``
  mit Fehlermeldung (keine stillen Fehler).
"""

from __future__ import annotations

import datetime as dt
import logging
from typing import Any

from sqlalchemy import select, update

from ..db import Job, session_scope, utcnow

log = logging.getLogger(__name__)

STALE_AFTER = dt.timedelta(seconds=90)
ACTIVE = ("queued", "running")


def enqueue(
    type: str,
    payload: dict[str, Any] | None = None,
    *,
    priority: int = 100,
    unique_key: str | None = None,
    max_attempts: int = 3,
    run_after: dt.datetime | None = None,
    stream_id: int | None = None,
    clip_id: int | None = None,
) -> int:
    """Legt einen Job an. Existiert schon ein aktiver Job mit gleichem unique_key, wird dessen ID geliefert."""
    with session_scope() as s:
        if unique_key:
            existing = s.scalar(
                select(Job).where(Job.unique_key == unique_key, Job.status.in_(ACTIVE)).limit(1)
            )
            if existing:
                return existing.id
        job = Job(
            type=type,
            payload=payload or {},
            priority=priority,
            unique_key=unique_key,
            max_attempts=max_attempts,
            run_after=run_after or utcnow(),
            stream_id=stream_id,
            clip_id=clip_id,
        )
        s.add(job)
        s.flush()
        log.info("Job %s (%s) eingereiht", job.id, type)
        return job.id


def claim(worker_id: str, types: list[str] | None = None) -> Job | None:
    """Holt atomar den nächsten fälligen Job und markiert ihn als laufend."""
    now = utcnow()
    with session_scope() as s:
        # Atomar über bedingtes UPDATE (status='queued') + rowcount-Prüfung: zwei Worker
        # können denselben Job nie gleichzeitig bekommen.
        q = (
            select(Job)
            .where(Job.status == "queued", Job.run_after <= now)
            .order_by(Job.priority.asc(), Job.id.asc())
            .limit(1)
        )
        if types:
            q = q.where(Job.type.in_(types))
        job = s.scalar(q)
        if job is None:
            return None
        res = s.execute(
            update(Job)
            .where(Job.id == job.id, Job.status == "queued")
            .values(
                status="running",
                locked_by=worker_id,
                heartbeat_at=now,
                started_at=job.started_at or now,
                attempts=Job.attempts + 1,
            )
        )
        if res.rowcount != 1:  # pragma: no cover - parallel geholt
            return None
        s.flush()
        s.refresh(job)
        s.expunge(job)
        return job


def heartbeat(job_id: int, worker_id: str) -> None:
    with session_scope() as s:
        s.execute(
            update(Job).where(Job.id == job_id, Job.locked_by == worker_id).values(heartbeat_at=utcnow())
        )


def set_progress(job_id: int, progress: float, msg: str | None = None, step: str | None = None) -> None:
    values: dict[str, Any] = {"progress": max(0.0, min(1.0, progress)), "heartbeat_at": utcnow()}
    if msg is not None:
        values["progress_msg"] = msg[:300]
    if step is not None:
        values["step"] = step
    with session_scope() as s:
        s.execute(update(Job).where(Job.id == job_id).values(**values))


def save_state(job_id: int, state: dict[str, Any]) -> None:
    with session_scope() as s:
        s.execute(update(Job).where(Job.id == job_id).values(state=state, heartbeat_at=utcnow()))


def complete(job_id: int, msg: str = "Fertig") -> None:
    with session_scope() as s:
        s.execute(
            update(Job)
            .where(Job.id == job_id)
            .values(status="done", progress=1.0, progress_msg=msg[:300], finished_at=utcnow(), locked_by=None)
        )


def backoff_seconds(attempt: int) -> int:
    """30 s, 2 min, 8 min, 32 min … (gedeckelt bei 2 h)."""
    return int(min(7200, 30 * (4 ** max(0, attempt - 1))))


def fail(job_id: int, error: str, *, retry: bool = True) -> str:
    """Markiert einen Fehlschlag. Liefert neuen Status (queued für erneuten Versuch oder failed)."""
    with session_scope() as s:
        job = s.get(Job, job_id)
        if job is None:
            return "missing"
        job.error = error[:4000]
        job.locked_by = None
        if retry and job.attempts < job.max_attempts:
            job.status = "queued"
            job.run_after = utcnow() + dt.timedelta(seconds=backoff_seconds(job.attempts))
            job.progress_msg = f"Fehler, neuer Versuch {job.attempts + 1}/{job.max_attempts}: {error[:200]}"
        else:
            job.status = "failed"
            job.finished_at = utcnow()
            job.progress_msg = f"Fehlgeschlagen: {error[:250]}"
        return job.status


def reschedule(job_id: int, seconds: float, msg: str) -> None:
    """Plant einen Job neu ein, ohne den Versuch als Fehlschlag zu zählen."""
    with session_scope() as s:
        job = s.get(Job, job_id)
        if job is None or job.status != "running":
            return
        job.status = "queued"
        job.locked_by = None
        job.attempts = max(0, job.attempts - 1)
        job.run_after = utcnow() + dt.timedelta(seconds=seconds)
        job.progress_msg = msg[:300]


def cancel(job_id: int) -> bool:
    with session_scope() as s:
        job = s.get(Job, job_id)
        if job is None or job.status not in ACTIVE:
            return False
        job.status = "cancelled"
        job.finished_at = utcnow()
        job.locked_by = None
        return True


def is_cancelled(job_id: int) -> bool:
    with session_scope() as s:
        job = s.get(Job, job_id)
        return job is None or job.status == "cancelled"


def requeue_stale(now: dt.datetime | None = None) -> int:
    """Setzt Jobs zurück, deren Worker keinen Heartbeat mehr sendet (Absturz/Neustart)."""
    now = now or utcnow()
    limit = now - STALE_AFTER
    with session_scope() as s:
        stale = s.scalars(
            select(Job).where(Job.status == "running", (Job.heartbeat_at.is_(None)) | (Job.heartbeat_at < limit))
        ).all()
        for job in stale:
            job.status = "queued"
            job.locked_by = None
            job.attempts = max(0, job.attempts - 1)  # Absturz zählt nicht als Fehlversuch
            job.progress_msg = f"Wird fortgesetzt (ab Schritt „{job.step or 'Start'}“)"
            log.warning("Job %s (%s) ohne Heartbeat, wird fortgesetzt", job.id, job.type)
        return len(stale)


def retry_job(job_id: int) -> bool:
    with session_scope() as s:
        job = s.get(Job, job_id)
        if job is None or job.status not in ("failed", "cancelled"):
            return False
        job.status = "queued"
        job.attempts = 0
        job.error = None
        job.run_after = utcnow()
        job.progress_msg = "Erneut eingereiht"
        return True
