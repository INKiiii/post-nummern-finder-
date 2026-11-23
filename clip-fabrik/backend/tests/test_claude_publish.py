"""Claude-Client (Request-Form, Cache, Ablehnung, Kosten), Plattform-Adapter (respx), Zeitplaner, Quota."""

from __future__ import annotations

import datetime as dt
import json
import random
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
import respx

from clipfabrik.db import LLMUsage, SocialAccount, session_scope


# ------------------------------------------------------------------ Claude
class FakeMessages:
    def __init__(self, payloads: list, stop_reason: str = "end_turn") -> None:
        self.payloads = payloads
        self.calls: list[dict] = []
        self.stop_reason = stop_reason

    def create(self, **kw):
        self.calls.append(kw)
        data = self.payloads[min(len(self.calls) - 1, len(self.payloads) - 1)]
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=json.dumps(data))], stop_reason=self.stop_reason,
            stop_details=SimpleNamespace(category="cyber", explanation="x") if self.stop_reason == "refusal" else None,
            usage=SimpleNamespace(input_tokens=1200, output_tokens=300, cache_read_input_tokens=800, cache_creation_input_tokens=0),
            model=kw["model"], _request_id="req_test",
        )


def fake_client(payloads, stop_reason="end_turn"):
    msgs = FakeMessages(payloads, stop_reason)
    return SimpleNamespace(messages=msgs, beta=SimpleNamespace(messages=msgs)), msgs


def test_claude_request_shape_cache_and_cost(data_dir):
    from clipfabrik.llm.ai import ClaudeAI, WindowInput
    from clipfabrik.llm.client import ClaudeClient

    client, msgs = fake_client([{"clips": [{"window_id": 0, "start": 10.0, "end": 30.0, "punchline_at": 28.0, "category": "Fail",
                                            "idea": "Sprung daneben", "hook_text": "Gleich passiert's", "context_start": -1,
                                            "context_end": -1, "context_line": ""}]}])
    ai = ClaudeAI(ClaudeClient(api_key="sk-test", client=client), brand_voice="frech, aber nie gemein", examples="✓ FREIGEGEBEN [Fail] „x“")
    w = WindowInput(0, 0.0, 40.0, 25.0, [{"type": "chat", "t": 25.0, "strength": 3.0, "detail": "40 Nachr."}],
                    [(10.0, 14.0, "Jetzt springe ich"), (26.0, 29.0, "Nein nein nein!")])
    props = ai.propose([w])
    assert len(props) == 1 and props[0].category == "Fail"
    kw = msgs.calls[0]
    assert kw["model"] == "claude-sonnet-5-5"
    assert kw["output_config"]["format"]["type"] == "json_schema"
    assert kw["output_config"]["effort"] == "medium"
    assert kw["betas"] == ["server-side-fallback-2026-07-01"] and kw["fallbacks"] == "default"
    assert all(b.get("cache_control") for b in kw["system"]), "Raster und Beispiele werden gecacht"
    assert "frech, aber nie gemein" in kw["system"][1]["text"]
    assert "[10.0s" in kw["messages"][0]["content"][-1]["text"]
    # zweiter identischer Aufruf -> aus dem Cache, keine zweite API-Abrechnung
    ai.propose([w])
    assert len(msgs.calls) == 1
    with session_scope() as s:
        usages = s.query(LLMUsage).all()
    assert len(usages) == 2 and usages[1].cached
    # input_tokens zählt nur ungecachte Tokens; Cache-Lesen kostet 0,10 $/MTok
    assert usages[0].cost_usd == pytest.approx((1200 * 2 + 800 * 0.1 + 300 * 10) / 1e6)


def test_claude_assess_clamps_and_refusal(data_dir):
    from clipfabrik.llm.ai import CandidateInput, ClaudeAI
    from clipfabrik.llm.client import ClaudeClient

    client, _ = fake_client([{"assessments": [{"id": 0, "hook": 14, "payoff": 8, "clarity": 0, "emotion": 7, "meme": 6, "risk": 2,
                                               "reason": "Starker Fail.", "title": "Sprung ins Nichts", "hook_text": "Er springt…",
                                               "safety_flags": ["unbekannt", "urheberrecht_musik"], "safety_note": "Musik",
                                               "trim_start": 11.0, "trim_end": -1}]}])
    ai = ClaudeAI(ClaudeClient(api_key="sk-test", client=client), vision=False)
    cand = CandidateInput(0, 10, 30, [(10, 12, "x")], "", "chat", "Fail", "idee", "hook")
    a = ai.assess([cand])[0]
    assert a.scores["hook"] == 10 and a.scores["clarity"] == 1
    assert a.safety_flags == ["urheberrecht_musik"]
    assert a.trim_start == 11.0 and a.trim_end is None
    client2, _ = fake_client([{}], stop_reason="refusal")
    ai2 = ClaudeAI(ClaudeClient(api_key="sk-test", client=client2), vision=False)
    cand2 = CandidateInput(1, 40, 60, [(40, 42, "anderer Moment")], "", "chat", "Fail", "idee", "hook")
    a2 = ai2.assess([cand2])[0]
    assert a2.scores["risk"] == 10 and a2.safety_flags


def test_cost_estimate_scales_with_duration(data_dir):
    from clipfabrik.llm.ai import estimate_cost_usd

    one = estimate_cost_usd(duration=3600, clips=15)
    eight = estimate_cost_usd(duration=8 * 3600, clips=15)
    assert 0 < one["usd"] < eight["usd"] < 20
    assert one["windows"] == 25
    assert eight["windows"] == 55, "gedeckelt auf 3 × Quote + 10 wie in der Pipeline"


# ------------------------------------------------------------------ Zeitplaner
def test_plan_slots_respects_windows_limits_gap_jitter():
    from zoneinfo import ZoneInfo

    from clipfabrik.publish.scheduler import Slotting, plan_slots

    cfg = Slotting(windows=[("11:00", "13:00"), ("18:00", "21:00")], tz="Europe/Berlin", daily_limit=3,
                   min_gap=dt.timedelta(minutes=60), jitter=dt.timedelta(minutes=10))
    start = dt.datetime(2026, 11, 23, 6, 0)  # 07:00 Berlin
    slots = plan_slots(7, cfg, start=start, rng=random.Random(1))
    assert len(slots) == 7
    tz = ZoneInfo("Europe/Berlin")
    per_day: dict = {}
    for t in slots:
        lt = t.replace(tzinfo=dt.UTC).astimezone(tz)
        assert dt.time(11, 0) <= lt.time() <= dt.time(13, 0) or dt.time(18, 0) <= lt.time() <= dt.time(21, 0)
        per_day[lt.date()] = per_day.get(lt.date(), 0) + 1
    assert max(per_day.values()) <= 3
    s = sorted(slots)
    assert all((b - a) >= dt.timedelta(minutes=60) for a, b in zip(s, s[1:]))
    assert len(set(t.minute for t in slots)) > 2, "zufälliger Versatz statt glatter Zeiten"


def test_plan_slots_with_existing_bookings():
    from clipfabrik.publish.scheduler import Slotting, plan_slots

    cfg = Slotting(windows=[("10:00", "12:00")], tz="UTC", daily_limit=2, min_gap=dt.timedelta(minutes=30), jitter=dt.timedelta(0))
    start = dt.datetime(2026, 11, 23, 8, 0)
    existing = [dt.datetime(2026, 11, 23, 10, 0), dt.datetime(2026, 11, 23, 11, 0)]
    slots = plan_slots(1, cfg, start=start, existing=existing)
    assert slots[0].date() == dt.date(2026, 11, 24), "Tageslimit durch bestehende Termine schon voll"


def test_youtube_quota_units(data_dir):
    from clipfabrik import settings_store
    from clipfabrik.publish import quota

    with session_scope() as s:
        acc = SocialAccount(platform="youtube", name="Kanal", daily_limit=20)
        s.add(acc)
        s.flush()
        r = quota.remaining(s, acc)
        assert r["cap"] == 6 and r["left"] == 6, "10.000 / 1.600 = 6 Uploads"
        quota.consume(s, acc)
        assert quota.remaining(s, acc)["left"] == 5
    settings_store.set_value("youtube_daily_units", 100000)
    with session_scope() as s:
        acc = s.query(SocialAccount).first()
        assert quota.remaining(s, acc)["cap"] == 20, "eigenes Tageslimit greift nach Erweiterung"


def test_publish_retry_backoff_with_mock(client, data_dir, monkeypatch):
    """Fehler beim Upload -> neuer Versuch mit Backoff, Status und Fehlermeldung sichtbar."""
    from clipfabrik.db import Clip, Publication, Stream
    from clipfabrik.publish.mock import MockAdapter
    from clipfabrik.publish.runner import run_publication

    monkeypatch.setattr("clipfabrik.jobs.handlers.run_safety_check", lambda cid: {"ok": True, "flags": [], "note": ""})
    video = data_dir / "v.mp4"
    video.write_bytes(b"\x00" * 1000)
    with session_scope() as s:
        st = Stream(source_type="upload", dir=str(data_dir), title="x")
        s.add(st)
        s.flush()
        c = Clip(stream_id=st.id, start=0, end=10, cuts=[[0, 10]], title="T", review_state="approved", render_path=str(video),
                 render_status="done", captions={"youtube": {"title": "T", "description": "D #Shorts", "tags": ["a"]}})
        acc = SocialAccount(platform="mock", name="M", daily_limit=5, tokens_enc=None)
        s.add_all([c, acc])
        s.flush()
        from clipfabrik import crypto

        acc.tokens_enc = crypto.encrypt_json({"access_token": "a", "refresh_token": "r", "expires_at": None, "scopes": [], "extra": {}})
        p = Publication(clip_id=c.id, account_id=acc.id, platform="mock", status="scheduled", scheduled_at=dt.datetime(2026, 1, 1))
        s.add(p)
        s.flush()
        pid = p.id
    MockAdapter.fail_next = 1
    msg = run_publication(pid)
    assert "neuer Versuch" in msg
    with session_scope() as s:
        p = s.get(Publication, pid)
        assert p.status == "scheduled" and p.next_retry_at is not None and "Simulierter Fehler" in p.error
    msg = run_publication(pid)
    with session_scope() as s:
        assert s.get(Publication, pid).status == "live", msg


# ------------------------------------------------------------------ Plattform-Adapter (offizielle APIs, gemockt)
@pytest.fixture()
def clipfile(tmp_path: Path) -> Path:
    p = tmp_path / "clip.mp4"
    p.write_bytes(b"\x01" * 2048)
    return p


@respx.mock
def test_tiktok_direct_post_unaudited_goes_private(data_dir, clipfile, monkeypatch):
    from clipfabrik.publish.base import TokenBundle, UploadRequest
    from clipfabrik.publish.tiktok import TikTokAdapter

    monkeypatch.setattr("time.sleep", lambda s: None)
    base = "https://open.tiktokapis.com"
    respx.post(f"{base}/v2/post/publish/creator_info/query/").mock(return_value=httpx.Response(200, json={
        "data": {"privacy_level_options": ["SELF_ONLY"]}, "error": {"code": "ok"}}))
    init = respx.post(f"{base}/v2/post/publish/video/init/").mock(return_value=httpx.Response(200, json={
        "data": {"publish_id": "p123", "upload_url": "https://upload.tiktok.test/x"}, "error": {"code": "ok"}}))
    up = respx.put("https://upload.tiktok.test/x").mock(return_value=httpx.Response(201))
    respx.post(f"{base}/v2/post/publish/status/fetch/").mock(return_value=httpx.Response(200, json={
        "data": {"status": "PUBLISH_COMPLETE", "publicaly_available_post_id": [777]}, "error": {"code": "ok"}}))
    ad = TikTokAdapter(http=httpx.Client())
    res = ad.upload(TokenBundle("tok"), {"api_approved": False},
                    UploadRequest(clipfile, "Titel", "Beschreibung", ["#a", "#b"], [], privacy="PUBLIC_TO_EVERYONE"))
    body = json.loads(init.calls[0].request.content)
    assert body["post_info"]["privacy_level"] == "SELF_ONLY", "ohne Audit nur privat"
    assert body["source_info"]["total_chunk_count"] == 1
    assert up.calls[0].request.headers["Content-Range"] == "bytes 0-2047/2048"
    assert res.status == "live" and res.external_id == "777"


@respx.mock
def test_tiktok_draft_and_error_mapping(data_dir, clipfile, monkeypatch):
    from clipfabrik.publish.base import PublishError, TokenBundle, UploadRequest
    from clipfabrik.publish.tiktok import TikTokAdapter

    monkeypatch.setattr("time.sleep", lambda s: None)
    base = "https://open.tiktokapis.com"
    respx.post(f"{base}/v2/post/publish/inbox/video/init/").mock(return_value=httpx.Response(200, json={
        "data": {"publish_id": "d1", "upload_url": "https://upload.tiktok.test/d"}, "error": {"code": "ok"}}))
    respx.put("https://upload.tiktok.test/d").mock(return_value=httpx.Response(201))
    respx.post(f"{base}/v2/post/publish/status/fetch/").mock(return_value=httpx.Response(200, json={
        "data": {"status": "SEND_TO_USER_INBOX"}, "error": {"code": "ok"}}))
    ad = TikTokAdapter(http=httpx.Client())
    res = ad.upload(TokenBundle("tok"), {}, UploadRequest(clipfile, "T", "D", [], [], draft=True))
    assert "Inbox" in res.note
    respx.post(f"{base}/v2/post/publish/creator_info/query/").mock(return_value=httpx.Response(200, json={
        "data": {}, "error": {"code": "spam_risk_too_many_posts", "message": "too many"}}))
    with pytest.raises(PublishError) as ei:
        ad.upload(TokenBundle("tok"), {}, UploadRequest(clipfile, "T", "D", [], []))
    assert "Tageslimit" in str(ei.value)


@respx.mock
def test_instagram_reels_flow(data_dir, clipfile, monkeypatch):
    from clipfabrik.publish.base import TokenBundle, UploadRequest
    from clipfabrik.publish.instagram import InstagramAdapter

    monkeypatch.setattr("time.sleep", lambda s: None)
    g, v = "https://graph.instagram.com", "v23.0"
    create = respx.post(f"{g}/{v}/1784/media").mock(return_value=httpx.Response(200, json={"id": "c55"}))
    upl = respx.post(f"https://rupload.facebook.com/ig-api-upload/{v}/c55").mock(return_value=httpx.Response(200, json={"success": True}))
    respx.get(f"{g}/{v}/c55").mock(return_value=httpx.Response(200, json={"status_code": "FINISHED"}))
    pub = respx.post(f"{g}/{v}/1784/media_publish").mock(return_value=httpx.Response(200, json={"id": "m99"}))
    respx.get(f"{g}/{v}/m99").mock(return_value=httpx.Response(200, json={"permalink": "https://instagram.com/reel/abc"}))
    ad = InstagramAdapter(http=httpx.Client())
    res = ad.upload(TokenBundle("igtok"), {"external_id": "1784"}, UploadRequest(clipfile, "T", "Caption", ["#reels"], []))
    assert b"REELS" in create.calls[0].request.content and b"resumable" in create.calls[0].request.content
    assert upl.calls[0].request.headers["file_size"] == "2048"
    assert pub.called and res.url == "https://instagram.com/reel/abc"


@respx.mock
def test_youtube_resumable_upload_and_quota_error(data_dir, clipfile):
    from clipfabrik.publish.base import PublishError, TokenBundle, UploadRequest
    from clipfabrik.publish.youtube import YouTubeAdapter

    base = "https://www.googleapis.com"
    init = respx.post(f"{base}/upload/youtube/v3/videos").mock(return_value=httpx.Response(200, headers={"Location": "https://up.yt.test/s1"}))
    respx.put("https://up.yt.test/s1").mock(return_value=httpx.Response(200, json={"id": "vid42"}))
    ad = YouTubeAdapter(http=httpx.Client())
    res = ad.upload(TokenBundle("yt"), {}, UploadRequest(clipfile, "Titel #Shorts", "Beschreibung #Shorts", [], ["twitch"]))
    meta = json.loads(init.calls[0].request.content)
    assert meta["snippet"]["title"] == "Titel #Shorts" and meta["status"]["privacyStatus"] == "public"
    assert res.url == "https://youtube.com/shorts/vid42"
    respx.post(f"{base}/upload/youtube/v3/videos").mock(return_value=httpx.Response(403, json={
        "error": {"message": "quota", "errors": [{"reason": "quotaExceeded"}]}}))
    with pytest.raises(PublishError) as ei:
        ad.upload(TokenBundle("yt"), {}, UploadRequest(clipfile, "T", "D", [], []))
    assert "Kontingent" in str(ei.value) and ei.value.retry


@respx.mock
def test_youtube_metrics(data_dir):
    from clipfabrik.publish.base import TokenBundle
    from clipfabrik.publish.youtube import YouTubeAdapter

    respx.get("https://www.googleapis.com/youtube/v3/videos").mock(return_value=httpx.Response(200, json={
        "items": [{"id": "a", "statistics": {"viewCount": "1500", "likeCount": "80"}}]}))
    m = YouTubeAdapter(http=httpx.Client()).fetch_metrics(TokenBundle("t"), {}, ["a"])
    assert m == {"a": {"views": 1500, "likes": 80, "comments": 0}}
