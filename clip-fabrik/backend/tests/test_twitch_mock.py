"""Aufnahme und Live-Erkennung gegen einen Mock-Twitch-Server (Helix + HLS + IRC) mit echtem streamlink.

Prüft: Kanal anlegen (Zustimmung, Helix-Lookup), Mod-Login (OAuth), EventSub-Registrierung,
Live-Erkennung per Polling, Aufnahme in Segmenten, Chat mitlesen, Chat-Spitze -> Live-Kandidat,
!clip von Mods -> Marker, Twitch-Clip als Marker, „Jetzt clippen“, Verbindungsabbruch -> Reconnect
mit Lückenmarkierung, Stream-Ende -> Modus A (Gesamt-Durchlauf), Live-Clips bleiben erhalten.
"""

from __future__ import annotations

import json
import shutil
import threading
import time
from pathlib import Path

import pytest

from clipfabrik.db import Channel, Clip, Job, Marker, Segment, Stream, session_scope
from clipfabrik.devtools.mock_twitch import MockTwitch

pytestmark = pytest.mark.slow

LOGIN = "teststreamer"


def wait_for(cond, timeout: float, step: float = 0.5, msg: str = ""):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = cond()
        if last:
            return last
        time.sleep(step)
    raise AssertionError(f"Zeitüberschreitung: {msg} (zuletzt: {last})")


@pytest.fixture()
def mock_twitch(monkeypatch):
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg fehlt")
    m = MockTwitch().start()
    m.add_user(LOGIN, "4242")
    for k, v in m.env().items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("SEGMENT_SECONDS", "4")
    yield m
    m.stop()


def test_live_detection_recording_chat_and_mode_a(mock_twitch, client, data_dir):
    from clipfabrik import settings_store
    from clipfabrik.daemon import Daemon
    from clipfabrik.jobs.worker import worker_loop

    m = mock_twitch
    settings_store.set_value("manual_lookback", 20)
    settings_store.set_value("live_delay_seconds", 10)

    # Kanal ohne Zustimmung -> abgelehnt
    assert client.post("/api/channels", json={"login": LOGIN}).status_code == 400
    r = client.post("/api/channels", json={"login": LOGIN, "consent": True, "live_enabled": True, "post_enabled": True})
    assert r.status_code == 200, r.text
    ch = r.json()
    assert ch["display_name"] == LOGIN and ch["consent_confirmed"]
    client.patch(f"/api/channels/{ch['id']}", json={"create_twitch_clips": True, "chat_clip_command": True, "min_score": 6})

    # Mod-Login per OAuth (Mock-Twitch)
    url = client.get("/api/twitch/login").json()["url"]
    assert "scope=chat%3Aread+clips%3Aedit" in url
    state = url.split("state=")[1].split("&")[0]
    cb = client.get(f"/api/twitch/callback?code=mockcode&state={state}", follow_redirects=False)
    assert "twitch=ok" in cb.headers["location"]
    status = client.get("/api/status").json()
    assert status["twitch_mod"]["login"] == "modmaus"

    stop = threading.Event()
    daemon = Daemon(poll_interval=1.0, tick=0.5)
    dt_ = threading.Thread(target=daemon.run_forever, daemon=True)
    wt = threading.Thread(target=worker_loop, kwargs={"stop_event": stop, "idle_sleep": 0.5}, daemon=True)
    dt_.start()
    wt.start()
    try:
        # EventSub-Registrierung (PUBLIC_URL ist https)
        wait_for(lambda: len(m.eventsub) >= 2, 10, msg="EventSub-Abos")
        assert {e["type"] for e in m.eventsub} == {"stream.online", "stream.offline"}
        assert m.eventsub[0]["transport"]["callback"].endswith("/api/twitch/eventsub")

        # --- Stream geht live
        m.set_live(LOGIN, True)
        wait_for(lambda: client.get("/api/channels").json()[0]["status"] == "recording", 15, msg="Aufnahme startet")
        cur = client.get("/api/channels").json()[0]["current_stream"]
        sid = cur["id"]
        wait_for(lambda: m.irc_joined(LOGIN), 15, msg="Chat verbunden")

        def complete_segments():
            with session_scope() as s:
                return s.query(Segment).filter(Segment.stream_id == sid, Segment.complete.is_(True)).count()

        wait_for(lambda: complete_segments() >= 3, 40, msg="Segmente")

        # --- Chat: Grundrauschen, dann Spitze mit Emote-Spam
        for i in range(10):
            m.say(LOGIN, f"viewer{i}", "na wie gehts")
            time.sleep(0.3)
        for i in range(30):
            m.say(LOGIN, f"user{i}", "KEKW KEKW OMEGALUL")
            time.sleep(0.05)
        # --- !clip von einem Mod (und von einem normalen Zuschauer, der ignoriert wird)
        m.say(LOGIN, "Zuschauer", "!clip")
        m.say(LOGIN, "ModMaus2", "!clip", mod=True)

        def markers():
            with session_scope() as s:
                return {mk.source for mk in s.query(Marker).filter(Marker.stream_id == sid).all()}

        wait_for(lambda: {"auto", "chat_command"} <= markers(), 20, msg="Marker aus Chat")
        with session_scope() as s:
            cmd_markers = s.query(Marker).filter(Marker.stream_id == sid, Marker.source == "chat_command").all()
            assert len(cmd_markers) == 1 and "ModMaus2" in cmd_markers[0].note
        wait_for(lambda: len(m.clips_created) >= 1, 10, msg="Twitch-Clip als Marker")
        assert m.clips_created[0]["broadcaster_id"] == "4242"

        # --- Live-Clip entsteht während des Streams; Marker zum selben Moment werden zusammengefasst
        def live_clips():
            with session_scope() as s:
                return s.query(Clip).filter(Clip.stream_id == sid, Clip.origin.in_(("live", "manual"))).count()

        def debug_jobs():
            with session_scope() as s:
                for j in s.query(Job).filter(Job.type == "live_candidate").all():
                    print("JOB", j.id, j.status, j.progress_msg, j.error)

        try:
            wait_for(lambda: live_clips() >= 1, 90, step=1, msg="Live-Clip")
            wait_for(lambda: _job_msgs("live_candidate", "schon als Clip"), 40, step=1, msg="Dublette erkannt")
        except AssertionError:
            debug_jobs()
            raise
        first_marker_wall = time.time()

        # --- „Jetzt clippen“ vom Handy, 30 s später (anderer Moment)
        time.sleep(max(0.0, 30 - (time.time() - first_marker_wall)))
        r = client.post(f"/api/channels/{ch['id']}/clip-now", json={"lookback": 20})
        assert r.status_code == 200, r.text
        try:
            wait_for(lambda: live_clips() >= 2, 90, step=1, msg="zweiter Live-Clip")
        except AssertionError:
            debug_jobs()
            raise
        assert client.get("/api/channels").json()[0]["live_clips"] >= 2

        # --- Verbindungsabbruch -> Reconnect mit neuer Aufnahme-Runde
        m.interrupt(LOGIN, 7)
        wait_for(lambda: _runs(sid) >= 2 and _complete_in_run(sid, 1) >= 1, 60, step=1, msg="Reconnect")

        # --- Stream endet -> Modus A
        m.set_live(LOGIN, False)
        wait_for(lambda: client.get(f"/api/streams/{sid}").json()["status"] in ("processing", "done"), 30, msg="Analyse startet")
        wait_for(lambda: client.get(f"/api/streams/{sid}").json()["status"] == "done", 240, step=1, msg="Modus A fertig")
    finally:
        daemon.stop_event.set()
        stop.set()
        dt_.join(timeout=30)
        wt.join(timeout=60)

    st = client.get(f"/api/streams/{sid}").json()
    assert st["duration"] > 20
    assert st["gaps"], "Verbindungsabbruch muss als Lücke markiert sein"
    assert any("Verbindung" in g["reason"] for g in st["gaps"])
    with session_scope() as s:
        stream = s.get(Stream, sid)
        assert Path(stream.source_path).exists()
        assert stream.ended_at is not None
        clips = s.query(Clip).filter(Clip.stream_id == sid, Clip.bucket != "discarded").all()
        assert any(c.origin in ("live", "manual") for c in clips), "Live-Funde bleiben nach dem Gesamt-Durchlauf erhalten"
        assert all(c.preview_path and Path(c.preview_path).exists() for c in clips if c.bucket == "review" and c.review_state == "pending")
        chan = s.query(Channel).first()
        assert chan.status in ("offline", "analyzing")
        failed = s.query(Job).filter(Job.status == "failed").all()
        assert not failed, [(j.type, j.error) for j in failed]
    chat_lines = (Path(stream.dir) / "chat.jsonl").read_text().splitlines()
    assert sum(1 for ln in chat_lines if "KEKW" in json.loads(ln)["text"]) == 30


def _job_msgs(job_type: str, needle: str) -> bool:
    with session_scope() as s:
        return any(needle in (j.progress_msg or "") for j in s.query(Job).filter(Job.type == job_type).all())


def _runs(sid: int) -> int:
    with session_scope() as s:
        return len({seg.run for seg in s.query(Segment).filter(Segment.stream_id == sid).all()})


def _complete_in_run(sid: int, run: int) -> int:
    with session_scope() as s:
        return s.query(Segment).filter(Segment.stream_id == sid, Segment.run == run, Segment.complete.is_(True)).count()


def test_eventsub_webhook_sets_live_hint(client, data_dir):
    import hashlib
    import hmac
    from datetime import datetime, timezone

    from clipfabrik.twitch.eventsub import eventsub_secret

    with session_scope() as s:
        s.add(Channel(login="abc", twitch_user_id="77", consent_confirmed=True))
    secret = eventsub_secret()

    def post(mtype: str, payload: dict, mid: str):
        body = json.dumps(payload).encode()
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        sig = "sha256=" + hmac.new(secret.encode(), mid.encode() + ts.encode() + body, hashlib.sha256).hexdigest()
        return client.post("/api/twitch/eventsub", content=body, headers={
            "Twitch-Eventsub-Message-Id": mid, "Twitch-Eventsub-Message-Timestamp": ts,
            "Twitch-Eventsub-Message-Signature": sig, "Twitch-Eventsub-Message-Type": mtype, "Content-Type": "application/json"})

    r = post("webhook_callback_verification", {"challenge": "pogchamp-123", "subscription": {}}, "m1")
    assert r.status_code == 200 and r.text == "pogchamp-123"
    r = post("notification", {"subscription": {"type": "stream.online"},
                               "event": {"broadcaster_user_id": "77", "broadcaster_user_login": "abc"}}, "m2")
    assert r.status_code == 204
    with session_scope() as s:
        assert s.query(Channel).filter(Channel.login == "abc").one().live_hint == "online"
    # Wiederholung derselben Nachricht wird ignoriert, falsche Signatur abgelehnt
    assert post("notification", {"subscription": {"type": "stream.offline"}, "event": {"broadcaster_user_id": "77"}}, "m2").status_code == 204
    with session_scope() as s:
        assert s.query(Channel).filter(Channel.login == "abc").one().live_hint == "online"
    bad = client.post("/api/twitch/eventsub", content=b"{}", headers={"Twitch-Eventsub-Message-Id": "x", "Twitch-Eventsub-Message-Timestamp": "y",
                                                                      "Twitch-Eventsub-Message-Signature": "sha256=00"})
    assert bad.status_code == 403
