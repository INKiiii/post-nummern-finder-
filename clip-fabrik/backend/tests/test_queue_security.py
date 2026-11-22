"""Job-Queue (Wiederaufnahme, Backoff), Verschlüsselung, Log-Schwärzung, Login-Schutz, Push-Ratenbegrenzung."""

from __future__ import annotations

import datetime as dt
import logging

import pytest

from clipfabrik.db import Job, PushSubscription, session_scope, utcnow
from clipfabrik.jobs import queue
from clipfabrik.jobs.worker import HANDLERS, PermanentJobError, RetryLater, register, run_one


@pytest.fixture()
def handlers():
    saved = dict(HANDLERS)
    from clipfabrik.jobs import handlers as _h  # noqa: F401  (echte Handler registrieren)

    yield HANDLERS
    HANDLERS.clear()
    HANDLERS.update(saved)


def test_enqueue_unique_and_priority(data_dir, handlers):
    a = queue.enqueue("t_a", {"x": 1}, unique_key="k1", priority=100)
    b = queue.enqueue("t_a", {"x": 2}, unique_key="k1", priority=100)
    assert a == b
    c = queue.enqueue("t_b", {}, priority=10)
    job = queue.claim("w")
    assert job.id == c, "kleinere Priorität zuerst"


def test_checkpoint_resume_after_crash(data_dir, handlers):
    calls = []

    @register("t_steps")
    def steps(ctx):
        if not ctx.done_step("eins"):
            calls.append("eins")
            ctx.checkpoint("eins", zwischen=42)
        if ctx.payload.get("crash") and not ctx.state.get("crashed"):
            ctx.state["crashed"] = True
            queue.save_state(ctx.job_id, ctx.state)
            raise SystemExit("Absturz simuliert")
        calls.append(f"zwei:{ctx.state['zwischen']}")
        return "ok"

    jid = queue.enqueue("t_steps", {"crash": True})
    with pytest.raises(SystemExit):
        run_one("w1")
    with session_scope() as s:
        assert s.get(Job, jid).status == "running"
        s.get(Job, jid).heartbeat_at = utcnow() - dt.timedelta(minutes=5)
    assert queue.requeue_stale() == 1
    assert run_one("w2")
    with session_scope() as s:
        j = s.get(Job, jid)
        assert j.status == "done" and j.attempts == 1
    assert calls == ["eins", "zwei:42"], "Schritt eins darf nach dem Neustart nicht wiederholt werden"


def test_retry_with_backoff_then_failed(data_dir, handlers, monkeypatch):
    monkeypatch.setattr("clipfabrik.jobs.worker._notify_failure", lambda *a, **k: None)

    @register("t_fail")
    def failing(ctx):
        raise RuntimeError("kaputt")

    jid = queue.enqueue("t_fail", {}, max_attempts=2)
    run_one("w")
    with session_scope() as s:
        j = s.get(Job, jid)
        assert j.status == "queued" and "kaputt" in j.error
        assert j.run_after > utcnow() + dt.timedelta(seconds=20)
        j.run_after = utcnow()
    run_one("w")
    with session_scope() as s:
        j = s.get(Job, jid)
        assert j.status == "failed" and "Fehlgeschlagen" in j.progress_msg
    assert queue.backoff_seconds(1) == 30 and queue.backoff_seconds(3) == 480


def test_permanent_error_and_retry_later(data_dir, handlers, monkeypatch):
    monkeypatch.setattr("clipfabrik.jobs.worker._notify_failure", lambda *a, **k: None)

    @register("t_perm")
    def perm(ctx):
        raise PermanentJobError("Zustimmung fehlt")

    @register("t_later")
    def later(ctx):
        raise RetryLater(30, "noch nicht aufgenommen")

    p = queue.enqueue("t_perm", {})
    lt = queue.enqueue("t_later", {})
    run_one("w")
    run_one("w")
    with session_scope() as s:
        assert s.get(Job, p).status == "failed"
        j = s.get(Job, lt)
        assert j.status == "queued" and j.attempts == 0 and j.run_after > utcnow()


def test_cancel_and_retry(data_dir, handlers):
    jid = queue.enqueue("t_x", {})
    assert queue.cancel(jid)
    assert queue.retry_job(jid)
    with session_scope() as s:
        assert s.get(Job, jid).status == "queued"


# ------------------------------------------------------------------ Secrets
def test_crypto_roundtrip_and_wrong_key(data_dir):
    from clipfabrik import crypto

    enc = crypto.encrypt("sk-ant-geheim-123456")
    assert enc.startswith("enc:v1:") and "geheim" not in enc
    assert crypto.decrypt(enc) == "sk-ant-geheim-123456"
    with pytest.raises(crypto.DecryptionError):
        crypto.decrypt(enc, secret_key="anderer-schluessel")


def test_settings_secrets_encrypted_and_masked(data_dir):
    from clipfabrik import settings_store
    from clipfabrik.db import AppSetting

    settings_store.update_settings({"anthropic_api_key": "sk-ant-api03-ABCDEFGHIJKLMNOP", "claude_model": "claude-opus-5-5"})
    with session_scope() as s:
        raw = s.get(AppSetting, "anthropic_api_key").value
    assert raw.startswith("enc:v1:")
    pub = settings_store.public_settings()
    assert pub["anthropic_api_key"] == {"set": True, "masked": "••••MNOP"}
    assert pub["claude_model"] == "claude-opus-5-5"
    settings_store.update_settings({"anthropic_api_key": ""})  # leeres Feld ändert nichts
    assert settings_store.get("anthropic_api_key") == "sk-ant-api03-ABCDEFGHIJKLMNOP"


def test_log_redaction(caplog):
    from clipfabrik.logging_setup import RedactingFilter, register_secret

    register_secret("supergeheimes-token-xyz")
    logger = logging.getLogger("test.redact")
    logger.addFilter(RedactingFilter())
    with caplog.at_level(logging.INFO, logger="test.redact"):
        logger.info("Token %s und Header Authorization: Bearer abcdefghijklmnop", "supergeheimes-token-xyz")
        logger.info("key sk-ant-api03-zzzzzzzzzzzzzzzzzzzz und access_token=12345678abc")
    text = caplog.text
    assert "supergeheimes-token-xyz" not in text and "abcdefghijklmnop" not in text
    assert "zzzzzzzzzzzz" not in text and "12345678abc" not in text
    assert "[geschwärzt]" in text


# ------------------------------------------------------------------ Login
def test_login_required_and_lockout(data_dir):
    from fastapi.testclient import TestClient

    from clipfabrik.api.app import create_app

    with TestClient(create_app(), base_url="https://testserver") as c:
        assert c.get("/api/channels").status_code == 401
        for _ in range(5):
            assert c.post("/api/auth/login", json={"password": "falsch"}).status_code == 401
        r = c.post("/api/auth/login", json={"password": "test-passwort-123"})
        assert r.status_code == 429, "nach 5 Fehlversuchen gesperrt"


def test_password_change_invalidates_sessions(client):
    from conftest import PASSWORD

    old_cookie = client.cookies.get("cf_session")
    r = client.post("/api/auth/password", json={"old": PASSWORD, "new": "ganz-neues-passwort"})
    assert r.status_code == 200
    assert client.get("/api/channels").status_code == 200  # neue Session gesetzt
    client.cookies.clear()
    client.cookies.set("cf_session", old_cookie)
    assert client.get("/api/channels").status_code == 401


# ------------------------------------------------------------------ Push
def test_push_rate_limit_and_disabled_events(data_dir, monkeypatch):
    from clipfabrik import settings_store
    from clipfabrik.push import notify as n

    sent = []
    monkeypatch.setattr("pywebpush.webpush", lambda **kw: sent.append(kw))
    with session_scope() as s:
        s.add(PushSubscription(endpoint="https://push.example/abc", keys={"p256dh": "x", "auth": "y"}))
    r1 = n.notify("strong_clip", "Clip mit Score 9 bereit", "A", url="/review")
    r2 = n.notify("strong_clip", "Clip mit Score 9.5 bereit", "B", url="/review")
    assert r1["webpush"] == 1 and r2 == {"suppressed": True}
    assert len(sent) == 1 and '"url": "/review"' in sent[0]["data"]
    assert n.notify("clips_ready", "10 neue Clips", "x")["webpush"] == 1, "andere Ereignisse sind nicht begrenzt"
    settings_store.update_settings({"push_events": {**settings_store.get("push_events"), "stream_started": False}})
    assert n.notify("stream_started", "live", "")["skipped"] == "deaktiviert"


def test_push_removes_expired_subscription(data_dir, monkeypatch):
    from pywebpush import WebPushException

    from clipfabrik.push import notify as n

    class Resp:
        status_code = 410

    def boom(**kw):
        raise WebPushException("weg", response=Resp())

    monkeypatch.setattr("pywebpush.webpush", boom)
    with session_scope() as s:
        s.add(PushSubscription(endpoint="https://push.example/old", keys={"p256dh": "x", "auth": "y"}))
    n.notify("error", "Fehler", "x")
    with session_scope() as s:
        assert s.query(PushSubscription).count() == 0


def test_vapid_keys_generated_once(data_dir):
    from clipfabrik.push.notify import vapid_keys

    a = vapid_keys()
    b = vapid_keys()
    assert a == b and len(a[0]) > 80 and "PRIVATE KEY" in a[1]
