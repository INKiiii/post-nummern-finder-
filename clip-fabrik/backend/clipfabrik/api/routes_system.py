"""Einstellungen, Push, Jobs, Auswertung, Speicher, Upload (tus) und URL-Import."""

from __future__ import annotations

import base64
import datetime as dt
import json
import logging
import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from .. import auth, settings_store
from ..config import get_settings
from ..db import Clip, Job, LLMUsage, NotificationLog, Publication, PushSubscription, Stream, session_scope, utcnow
from ..highlights.feedback import build_examples_text, top_flop
from ..jobs import queue
from ..llm.ai import estimate_cost_usd
from ..push.notify import EVENTS, notify, vapid_keys
from ..storage import disk_status
from .serialize import iso, job_out

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", dependencies=[Depends(auth.require_login)])


# ------------------------------------------------------------------ Einstellungen
@router.get("/settings")
def get_settings_api() -> dict:
    return {"values": settings_store.public_settings(), "push_events": EVENTS}


@router.put("/settings")
def put_settings(values: dict) -> dict:
    weights = values.get("score_weights")
    if weights is not None and (not isinstance(weights, dict) or any(float(v) < 0 for v in weights.values())):
        raise HTTPException(400, "Gewichte müssen ≥ 0 sein")
    changed = settings_store.update_settings(values)
    return {"changed": changed, "values": settings_store.public_settings()}


@router.post("/settings/test-claude")
def test_claude() -> dict:
    """Prüft Key und Modell kostenlos über die Token-Zählung."""
    key = settings_store.get("anthropic_api_key")
    if not key:
        raise HTTPException(400, "Kein Anthropic-API-Key hinterlegt")
    import anthropic

    model = settings_store.get("claude_model")
    try:
        r = anthropic.Anthropic(api_key=key, max_retries=1, timeout=20).messages.count_tokens(
            model=model, messages=[{"role": "user", "content": "Test"}])
        return {"ok": True, "model": model, "tokens": r.input_tokens}
    except anthropic.AuthenticationError:
        raise HTTPException(400, "API-Key ungültig") from None
    except anthropic.NotFoundError:
        raise HTTPException(400, f"Modell {model} nicht gefunden") from None
    except anthropic.APIError as exc:
        raise HTTPException(502, f"Anthropic-Fehler: {exc}") from None


# ------------------------------------------------------------------ Push
@router.get("/push/vapid")
def push_vapid() -> dict:
    pub, _ = vapid_keys()
    return {"public_key": pub}


class SubIn(BaseModel):
    endpoint: str
    keys: dict


@router.post("/push/subscribe")
def push_subscribe(body: SubIn, request: Request) -> dict:
    with session_scope() as s:
        row = s.scalar(select(PushSubscription).where(PushSubscription.endpoint == body.endpoint))
        if row is None:
            s.add(PushSubscription(endpoint=body.endpoint, keys=body.keys, user_agent=request.headers.get("user-agent", "")[:300]))
        else:
            row.keys = body.keys
    return {"ok": True}


@router.post("/push/unsubscribe")
def push_unsubscribe(body: SubIn) -> dict:
    with session_scope() as s:
        row = s.scalar(select(PushSubscription).where(PushSubscription.endpoint == body.endpoint))
        if row:
            s.delete(row)
    return {"ok": True}


@router.post("/push/test")
def push_test() -> dict:
    res = notify("clips_ready", "Test-Benachrichtigung", "So sieht ein Pop-up aus. Tippen öffnet die Review.", url="/review", force=True)
    return {"delivered": res}


@router.get("/notifications")
def notifications(limit: int = 30) -> list[dict]:
    with session_scope() as s:
        rows = s.scalars(select(NotificationLog).order_by(NotificationLog.id.desc()).limit(min(limit, 100))).all()
        return [{"id": n.id, "event": n.event, "title": n.title, "body": n.body, "url": n.url, "suppressed": n.suppressed,
                 "created_at": iso(n.created_at)} for n in rows]


# ------------------------------------------------------------------ Jobs
@router.get("/jobs")
def list_jobs(status: str | None = None, limit: int = 60) -> list[dict]:
    with session_scope() as s:
        q = select(Job).order_by(Job.id.desc()).limit(min(limit, 300))
        if status:
            q = q.where(Job.status.in_(status.split(",")))
        return [job_out(j) for j in s.scalars(q).all()]


@router.post("/jobs/{jid}/{action}")
def job_action(jid: int, action: str) -> dict:
    if action == "cancel":
        ok = queue.cancel(jid)
    elif action == "retry":
        ok = queue.retry_job(jid)
    else:
        raise HTTPException(400, "Aktion unbekannt")
    if not ok:
        raise HTTPException(409, "Nicht möglich im aktuellen Zustand")
    return {"ok": True}


# ------------------------------------------------------------------ Auswertung
@router.get("/analytics")
def analytics() -> dict:
    with session_scope() as s:
        pubs = s.scalars(select(Publication).where(Publication.status == "live")).all()
        per_platform: dict[str, dict] = {}
        for p in pubs:
            d = per_platform.setdefault(p.platform, {"posts": 0, "views": 0, "likes": 0, "comments": 0, "shares": 0})
            d["posts"] += 1
            for k in ("views", "likes", "comments", "shares"):
                d[k] += int((p.metrics or {}).get(k, 0) or 0)
        tf = top_flop(s, 8)
        reviewed = dict(s.execute(select(Clip.review_state, func.count()).group_by(Clip.review_state)).all())
        since = utcnow() - dt.timedelta(days=30)
        cost = s.scalar(select(func.coalesce(func.sum(LLMUsage.cost_usd), 0.0)).where(LLMUsage.created_at >= since)) or 0.0
        cached = s.scalar(select(func.count()).select_from(LLMUsage).where(LLMUsage.cached.is_(True), LLMUsage.created_at >= since)) or 0
        streams = s.scalar(select(func.count()).select_from(Stream).where(Stream.started_at >= since)) or 0
        examples = build_examples_text(s, None, int(settings_store.get("feedback_examples") or 6))
        approval_rate = None
        total_rev = (reviewed.get("approved", 0) + reviewed.get("rejected", 0))
        if total_rev:
            approval_rate = round(reviewed.get("approved", 0) / total_rev * 100)
    return {
        "per_platform": per_platform, "top": tf["top"], "flop": tf["flop"], "review_counts": reviewed,
        "approval_rate": approval_rate, "llm_cost_30d_usd": round(float(cost), 3), "llm_cached_calls_30d": cached,
        "streams_30d": streams, "feedback_examples": examples,
    }


@router.post("/analytics/refresh")
def analytics_refresh() -> dict:
    return {"job_id": queue.enqueue("collect_metrics", {}, priority=80, unique_key="collect_metrics")}


# ------------------------------------------------------------------ Speicher
@router.get("/storage")
def storage() -> dict:
    return disk_status() | {"raw_retention_days": settings_store.get("raw_retention_days"),
                            "rejected_retention_days": settings_store.get("rejected_retention_days")}


@router.post("/storage/cleanup")
def storage_cleanup() -> dict:
    return {"job_id": queue.enqueue("cleanup_storage", {}, priority=60, unique_key="cleanup_storage")}


# ------------------------------------------------------------------ Kostenschätzung
@router.get("/estimate")
def estimate(duration: float, clips: int = 15) -> dict:
    est = estimate_cost_usd(duration=duration, clips=clips)
    eur = est["usd"] * float(settings_store.get("usd_to_eur") or 0.92)
    return est | {"eur": round(eur, 2), "ai": "claude" if settings_store.get("anthropic_api_key") else "heuristik"}


# ------------------------------------------------------------------ Upload (tus-Protokoll, wiederaufnehmbar)
TUS_VERSION = "1.0.0"
MAX_UPLOAD = 60 * 1024**3  # 60 GB


def _tus_headers(extra: dict | None = None) -> dict:
    h = {"Tus-Resumable": TUS_VERSION, "Cache-Control": "no-store"}
    h.update(extra or {})
    return h


def _upload_paths(uid: str) -> tuple[Path, Path]:
    if not uid.isalnum():
        raise HTTPException(404, "Upload unbekannt")
    d = get_settings().uploads_dir
    return d / f"{uid}.part", d / f"{uid}.json"


def _parse_metadata(raw: str) -> dict:
    out = {}
    for item in filter(None, (x.strip() for x in raw.split(","))):
        k, _, v = item.partition(" ")
        try:
            out[k] = base64.b64decode(v).decode("utf-8") if v else ""
        except Exception:  # noqa: BLE001
            out[k] = ""
    return out


@router.options("/uploads/tus")
@router.options("/uploads/tus/{uid}")
def tus_options(uid: str | None = None) -> Response:
    return Response(status_code=204, headers=_tus_headers({"Tus-Version": TUS_VERSION, "Tus-Extension": "creation,termination",
                                                           "Tus-Max-Size": str(MAX_UPLOAD)}))


@router.post("/uploads/tus")
def tus_create(request: Request) -> Response:
    try:
        length = int(request.headers.get("Upload-Length", "-1"))
    except ValueError:
        length = -1
    if length <= 0 or length > MAX_UPLOAD:
        raise HTTPException(413 if length > MAX_UPLOAD else 400, "Ungültige Dateigröße")
    ds = disk_status()
    if ds["free_gb"] * 1e9 < length * 1.3:
        raise HTTPException(507, f"Zu wenig Speicher auf dem Server ({ds['free_gb']} GB frei)")
    meta = _parse_metadata(request.headers.get("Upload-Metadata", ""))
    uid = secrets.token_hex(12)
    part, info = _upload_paths(uid)
    part.touch()
    info.write_text(json.dumps({"length": length, "meta": meta, "created": utcnow().isoformat()}))
    return Response(status_code=201, headers=_tus_headers({"Location": f"/api/uploads/tus/{uid}", "Upload-Offset": "0"}))


@router.head("/uploads/tus/{uid}")
def tus_head(uid: str) -> Response:
    part, info = _upload_paths(uid)
    if not info.exists():
        raise HTTPException(404, "Upload unbekannt")
    meta = json.loads(info.read_text())
    return Response(status_code=200, headers=_tus_headers({"Upload-Offset": str(part.stat().st_size if part.exists() else 0),
                                                           "Upload-Length": str(meta["length"])}))


@router.patch("/uploads/tus/{uid}")
async def tus_patch(uid: str, request: Request) -> Response:
    part, info = _upload_paths(uid)
    if not info.exists():
        raise HTTPException(404, "Upload unbekannt")
    if request.headers.get("Content-Type") != "application/offset+octet-stream":
        raise HTTPException(415, "Falscher Content-Type")
    meta = json.loads(info.read_text())
    offset = int(request.headers.get("Upload-Offset", "-1"))
    current = part.stat().st_size
    if offset != current:
        return Response(status_code=409, headers=_tus_headers({"Upload-Offset": str(current)}))
    written = current
    with open(part, "ab") as f:
        async for chunk in request.stream():
            if written + len(chunk) > meta["length"]:
                raise HTTPException(400, "Mehr Daten als angekündigt")
            f.write(chunk)
            written += len(chunk)
    headers = _tus_headers({"Upload-Offset": str(written)})
    if written == meta["length"]:
        _finish_upload(uid, part, info, meta)
    return Response(status_code=204, headers=headers)


@router.delete("/uploads/tus/{uid}")
def tus_delete(uid: str) -> Response:
    part, info = _upload_paths(uid)
    part.unlink(missing_ok=True)
    info.unlink(missing_ok=True)
    return Response(status_code=204, headers=_tus_headers())


def _finish_upload(uid: str, part: Path, info: Path, meta: dict) -> None:
    from ..ingest import create_stream_from_file

    m = meta.get("meta", {})
    name = Path(m.get("filename") or f"{uid}.mp4").name
    suffix = Path(name).suffix.lower() or ".mp4"
    final = part.with_name(f"{uid}{suffix}")
    part.rename(final)
    try:
        sid = create_stream_from_file(final, source_type="upload", title=m.get("title") or Path(name).stem,
                                      channel_id=int(m["channel_id"]) if m.get("channel_id") else None,
                                      auto_process=m.get("auto_process", "1") == "1", move=True)
    except Exception as exc:  # noqa: BLE001
        log.error("Upload %s nicht lesbar: %s", uid, exc)
        meta["error"] = str(exc)
        info.write_text(json.dumps(meta))
        raise HTTPException(422, f"Datei nicht lesbar: {exc}") from exc
    meta["stream_id"] = sid
    info.write_text(json.dumps(meta))


@router.get("/uploads/{uid}")
def upload_result(uid: str) -> dict:
    _, info = _upload_paths(uid)
    if not info.exists():
        raise HTTPException(404, "Upload unbekannt")
    meta = json.loads(info.read_text())
    return {"stream_id": meta.get("stream_id"), "error": meta.get("error")}


class UrlImportIn(BaseModel):
    url: str = Field(min_length=8)
    rights_confirmed: bool = False
    title: str = ""
    channel_id: int | None = None
    auto_process: bool = True


@router.post("/uploads/url")
def url_import(body: UrlImportIn) -> dict:
    if not body.rights_confirmed:
        raise HTTPException(400, "Bitte bestätigen, dass du die Rechte an diesem Material hast.")
    if not body.url.startswith(("http://", "https://")):
        raise HTTPException(400, "Ungültige URL")
    jid = queue.enqueue("import_url", body.model_dump(), priority=60)
    return {"job_id": jid}
