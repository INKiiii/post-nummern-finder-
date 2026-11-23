"""Worker-Prozess: holt Jobs aus der Queue und führt die registrierten Handler aus."""

from __future__ import annotations

import logging
import os
import socket
import threading
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable

from . import queue

log = logging.getLogger(__name__)


class JobCancelled(Exception):
    pass


class PermanentJobError(Exception):
    """Fehler, bei dem ein neuer Versuch nichts bringt (z. B. Datei fehlt, Zustimmung fehlt)."""


class RetryLater(Exception):
    """Kein Fehler: Voraussetzung noch nicht erfüllt (z. B. Moment noch nicht aufgenommen).
    Der Job wird ohne Fehlversuch nach ``seconds`` erneut eingeplant."""

    def __init__(self, seconds: float, reason: str = "") -> None:
        super().__init__(reason or f"neuer Versuch in {seconds:.0f}s")
        self.seconds = seconds


@dataclass
class JobContext:
    job_id: int
    type: str
    payload: dict[str, Any]
    state: dict[str, Any] = field(default_factory=dict)
    worker_id: str = ""
    _last_cancel_check: float = 0.0

    def progress(self, p: float, msg: str | None = None, step: str | None = None) -> None:
        queue.set_progress(self.job_id, p, msg, step)
        now = time.monotonic()
        if now - self._last_cancel_check > 5:
            self._last_cancel_check = now
            if queue.is_cancelled(self.job_id):
                raise JobCancelled()

    def done_step(self, step: str) -> bool:
        return step in self.state.get("_done", [])

    def checkpoint(self, step: str, **data: Any) -> None:
        """Merkt sich, dass ``step`` fertig ist (plus Daten). Nach Neustart wird er übersprungen."""
        done = self.state.setdefault("_done", [])
        if step not in done:
            done.append(step)
        self.state.update(data)
        queue.save_state(self.job_id, self.state)


Handler = Callable[[JobContext], Any]
HANDLERS: dict[str, Handler] = {}


def register(job_type: str) -> Callable[[Handler], Handler]:
    def deco(fn: Handler) -> Handler:
        HANDLERS[job_type] = fn
        return fn

    return deco


def _load_handlers() -> None:
    # Import registriert die Handler per Dekorator
    from . import handlers  # noqa: F401


def run_one(worker_id: str, types: list[str] | None = None) -> bool:
    """Führt höchstens einen Job aus. Liefert True, wenn einer lief."""
    _load_handlers()
    job = queue.claim(worker_id, types)
    if job is None:
        return False
    ctx = JobContext(job_id=job.id, type=job.type, payload=job.payload or {}, state=job.state or {}, worker_id=worker_id)
    handler = HANDLERS.get(job.type)
    if handler is None:
        queue.fail(job.id, f"Unbekannter Job-Typ {job.type}", retry=False)
        return True

    stop = threading.Event()

    def beat() -> None:
        while not stop.wait(20):
            queue.heartbeat(job.id, worker_id)

    t = threading.Thread(target=beat, daemon=True)
    t.start()
    log.info("Starte Job %s (%s), Versuch %s", job.id, job.type, job.attempts)
    try:
        result = handler(ctx)
        queue.complete(job.id, result if isinstance(result, str) else "Fertig")
        log.info("Job %s (%s) fertig", job.id, job.type)
    except JobCancelled:
        log.info("Job %s abgebrochen", job.id)
    except RetryLater as exc:
        queue.reschedule(job.id, exc.seconds, str(exc))
    except PermanentJobError as exc:
        log.error("Job %s (%s) dauerhaft fehlgeschlagen: %s", job.id, job.type, exc)
        queue.fail(job.id, str(exc), retry=False)
        _notify_failure(job.type, job.id, str(exc), job.stream_id)
    except Exception as exc:  # noqa: BLE001 - alles protokollieren, nichts verschlucken
        tb = traceback.format_exc()
        log.error("Job %s (%s) Fehler: %s\n%s", job.id, job.type, exc, tb)
        status = queue.fail(job.id, f"{type(exc).__name__}: {exc}")
        if status == "failed":
            _notify_failure(job.type, job.id, str(exc), job.stream_id)
    finally:
        stop.set()
    return True


def _notify_failure(job_type: str, job_id: int, error: str, stream_id: int | None) -> None:
    try:
        from ..push.notify import notify

        notify("error", "Fehler in der Clip-Fabrik", f"{job_type} (Job {job_id}): {error[:160]}", url="/jobs", stream_id=stream_id)
    except Exception:  # pragma: no cover
        log.exception("Fehler-Push fehlgeschlagen")


def worker_loop(types: list[str] | None = None, stop_event: threading.Event | None = None, idle_sleep: float = 2.0) -> None:
    worker_id = f"{socket.gethostname()}-{os.getpid()}-{threading.get_ident() % 10000}"
    log.info("Worker %s gestartet", worker_id)
    last_stale_check = 0.0
    while not (stop_event and stop_event.is_set()):
        if time.monotonic() - last_stale_check > 30:
            queue.requeue_stale()
            last_stale_check = time.monotonic()
        try:
            ran = run_one(worker_id, types)
        except Exception:  # pragma: no cover - DB kurz gesperrt o. Ä.
            log.exception("Worker-Schleife")
            ran = False
        if not ran:
            time.sleep(idle_sleep)
