"""Job-Handler: Modus A (Nachbearbeitung), Modus B (Live-Kandidat), Rendern, Texte, Safety,
Veröffentlichen, Auswertung, Aufräumen, Export, URL-Import.

Jeder lange Job arbeitet in Schritten mit Checkpoints: nach Absturz/Neustart geht es beim
letzten fertigen Schritt weiter.
"""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path

from sqlalchemy import select

from .. import settings_store
from ..analysis import audio as audio_mod
from ..analysis.chat import build_series, load_events
from ..analysis.signals import Signal, Window, audio_signals, build_windows, chat_signals, marker_signals, transcript_signals
from ..analysis.transcribe import TWord, cached_transcribe, get_transcriber
from ..config import get_settings
from ..db import Channel, Clip, Marker, Segment, Stream, session_scope, utcnow
from ..highlights.feedback import build_examples_text
from ..highlights.pipeline import SelectionConfig, select_highlights
from ..highlights.store import store_selection
from ..llm.ai import CaptionInput, SafetyInput, estimate_cost_usd, get_ai
from ..media import ffmpeg
from ..media.renderer import RenderSpec, make_thumbnail, render
from ..media.subtitles import Word
from ..push.notify import notify, suppressed_since
from ..sources import epoch, materialize, timeline_for, timeline_to_meta
from . import queue
from .worker import JobContext, PermanentJobError, RetryLater, register

log = logging.getLogger(__name__)


def _selection_cfg(channel: Channel | None, *, quota: int | None = None) -> SelectionConfig:
    return SelectionConfig(
        weights=settings_store.get("score_weights"),
        min_score=channel.min_score if channel else float(settings_store.get("default_min_score")),
        quota=quota if quota is not None else (channel.clips_per_stream if channel else int(settings_store.get("default_clips_per_stream"))),
        target_min=float(settings_store.get("clip_target_min")),
        target_max=float(settings_store.get("clip_target_max")),
        hard_min=float(settings_store.get("clip_hard_min")),
        hard_max=float(settings_store.get("clip_hard_max")),
        vision=bool(settings_store.get("claude_vision")) and bool(settings_store.get("anthropic_api_key")),
    )


def _ai_for(stream: Stream):
    with session_scope() as s:
        ch = s.get(Channel, stream.channel_id) if stream.channel_id else None
        examples = build_examples_text(s, stream.channel_id, int(settings_store.get("feedback_examples") or 6))
        voice = ch.brand_voice if ch else ""
        name = (ch.display_name or ch.login) if ch else ""
    return get_ai(stream_id=stream.id, brand_voice=voice, examples=examples, channel_name=name)


def _load_stream(stream_id: int) -> Stream:
    with session_scope() as s:
        st = s.get(Stream, stream_id)
        if st is None:
            raise PermanentJobError(f"Stream {stream_id} existiert nicht")
        if st.channel_id:
            ch = s.get(Channel, st.channel_id)
            if ch is not None and not ch.consent_confirmed:
                raise PermanentJobError("Ohne Zustimmung des Streamers wird nichts verarbeitet")
        _ = st.channel  # laden
        s.expunge_all()
        return st


def _set_stream(stream_id: int, **values) -> None:
    with session_scope() as s:
        st = s.get(Stream, stream_id)
        if st is not None:
            for k, v in values.items():
                setattr(st, k, v)


def _chat_samples_fn(stream: Stream, tl):
    events = load_events(Path(stream.dir) / "chat.jsonl")
    msgs = [e for e in events if e.kind == "msg" and e.text]

    def samples(a: float, b: float) -> list[str]:
        wa, wb = tl.offset_to_wall(a), tl.offset_to_wall(b) + 8
        return [m.text[:80] for m in msgs if wa <= m.t <= wb][:: max(1, len(msgs) // 4000 + 1)][:10]

    return samples


# --------------------------------------------------------------------------------------
# Modus A: Nachbearbeitung
# --------------------------------------------------------------------------------------


@register("process_stream")
def process_stream(ctx: JobContext) -> str:
    sid = int(ctx.payload["stream_id"])
    stream = _load_stream(sid)
    sdir = Path(stream.dir)
    sdir.mkdir(parents=True, exist_ok=True)
    settings = get_settings()
    _set_stream(sid, status="processing", error=None)

    # 1) Segmente zusammensetzen
    if not ctx.done_step("assemble"):
        if stream.source_type == "twitch":
            ctx.progress(0.01, "Setze Aufnahme zusammen", "assemble")
            with session_scope() as s:
                st = s.get(Stream, sid)
                tl = timeline_for(s, st)
                seg_paths = [p.path for p in tl.pieces]
            if not seg_paths:
                _set_stream(sid, status="unrecordable", error="Keine Aufnahme-Segmente vorhanden")
                notify("error", "Aufnahme leer", f"Stream {stream.title or sid}: keine Segmente aufgenommen.", url="/", stream_id=sid)
                raise PermanentJobError("Keine Segmente aufgenommen (Abo-only, offline oder Aufnahmefehler)")
            out = sdir / "source.mp4"
            ffmpeg.concat_files(seg_paths, out, duration_hint=tl.duration,
                                on_progress=lambda p: ctx.progress(0.01 + 0.07 * p, "Setze Aufnahme zusammen"))
            info = ffmpeg.probe(out)
            meta = dict(stream.meta or {})
            meta["timeline"] = timeline_to_meta(tl)
            _set_stream(sid, source_path=str(out), duration=info.duration, gaps=tl.gap_dicts(), meta=meta)
            if settings_store.get("delete_segments_after_assembly"):
                shutil.rmtree(sdir / "segments", ignore_errors=True)
                with session_scope() as s:
                    for seg in s.scalars(select(Segment).where(Segment.stream_id == sid)).all():
                        s.delete(seg)
        else:
            src = Path(stream.source_path or "")
            if not src.exists():
                raise PermanentJobError(f"Quelldatei fehlt: {src}")
            info = ffmpeg.probe(src)
            _set_stream(sid, duration=info.duration)
        ctx.checkpoint("assemble")
    stream = _load_stream(sid)
    source = Path(stream.source_path or "")
    if not source.exists():
        raise PermanentJobError(f"Quelldatei fehlt: {source}")

    # 2) Kostenschätzung / Budget
    if not ctx.done_step("cost"):
        est = estimate_cost_usd(duration=stream.duration, clips=stream.channel.clips_per_stream if stream.channel else 15)
        _set_stream(sid, cost_estimate_usd=est["usd"])
        budget = float(settings_store.get("budget_per_stream_usd") or 0)
        uses_claude = bool(settings_store.get("anthropic_api_key")) and not settings.fake_ai
        if uses_claude and budget and est["usd"] > budget and not ctx.payload.get("confirmed"):
            _set_stream(sid, status="waiting_approval")
            notify("clips_ready", "Freigabe nötig", f"Geschätzte KI-Kosten {est['usd']:.2f} $ über Budget {budget:.2f} $.",
                   url="/streams", stream_id=sid)
            return f"Wartet auf Freigabe (geschätzt {est['usd']:.2f} $)"
        ctx.checkpoint("cost")

    # 3) Audio
    wav = sdir / "audio.wav"
    if not ctx.done_step("audio") or not wav.exists():
        ctx.progress(0.09, "Extrahiere Audio", "audio")
        ffmpeg.extract_audio(source, wav, duration_hint=stream.duration,
                             on_progress=lambda p: ctx.progress(0.09 + 0.04 * p, "Extrahiere Audio"))
        ctx.checkpoint("audio")

    # 4) Transkription
    ctx.progress(0.13, "Transkribiere (Whisper)", "transcribe")
    lang = stream.channel.language if stream.channel else "de"
    transcript = cached_transcribe(wav, settings.cache_dir, get_transcriber(), lang,
                                   on_progress=lambda p: ctx.progress(0.13 + 0.42 * p, f"Transkribiere ({int(p * 100)} %)"))
    ctx.checkpoint("transcribe")

    # 5) Audio-Analyse
    aa_file = sdir / "audio_analysis.json"
    if aa_file.exists():
        aa = audio_mod.AudioAnalysis.from_json(aa_file.read_text())
    else:
        ctx.progress(0.56, "Analysiere Lautstärke, Stille, Gelächter", "analyze")
        aa = audio_mod.analyze_wav(wav)
        aa_file.write_text(aa.to_json())
    ctx.checkpoint("analyze")

    # 6) Signale -> Kandidatenfenster
    ctx.progress(0.6, "Suche starke Momente (Signal-Vorfilter)", "signals")
    with session_scope() as s:
        st = s.get(Stream, sid)
        tl = timeline_for(s, st)
        markers = s.scalars(select(Marker).where(Marker.stream_id == sid)).all()
        marker_offs = [(tl.wall_to_offset(epoch(m.wall_time)) or 0.0, m.lookback, m.source) for m in markers]
    words = transcript.words()
    signals = transcript_signals(words) + audio_signals(aa, words) + marker_signals(marker_offs)
    events = load_events(sdir / "chat.jsonl")
    if events:
        series = build_series(events, tl.wall_start, tl.duration + sum(g.seconds for g in tl.gaps), set(settings_store.get("chat_emotes")))
        signals += chat_signals(series, lambda w: tl.wall_to_offset(w, clamp=False))
    quota = stream.channel.clips_per_stream if stream.channel else int(settings_store.get("default_clips_per_stream"))
    windows = build_windows(signals, stream.duration, hard_cap=max(12, quota * 3 + 10))
    (sdir / "windows.json").write_text(json.dumps([w.to_dict() for w in windows], ensure_ascii=False))
    ctx.checkpoint("signals")

    # 7) Auswahl (Claude-Durchläufe + Filter)
    if not ctx.done_step("select"):
        ai = _ai_for(stream)
        result = select_highlights(
            ai=ai, windows=windows, transcript=transcript, media_duration=stream.duration, cfg=_selection_cfg(stream.channel),
            source=source, frames_dir=sdir / "frames", chat_samples=_chat_samples_fn(stream, tl),
            progress=lambda p, m: ctx.progress(0.62 + 0.18 * p, m, "select"),
        )
        with session_scope() as s:
            st = s.get(Stream, sid)
            stored = store_selection(s, st, result.review, result.archive, result.discarded, origin="post")
            meta = dict(st.meta or {})
            meta["selection"] = result.stats | {"ai": ai.name}
            st.meta = meta
        ctx.checkpoint("select", created=stored["created"], confirmed=stored["confirmed"])

    # 8) Vorschauen (540p) und Texte für die Review-Liste
    with session_scope() as s:
        review_ids = [c.id for c in s.scalars(select(Clip).where(Clip.stream_id == sid, Clip.bucket == "review",
                                                                 Clip.review_state == "pending")).all()]
    todo = [cid for cid in review_ids if cid not in ctx.state.get("rendered", [])]
    for i, cid in enumerate(todo):
        ctx.progress(0.8 + 0.15 * i / max(1, len(todo)), f"Rendere Vorschau {i + 1}/{len(todo)}", "previews")
        _render_clip(cid, preview=True)
        ctx.state.setdefault("rendered", []).append(cid)
        ctx.checkpoint("previews_partial")
    if not ctx.done_step("captions"):
        ctx.progress(0.96, "Schreibe Titel, Beschreibungen, Hashtags", "captions")
        _make_captions(review_ids, stream)
        ctx.checkpoint("captions")

    # 9) Push
    n = len(review_ids)
    with session_scope() as s:
        best = s.scalars(select(Clip).where(Clip.id.in_(review_ids)).order_by(Clip.total_score.desc())).first() if review_ids else None
        best_txt = f" Bester: „{best.title}“ ({best.total_score:.1f})" if best else ""
    if not ctx.done_step("notify"):
        live_part = ""
        if stream.live_mode:
            sup = suppressed_since(sid, stream.started_at)
            live_part = f" ({sup} Live-Pushes zusammengefasst)" if sup else ""
        notify("clips_ready", f"{n} neue Clips bereit", f"{stream.channel.display_name if stream.channel else stream.title}.{best_txt}{live_part}",
               url=f"/review?stream={sid}", stream_id=sid, tag=f"clips-{sid}")
        ctx.checkpoint("notify")
    _set_stream(sid, status="done")
    return f"{n} Clips in der Review-Liste"


def _make_captions(clip_ids: list[int], stream: Stream) -> None:
    if not clip_ids:
        return
    with session_scope() as s:
        clips = s.scalars(select(Clip).where(Clip.id.in_(clip_ids))).all()
        items = [CaptionInput(c.id, c.title, c.category, c.transcript, c.hook_text, stream.game or "") for c in clips if not c.captions]
    if not items:
        return
    ai = _ai_for(stream)
    caps = ai.captions(items)
    with session_scope() as s:
        for cid, cap in caps.items():
            c = s.get(Clip, cid)
            if c is not None:
                c.captions = cap


# --------------------------------------------------------------------------------------
# Modus B: Live-Kandidat
# --------------------------------------------------------------------------------------


@register("live_candidate")
def live_candidate(ctx: JobContext) -> str:
    sid = int(ctx.payload["stream_id"])
    wall = float(ctx.payload["wall"])
    source = ctx.payload.get("source", "auto")
    lookback = float(ctx.payload.get("lookback") or 45)
    stream = _load_stream(sid)
    ch = stream.channel
    after = 6.0 if source in ("manual", "chat_command") else 15.0
    if source in ("chat", "auto"):
        wall -= 6.0  # Chat läuft dem Bild ein paar Sekunden hinterher

    with session_scope() as s:
        st = s.get(Stream, sid)
        tl = timeline_for(s, st, include_incomplete=True)
        # Dauer unvollständiger Segmente aktualisieren (wachsende Datei)
        for seg in s.scalars(select(Segment).where(Segment.stream_id == sid, Segment.complete.is_(False))).all():
            try:
                seg.duration = ffmpeg.probe(seg.path).duration
            except ffmpeg.FFmpegError:
                pass
        tl = timeline_for(s, st, include_incomplete=True)
    if not tl.pieces:
        raise PermanentJobError("Noch keine Aufnahme vorhanden")
    off = tl.wall_to_offset(wall)
    assert off is not None
    if source in ("manual", "chat_command"):
        win_start, win_end, anchor = max(0.0, off - lookback), off + after, off - lookback / 2
    else:
        win_start, win_end, anchor = max(0.0, off - 32), off + after, off
    if win_end > tl.duration - 1:
        if ctx.state.get("waits", 0) > 30:
            win_end = tl.duration
        else:
            ctx.state["waits"] = ctx.state.get("waits", 0) + 1
            queue.save_state(ctx.job_id, ctx.state)
            raise RetryLater(8, "Moment noch nicht vollständig aufgenommen")
    work = Path(stream.dir) / "live"
    src, shift = materialize(tl, win_start, win_end, work, key=f"live_{ctx.job_id}")
    wav = work / f"live_{ctx.job_id}.wav"
    ffmpeg.extract_audio(src, wav, start=win_start - shift, duration=win_end - win_start)
    ctx.progress(0.2, "Transkribiere Live-Ausschnitt", "transcribe")
    tr = get_transcriber(live=True).transcribe(wav, ch.language if ch else "de").shifted(win_start)
    aa = audio_mod.analyze_wav(wav)
    words = tr.words()
    if source in ("manual", "chat_command"):
        trigger = [Signal("marker", anchor, 9.0, source)]
    else:
        trigger = [Signal(**x) for x in ctx.payload.get("signals", [])] or [Signal("chat", anchor, 3.0, source)]
        for x in trigger:
            x.t = anchor
    rel_words = [TWord(w.text, w.start - win_start, w.end - win_start, w.prob) for w in words]
    local = transcript_signals(words) + [
        Signal(x.type, x.t + win_start, x.strength, x.detail) for x in audio_signals(aa, rel_words)
    ]
    window = Window(start=win_start, end=win_end, anchor=anchor, signals=trigger + [x for x in local if win_start <= x.t <= win_end])
    ctx.progress(0.5, "Claude bewertet den Moment", "select")
    ai = _ai_for(stream)
    cfg = _selection_cfg(ch, quota=1)
    result = select_highlights(ai=ai, windows=[window], transcript=tr, media_duration=win_end, cfg=cfg)
    drafts = result.review or result.archive
    if not drafts:
        reason = result.discarded[0].note if result.discarded else "kein Clip gefunden"
        log.info("Live-Kandidat ohne Clip: Fenster %.1f–%.1f (Zeitstrahl %.1fs, Quelle %s+%.1f), %d Wörter, Entwürfe %s",
                 win_start, win_end, tl.duration, src.name, shift, len(words),
                 [(round(d.start, 1), round(d.end, 1), d.note) for d in result.discarded])
        return f"Kein Clip ({reason})"
    d = drafts[0]
    with session_scope() as s:
        st = s.get(Stream, sid)
        stored = store_selection(s, st, [d], [], [], origin="manual" if source in ("manual", "chat_command") else "live")
        clip_id = (stored["created"] or stored["confirmed"] or [None])[0]
        if ctx.payload.get("marker_id"):
            m = s.get(Marker, int(ctx.payload["marker_id"]))
            if m is not None:
                m.handled = True
    if clip_id is None:
        return "Bereits vorhanden"
    if stored["confirmed"] and not stored["created"]:
        return f"Moment schon als Clip {clip_id} vorhanden"
    _render_clip(clip_id, preview=True)
    _make_captions([clip_id], stream)
    threshold = float(settings_store.get("push_score_threshold") or 8.5)
    if d.total >= threshold or source in ("manual", "chat_command"):
        title = f"Clip mit Score {d.total:.1f} bereit" if source not in ("manual", "chat_command") else "Dein markierter Clip ist fertig"
        notify("strong_clip", title, d.title or d.hook_text, url=f"/review?stream={sid}&clip={clip_id}", stream_id=sid, tag=f"clip-{clip_id}")
    for f in (wav,):
        f.unlink(missing_ok=True)
    if src.parent == work and src.suffix == ".ts" and src.name.startswith("live_"):
        src.unlink(missing_ok=True)
    return f"Clip {clip_id} (Score {d.total:.1f})"


@register("live_scan_segment")
def live_scan_segment(ctx: JobContext) -> str:
    """Live-Modus: fertiges Segment auf Lautstärke-Ausreißer und Gelächter prüfen (zweites Signal neben dem Chat)."""
    sid = int(ctx.payload["stream_id"])
    path = Path(ctx.payload["path"])
    wall_start = float(ctx.payload["wall_start"])
    if not path.exists():
        return "Segment fehlt"
    wav = path.with_suffix(".scan.wav")
    ffmpeg.extract_audio(path, wav)
    try:
        aa = audio_mod.analyze_wav(wav)
    finally:
        wav.unlink(missing_ok=True)
    with session_scope() as s:
        st = s.get(Stream, sid)
        meta = dict(st.meta or {})
        base = meta.get("live_loudness", [])
        base = (base + [x for x in aa.loudness_db if x > -60])[-1800:]  # ~30 min Basislinie
        meta["live_loudness"] = base
        st.meta = meta
    if len(base) < 120:
        return "Basislinie wird aufgebaut"
    import numpy as np

    mu, sd = float(np.mean(base)), max(2.0, float(np.std(base)))
    peaks: list[tuple[float, float, str]] = []
    for t, db in enumerate(aa.loudness_db):
        z = (db - mu) / sd
        if z >= 3.0:
            peaks.append((float(t), z, "Lautstärke"))
    for t, lg in enumerate(aa.laughter):
        if lg >= 0.75:
            peaks.append((float(t), 3.0 + lg, "Gelächter"))
    peaks.sort(key=lambda p: -p[1])
    from ..daemon import create_marker

    made = 0
    used: list[float] = []
    for t, z, kind in peaks:
        if made >= 2 or any(abs(t - u) < 30 for u in used):
            continue
        used.append(t)
        create_marker(sid, "audio", note=f"{kind} ({z:.1f})", wall=wall_start + t,
                      signal={"type": "lautstärke" if kind == "Lautstärke" else "gelächter", "t": 0, "strength": min(4.0, z / 1.2),
                              "detail": kind})
        made += 1
    return f"{made} Audio-Kandidaten"


# --------------------------------------------------------------------------------------
# Rendern, Texte, Safety
# --------------------------------------------------------------------------------------


def _render_clip(clip_id: int, *, preview: bool, on_progress=None) -> Path:
    settings = get_settings()
    with session_scope() as s:
        clip = s.get(Clip, clip_id)
        if clip is None:
            raise PermanentJobError(f"Clip {clip_id} existiert nicht")
        stream = clip.stream
        ch = stream.channel
        tl = timeline_for(s, stream, include_incomplete=True)
        cuts = [tuple(c) for c in (clip.cuts or [[clip.start, clip.end]])]
        words = [Word.from_dict(w) for w in clip.words or []]
        spec_args = dict(
            hook_text=clip.hook_text if settings_store.get("hook_overlay") and clip.hook_text else None,
            context_line=clip.context_line or None, subtitle_lines=clip.subtitle_lines,
            layout=ch.layout if ch else "blur", facecam_rect=ch.facecam_rect if ch else None,
        )
        version = clip.render_version + 1
        slug = clip.slug or f"clip-{clip.id}"
        clip.render_status = "rendering"
        stream_id = stream.id
        stream_dir = Path(stream.dir)
    try:
        lo, hi = min(c[0] for c in cuts), max(c[1] for c in cuts)
        src, shift = materialize(tl, lo, hi, stream_dir / "live", key=f"render_{clip_id}")
        out_dir = settings.clips_dir / str(stream_id) / ("preview" if preview else "final")
        out = out_dir / (f"{clip_id}_v{version}.mp4" if preview else f"{slug}.mp4")
        render(RenderSpec(source=src, cuts=[(a - shift, b - shift) for a, b in cuts], out_path=out, words=words,
                          preview=preview, subtitle_style=settings_store.get("subtitle_style") or "ass", **spec_args),
               on_progress=on_progress)
        thumb = out_dir / f"{clip_id}_v{version}.jpg"
        make_thumbnail(out, thumb, t=min(1.2, max(0.1, sum(b - a for a, b in cuts) / 3)))
        if src.parent.name == "live" and src.name.startswith("render_"):
            src.unlink(missing_ok=True)
    except Exception as exc:
        with session_scope() as s:
            c = s.get(Clip, clip_id)
            if c is not None:
                c.render_status = "failed"
                c.render_error = str(exc)[:2000]
        raise
    with session_scope() as s:
        c = s.get(Clip, clip_id)
        if c is not None:
            old = c.preview_path if preview else c.render_path
            if preview:
                c.preview_path = str(out)
            else:
                c.render_path = str(out)
            c.thumb_path = str(thumb)
            c.render_version = version
            c.render_status = "done"
            c.render_error = None
            if old and old != str(out):
                Path(old).unlink(missing_ok=True)
    return out


@register("render_clip")
def render_clip_job(ctx: JobContext) -> str:
    cid = int(ctx.payload["clip_id"])
    preview = bool(ctx.payload.get("preview", True))
    out = _render_clip(cid, preview=preview, on_progress=lambda p: ctx.progress(p * 0.95, f"Rendere ({int(p * 100)} %)"))
    if ctx.payload.get("then_preview") and not preview:
        _render_clip(cid, preview=True)
    return f"Gerendert: {out.name}"


@register("captions")
def captions_job(ctx: JobContext) -> str:
    ids = [int(x) for x in ctx.payload["clip_ids"]]
    with session_scope() as s:
        if ctx.payload.get("force"):
            for c in s.scalars(select(Clip).where(Clip.id.in_(ids))).all():
                c.captions = {}
        first = s.get(Clip, ids[0])
        stream = first.stream if first else None
        if stream is not None:
            _ = stream.channel
            s.expunge(stream)
    if stream is None:
        raise PermanentJobError("Clip fehlt")
    _make_captions(ids, stream)
    return f"Texte für {len(ids)} Clips"


@register("safety_check")
def safety_check_job(ctx: JobContext) -> str:
    cid = int(ctx.payload["clip_id"])
    res = run_safety_check(cid)
    return "Safety ok" if res["ok"] else f"Safety-Hinweis: {', '.join(res['flags'])}"


def run_safety_check(clip_id: int) -> dict:
    """Eigener Safety-Check vor jeder Veröffentlichung (Claude + Regex, mit Frames aus dem Render)."""
    with session_scope() as s:
        c = s.get(Clip, clip_id)
        if c is None:
            raise PermanentJobError("Clip fehlt")
        stream = c.stream
        _ = stream.channel
        video = c.render_path or c.preview_path
        dur = c.duration
        item_args = dict(id=c.id, transcript=c.transcript, captions=c.captions or {})
        s.expunge(stream)
    frames: list[Path] = []
    if video and Path(video).exists() and settings_store.get("claude_vision"):
        fdir = Path(stream.dir) / "frames"
        fdir.mkdir(parents=True, exist_ok=True)
        for k, t in enumerate((0.8, dur / 2, max(0.5, dur - 1.0))):
            p = fdir / f"safety_{clip_id}_{k}.jpg"
            try:
                ffmpeg.extract_frame(video, t, p, width=512)
                frames.append(p)
            except ffmpeg.FFmpegError:
                pass
    ai = _ai_for(stream)
    result = ai.safety(SafetyInput(frames=frames, **item_args))
    from ..llm.ai import local_safety_scan

    flags = list(dict.fromkeys(result.flags + local_safety_scan(item_args["transcript"])))
    ok = result.ok and not flags
    with session_scope() as s:
        c = s.get(Clip, clip_id)
        c.safety = {"flags": flags, "note": result.note, "severity": result.severity if flags else "none", "source": "safety_check",
                    "checked_by": ai.name}
        c.safety_flagged = not ok
        c.safety_checked_at = utcnow()
    return {"ok": ok, "flags": flags, "note": result.note}


# --------------------------------------------------------------------------------------
# Veröffentlichen, Auswertung, Aufräumen, Export, Import
# --------------------------------------------------------------------------------------


@register("publish")
def publish_job(ctx: JobContext) -> str:
    from ..publish.runner import run_publication

    return run_publication(int(ctx.payload["publication_id"]), ctx)


@register("collect_metrics")
def collect_metrics_job(ctx: JobContext) -> str:
    from ..analytics.collector import collect_all

    n = collect_all()
    return f"Metriken für {n} Veröffentlichungen aktualisiert"


@register("cleanup_storage")
def cleanup_job(ctx: JobContext) -> str:
    from ..storage import cleanup, disk_status

    res = cleanup()
    ds = disk_status()
    if ds["warn"]:
        notify("error", "Speicher knapp", f"Nur noch {ds['free_gb']} GB frei ({ds['free_percent']} %).", url="/einstellungen")
    return f"{res['streams']} Streams/{res['clips']} Clips aufgeräumt, {res['freed_gb']} GB frei geworden"


@register("export_package")
def export_job(ctx: JobContext) -> str:
    from ..publish.export import build_export

    path = build_export([int(x) for x in ctx.payload["clip_ids"]], name=ctx.payload.get("name") or f"export_{ctx.job_id}",
                        on_progress=lambda p, m: ctx.progress(p, m))
    ctx.checkpoint("done", path=str(path))
    return f"Export fertig: {path.name}"


@register("import_url")
def import_url_job(ctx: JobContext) -> str:
    """VOD-Import per URL (yt-dlp) – nur für Material, an dem der Nutzer die Rechte hat."""
    import subprocess
    import sys

    url = ctx.payload["url"]
    if not ctx.payload.get("rights_confirmed"):
        raise PermanentJobError("Rechte am Material nicht bestätigt")
    settings = get_settings()
    out_dir = settings.uploads_dir / f"url_{ctx.job_id}"
    out_dir.mkdir(parents=True, exist_ok=True)
    ctx.progress(0.02, "Lade Video (yt-dlp)", "download")
    cmd = [sys.executable, "-m", "yt_dlp", "--no-playlist", "-f", "bv*[height<=1080]+ba/b[height<=1080]/b",
           "--merge-output-format", "mp4", "-o", str(out_dir / "%(title).80s.%(ext)s"), "--newline", url]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    assert proc.stdout is not None
    tail: list[str] = []
    for line in proc.stdout:
        tail = (tail + [line.strip()])[-15:]
        if "[download]" in line and "%" in line:
            try:
                pct = float(line.split("%")[0].split()[-1])
                ctx.progress(0.02 + 0.9 * pct / 100, f"Lade Video ({pct:.0f} %)")
            except ValueError:
                pass
    if proc.wait() != 0:
        raise RuntimeError("yt-dlp fehlgeschlagen: " + " | ".join(tail[-4:]))
    files = sorted(out_dir.glob("*.mp4")) or sorted(out_dir.glob("*.*"))
    if not files:
        raise RuntimeError("Download lieferte keine Datei")
    from ..ingest import create_stream_from_file

    st_id = create_stream_from_file(files[0], source_type="url", title=ctx.payload.get("title") or files[0].stem,
                                    channel_id=ctx.payload.get("channel_id"), auto_process=ctx.payload.get("auto_process", True))
    return f"Importiert als Stream {st_id}"


@register("vod_backup")
def vod_backup_job(ctx: JobContext) -> str:
    """Twitch-VOD nach Stream-Ende als Backup laden (füllt Aufnahme-Lücken)."""
    import subprocess
    import sys

    sid = int(ctx.payload["stream_id"])
    url = ctx.payload["vod_url"]
    stream = _load_stream(sid)
    out = Path(stream.dir) / "vod_backup.mp4"
    res = subprocess.run([sys.executable, "-m", "yt_dlp", "-f", "best[height<=1080]/best", "-o", str(out), url],
                         capture_output=True, text=True, timeout=6 * 3600)
    if res.returncode != 0:
        raise RuntimeError("VOD-Download fehlgeschlagen: " + res.stderr[-500:])
    meta = dict(stream.meta or {})
    meta["vod_backup"] = str(out)
    _set_stream(sid, meta=meta)
    return "VOD-Backup gespeichert"
