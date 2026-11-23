"""Integrationstest: synthetisches Video -> komplette Pipeline (Modus A) -> Review -> Freigabe ->
Original-Render mit sichtbaren Untertiteln -> Veröffentlichung (Mock-Adapter) -> Fallback-Export."""

from __future__ import annotations

import io
import json
import subprocess
import zipfile
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from clipfabrik.config import get_settings
from clipfabrik.db import Clip, Publication, Stream, session_scope
from clipfabrik.ingest import create_stream_from_file
from clipfabrik.media import ffmpeg
from clipfabrik.media.renderer import RenderSpec, render
from clipfabrik.sources import epoch
from conftest import SCRIPT, chat_burst, run_jobs

pytestmark = pytest.mark.slow


def _frame(video: Path, t: float, out: Path) -> np.ndarray:
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{t:.3f}", "-i", str(video), "-frames:v", "1",
                    str(out)], check=True)
    return np.asarray(Image.open(out).convert("RGB")).astype(int)


def _prepare_stream(test_video: Path) -> int:
    sid = create_stream_from_file(test_video, source_type="upload", title="Testturnier", auto_process=True)
    with session_scope() as s:
        st = s.get(Stream, sid)
        sdir = Path(st.dir)
        start_wall = epoch(st.started_at)
    # Skript für die Fake-Transkription (in echt: faster-whisper)
    (sdir / "audio.wav.script.json").write_text(json.dumps(SCRIPT, ensure_ascii=False), encoding="utf-8")
    # Chat: Spitze kurz nach dem Ausraster (Chat läuft hinterher)
    with open(sdir / "chat.jsonl", "w", encoding="utf-8") as f:
        for e in chat_burst(start_wall, at=41.0):
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    return sid


def test_full_pipeline_to_published_clip(client, test_video):
    sid = _prepare_stream(test_video)
    run_jobs()

    # --- Stream verarbeitet, Clips in der Review-Liste
    r = client.get(f"/api/streams/{sid}").json()
    assert r["status"] == "done", r
    assert r["selection"]["windows"] >= 1
    clips = client.get(f"/api/clips?stream_id={sid}&bucket=review").json()
    assert clips, "keine Clips gefunden"
    best = clips[0]
    assert best["start"] <= 39.0 and best["end"] >= 38.0, f"Ausraster-Moment nicht getroffen: {best['start']}–{best['end']}"
    assert 8.0 <= best["duration"] <= 45.0
    assert best["preview_url"] and best["thumb_url"]
    full = client.get(f"/api/clips/{best['id']}").json()
    sig_types = {s["type"] for s in full["signals"]["signals"]}
    assert "chat" in sig_types, sig_types
    assert {"tiktok", "instagram", "youtube"} <= set(full["captions"])
    assert full["captions"]["tiktok"]["description"] != full["captions"]["instagram"]["caption"]
    assert full["subtitle_lines"], "Untertitel-Zeilen zum Bearbeiten fehlen"

    # --- Vorschau: 540x960
    pv = client.get(best["preview_url"])
    assert pv.status_code == 200 and pv.headers["content-type"] == "video/mp4"
    with session_scope() as s:
        c = s.get(Clip, best["id"])
        preview_path = Path(c.preview_path)
    info = ffmpeg.probe(preview_path)
    assert (info.width, info.height) == (540, 960)
    # Range-Requests (Vorspulen am Handy)
    rr = client.get(best["preview_url"], headers={"Range": "bytes=0-99"})
    assert rr.status_code == 206 and len(rr.content) == 100

    # --- Mock-Konto verbinden (OAuth-Ablauf)
    url = client.post("/api/accounts/connect/mock").json()["url"]
    cb = client.get(url.replace("https://clips.example.test", ""), follow_redirects=False)
    assert cb.status_code in (302, 307) and "verbunden=mock" in cb.headers["location"]
    acc = client.get("/api/accounts").json()["accounts"][0]
    assert acc["platform"] == "mock" and acc["quota"]["left"] > 0

    # --- Freigeben -> Original rendern -> einplanen
    r = client.post(f"/api/clips/{best['id']}/review", json={"action": "approve", "account_ids": [acc["id"]]})
    assert r.status_code == 200, r.text
    run_jobs(types=["render_clip"])
    with session_scope() as s:
        c = s.get(Clip, best["id"])
        final = Path(c.render_path)
        words = c.words
        cuts = [tuple(x) for x in c.cuts]
        src = Path(c.stream.source_path)
    info = ffmpeg.probe(final)
    assert (info.width, info.height) == (1080, 1920)
    assert abs(info.duration - sum(b - a for a, b in cuts)) < 0.5
    assert final.name.startswith("upload_") and final.suffix == ".mp4", "sprechender Dateiname"
    lufs = ffmpeg.measure_loudness(final)
    assert -16.5 < lufs < -11.5, f"Lautheit {lufs} LUFS nicht normalisiert"

    # --- Untertitel sichtbar: gleiches Frame mit und ohne Untertitel vergleichen
    w = next(x for x in words if x["start"] > 3.2)  # nach dem Hook-Overlay
    t = (w["start"] + w["end"]) / 2
    nosub = final.with_name("nosub.mp4")
    render(RenderSpec(source=src, cuts=cuts, out_path=nosub, words=[], preview=False))
    a = _frame(final, t, final.with_name("a.png"))
    b = _frame(nosub, t, final.with_name("b.png"))
    diff = np.abs(a - b).sum(axis=2) > 90
    ys, xs = np.nonzero(diff)
    assert diff.sum() > 1500, "Untertitel im fertigen Clip nicht sichtbar"
    assert 1100 < ys.mean() < 1650, f"Untertitel an falscher Stelle (y≈{ys.mean():.0f})"
    assert xs.min() > 0 and xs.max() < 1079, "Untertitel ragen aus dem Bild"

    # --- Veröffentlichen (Zeitplan sofort fällig setzen)
    q = client.get("/api/queue").json()
    assert len(q["active"]) == 1 and q["active"][0]["status"] == "scheduled"
    pid = q["active"][0]["id"]
    client.post(f"/api/queue/{pid}/now")
    run_jobs()
    with session_scope() as s:
        p = s.get(Publication, pid)
        assert p.status == "live", p.error
        ext = p.external_id
    published = get_settings().data_dir / "mock_published"
    meta = json.loads((published / f"{ext}.json").read_text())
    assert meta["title"] and "#Shorts" in meta["description"]
    assert client.get("/api/accounts").json()["accounts"][0]["quota"]["used"] == 1

    # --- Fallback-Export (ZIP mit captions.csv pro Plattform)
    jid = client.post("/api/export", json={"clip_ids": [c["id"] for c in clips[:2]]}).json()["job_id"]
    run_jobs()
    st = client.get(f"/api/export/{jid}").json()
    assert st["status"] == "done", st
    z = zipfile.ZipFile(io.BytesIO(client.get(st["download_url"]).content))
    names = z.namelist()
    assert {"captions_tiktok.csv", "captions_instagram.csv", "captions_youtube.csv"} <= set(names)
    assert any(n.startswith("clips/") and n.endswith(".mp4") for n in names)
    assert "datei;beschreibung;hashtags;score" in z.read("captions_tiktok.csv").decode("utf-8-sig")

    # --- Lernschleife: Freigabe taucht als Beispiel auf
    an = client.get("/api/analytics").json()
    assert "FREIGEGEBEN" in an["feedback_examples"] or "TOP" in an["feedback_examples"]


def test_trim_and_rerender(client, test_video):
    sid = _prepare_stream(test_video)
    run_jobs()
    clip = client.get(f"/api/clips?stream_id={sid}&bucket=review").json()[0]
    full = client.get(f"/api/clips/{clip['id']}").json()
    new_start = full["start"] + 1.0
    r = client.patch(f"/api/clips/{clip['id']}", json={"start": new_start, "hook_text": "Neuer Hook", "subtitle_lines": ["EIGENER TEXT"]})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["render_status"] == "stale" and abs(d["start"] - new_start) < 0.01
    assert all(w["start"] >= 0 for w in d["words"])
    client.post(f"/api/clips/{clip['id']}/rerender", json={"preview": True})
    run_jobs()
    d2 = client.get(f"/api/clips/{clip['id']}").json()
    assert d2["render_status"] == "done" and d2["version"] > full["version"]


def test_safety_flag_blocks_until_override(client, test_video):
    sid = _prepare_stream(test_video)
    run_jobs()
    clip = client.get(f"/api/clips?stream_id={sid}&bucket=review").json()[0]
    with session_scope() as s:
        c = s.get(Clip, clip["id"])
        c.safety_flagged = True
        c.safety = {"flags": ["urheberrecht_musik"], "note": "Musik im Hintergrund"}
    r = client.post(f"/api/clips/{clip['id']}/review", json={"action": "approve"})
    assert r.status_code == 409
    bulk = client.post("/api/clips/bulk", json={"action": "approve", "ids": [clip["id"]]}).json()
    assert bulk["skipped"] and not bulk["done"], "Sammelfreigabe überspringt Safety-Clips"
    r = client.post(f"/api/clips/{clip['id']}/review", json={"action": "approve", "safety_override": True})
    assert r.status_code == 200 and r.json()["review_state"] == "approved"


def test_bulk_approve_min_score(client, test_video):
    sid = _prepare_stream(test_video)
    run_jobs()
    clips = client.get(f"/api/clips?stream_id={sid}&bucket=all").json()
    assert clips
    r = client.post("/api/clips/bulk", json={"action": "approve", "min_score": 0, "stream_id": sid}).json()
    assert len(r["done"]) == len([c for c in clips if c["bucket"] == "review" and not c["safety_flagged"]])


def test_cli_process_runs(test_video, data_dir, capsys):
    from clipfabrik.cli import main

    main(["process", str(test_video), "--title", "CLI-Test"])
    out = capsys.readouterr().out
    assert "->" in out
