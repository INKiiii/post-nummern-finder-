"""Demo-Daten: Kanal mit Zustimmung, synthetische Streams durch die komplette Pipeline,
Mock-Konto, ein freigegebener und eingeplanter Clip. Für Oberflächen-Tests und Vorführung.

    DATA_DIR=./demo-data CLIPFABRIK_FAKE_AI=1 python -m clipfabrik.devtools.seed_demo
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from .. import crypto
from ..config import get_settings
from ..db import Channel, Clip, SocialAccount, Stream, init_engine, session_scope, utcnow
from ..jobs.worker import run_one
from ..logging_setup import setup_logging
from ..sources import epoch
from .synthetic import SCRIPT, chat_burst, make_test_video


def main() -> None:
    setup_logging("WARNING")
    s = get_settings()
    init_engine()
    from .. import auth

    auth.ensure_admin_password()
    video = s.data_dir / "demo_source.mp4"
    if not video.exists():
        print("Erzeuge synthetisches Stream-Video …")
        make_test_video(video)
    with session_scope() as db:
        ch = db.query(Channel).filter(Channel.login == "meinkollege").one_or_none()
        if ch is None:
            ch = Channel(login="meinkollege", display_name="MeinKollege", consent_confirmed=True, consent_at=utcnow(),
                         live_enabled=True, post_enabled=True, clips_per_stream=15, min_score=6.5,
                         brand_voice="frech, selbstironisch, nie gemein")
            db.add(ch)
            db.flush()
        ch2 = db.query(Channel).filter(Channel.login == "zweitkanal").one_or_none()
        if ch2 is None:
            ch2 = Channel(login="zweitkanal", display_name="Zweitkanal", consent_confirmed=True, consent_at=utcnow(),
                          live_enabled=True, post_enabled=True, status="recording")
            db.add(ch2)
            db.flush()
            live = Stream(channel_id=ch2.id, source_type="twitch", title="Ranked bis 3 Uhr", status="recording",
                          dir=str(s.streams_dir / "live-demo"), duration=5421, live_mode=True)
            db.add(live)
        ch_id = ch.id
    from ..ingest import create_stream_from_file

    titles = ["Turnier Tag 1", "Horror-Nacht", "Speedrun-Versuch"]
    for i, title in enumerate(titles):
        sid = create_stream_from_file(video, source_type="upload", title=title, channel_id=ch_id, auto_process=True)
        with session_scope() as db:
            st = db.get(Stream, sid)
            sdir = Path(st.dir)
            start = epoch(st.started_at)
        (sdir / "audio.wav.script.json").write_text(json.dumps(SCRIPT, ensure_ascii=False), encoding="utf-8")
        with open(sdir / "chat.jsonl", "w", encoding="utf-8") as f:
            for e in chat_burst(start, at=41.0 + i):
                f.write(json.dumps(e, ensure_ascii=False) + "\n")
        print(f"Verarbeite Stream {sid} ({title}) …")
        while run_one("demo"):
            pass
    with session_scope() as db:
        acc = db.query(SocialAccount).filter(SocialAccount.platform == "mock").one_or_none()
        if acc is None:
            acc = SocialAccount(platform="mock", name="Test-Konto", external_id="mock-1", daily_limit=5, status="connected",
                                tokens_enc=crypto.encrypt_json({"access_token": "a", "refresh_token": "r", "expires_at": None,
                                                                "scopes": [], "extra": {}}))
            db.add(acc)
            db.flush()
        acc_id = acc.id
        first = db.query(Clip).filter(Clip.bucket == "review").order_by(Clip.total_score.desc()).first()
        first_id = first.id if first else None
    if first_id:
        from ..publish.scheduler import schedule_clip

        with session_scope() as db:
            c = db.get(Clip, first_id)
            c.review_state = "approved"
            c.reviewed_at = utcnow()
        schedule_clip(first_id, [acc_id])
    with session_scope() as db:
        n = db.query(Clip).filter(Clip.bucket == "review").count()
    print(f"Fertig: {n} Clips in der Review-Liste. Passwort: ADMIN_PASSWORD aus der Umgebung.")


if __name__ == "__main__":
    sys.exit(main())
