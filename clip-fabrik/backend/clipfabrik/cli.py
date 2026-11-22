"""Kommandozeile: ``clipfabrik api | worker | daemon | all | process <datei> | set-password``."""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import threading
import time
from pathlib import Path

log = logging.getLogger("clipfabrik")


def _boot() -> None:
    from .config import get_settings
    from .db import init_engine
    from .logging_setup import register_secret, setup_logging

    s = get_settings()
    setup_logging(s.log_level)
    for secret in (s.secret_key, s.anthropic_api_key, s.twitch_client_secret, s.admin_password):
        register_secret(secret)
    init_engine()


def _heartbeat(key: str, stop: threading.Event) -> None:
    from . import settings_store

    while not stop.is_set():
        try:
            settings_store.set_value(key, time.time())
        except Exception:  # noqa: BLE001
            log.exception("Heartbeat")
        stop.wait(30)


def cmd_api(args: argparse.Namespace) -> None:
    import uvicorn

    uvicorn.run("clipfabrik.api.app:create_app", factory=True, host=args.host, port=args.port, proxy_headers=True,
                forwarded_allow_ips="*", log_level="info")


def cmd_worker(args: argparse.Namespace) -> None:
    _boot()
    from .config import get_settings
    from .jobs.worker import worker_loop

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    threading.Thread(target=_heartbeat, args=("worker_heartbeat", stop), daemon=True).start()
    n = max(1, args.concurrency or get_settings().worker_concurrency)
    threads = [threading.Thread(target=worker_loop, kwargs={"stop_event": stop}, daemon=True) for _ in range(n)]
    for t in threads:
        t.start()
    try:
        while not stop.is_set():
            time.sleep(1)
    except KeyboardInterrupt:
        stop.set()
    for t in threads:
        t.join(timeout=60)


def cmd_daemon(args: argparse.Namespace) -> None:
    _boot()
    from .daemon import Daemon

    d = Daemon()
    stop = threading.Event()

    def _stop(*_a) -> None:
        d.stop_event.set()
        stop.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    threading.Thread(target=_heartbeat, args=("daemon_heartbeat", stop), daemon=True).start()
    d.run_forever()


def cmd_all(args: argparse.Namespace) -> None:
    """Alles in einem Prozess (für kleine Server/Entwicklung)."""
    _boot()
    from .daemon import Daemon
    from .jobs.worker import worker_loop

    stop = threading.Event()
    threading.Thread(target=_heartbeat, args=("worker_heartbeat", stop), daemon=True).start()
    threading.Thread(target=_heartbeat, args=("daemon_heartbeat", stop), daemon=True).start()
    threading.Thread(target=worker_loop, kwargs={"stop_event": stop}, daemon=True).start()
    d = Daemon()
    threading.Thread(target=d.run_forever, daemon=True).start()
    cmd_api(args)
    stop.set()
    d.stop_event.set()


def cmd_process(args: argparse.Namespace) -> None:
    """Datei direkt verarbeiten (ohne Server), z. B. zum Ausprobieren."""
    _boot()
    from .db import Clip, session_scope
    from .ingest import create_stream_from_file
    from .jobs.worker import run_one

    sid = create_stream_from_file(Path(args.file).resolve(), source_type="upload", title=args.title or Path(args.file).stem)
    while run_one("cli"):
        pass
    with session_scope() as s:
        clips = s.query(Clip).filter(Clip.stream_id == sid, Clip.bucket == "review").order_by(Clip.rank).all()
        for c in clips:
            print(f"#{c.id} [{c.total_score:.1f}] {c.title} ({c.duration:.0f}s) -> {c.preview_path}")


def cmd_set_password(args: argparse.Namespace) -> None:
    _boot()
    from . import auth, settings_store

    if len(args.password) < 10:
        sys.exit("Passwort braucht mindestens 10 Zeichen")
    settings_store.set_value("admin_password_hash", auth.hash_password(args.password))
    print("Passwort gesetzt")


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="clipfabrik", description="Clip-Fabrik")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, fn in (("api", cmd_api), ("all", cmd_all)):
        sp = sub.add_parser(name)
        sp.add_argument("--host", default="0.0.0.0")
        sp.add_argument("--port", type=int, default=8000)
        sp.set_defaults(fn=fn)
    sp = sub.add_parser("worker")
    sp.add_argument("--concurrency", type=int, default=0)
    sp.set_defaults(fn=cmd_worker)
    sub.add_parser("daemon").set_defaults(fn=cmd_daemon)
    sp = sub.add_parser("process")
    sp.add_argument("file")
    sp.add_argument("--title", default="")
    sp.set_defaults(fn=cmd_process)
    sp = sub.add_parser("set-password")
    sp.add_argument("password")
    sp.set_defaults(fn=cmd_set_password)
    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
