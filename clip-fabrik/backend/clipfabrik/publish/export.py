"""Fallback-Export: Clips + captions_<plattform>.csv als ZIP – zum Teilen direkt in die jeweilige App."""

from __future__ import annotations

import csv
import io
import zipfile
from pathlib import Path
from typing import Callable

from sqlalchemy import select

from ..config import get_settings
from ..db import Clip, session_scope


def captions_csv(clips: list[Clip], platform: str) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    if platform == "tiktok":
        w.writerow(["datei", "beschreibung", "hashtags", "score"])
    elif platform == "instagram":
        w.writerow(["datei", "caption", "hashtags", "score"])
    else:
        w.writerow(["datei", "titel", "beschreibung", "tags", "score"])
    for c in clips:
        cap = (c.captions or {}).get(platform, {})
        name = Path(c.render_path or c.preview_path or f"{c.slug}.mp4").name
        if platform == "tiktok":
            w.writerow([name, cap.get("description", c.title), " ".join(cap.get("hashtags", [])), c.total_score])
        elif platform == "instagram":
            w.writerow([name, cap.get("caption", c.title), " ".join(cap.get("hashtags", [])), c.total_score])
        else:
            w.writerow([name, cap.get("title", c.title), cap.get("description", ""), ", ".join(cap.get("tags", [])), c.total_score])
    return "﻿" + buf.getvalue()  # BOM, damit Excel/Numbers Umlaute richtig zeigen


def build_export(clip_ids: list[int], *, name: str, on_progress: Callable[[float, str], None] | None = None) -> Path:
    from ..jobs.handlers import _render_clip

    settings = get_settings()
    with session_scope() as s:
        ids = [c.id for c in s.scalars(select(Clip).where(Clip.id.in_(clip_ids))).all()]
    for i, cid in enumerate(ids):
        with session_scope() as s:
            c = s.get(Clip, cid)
            need = not c.render_path or not Path(c.render_path).exists() or c.render_status == "stale"
        if need:
            if on_progress:
                on_progress(0.8 * i / max(1, len(ids)), f"Rendere Original {i + 1}/{len(ids)}")
            _render_clip(cid, preview=False)
    with session_scope() as s:
        clips = s.scalars(select(Clip).where(Clip.id.in_(ids)).order_by(Clip.total_score.desc())).all()
        out = settings.exports_dir / f"{name}.zip"
        with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_STORED) as z:
            for c in clips:
                if c.render_path and Path(c.render_path).exists():
                    z.write(c.render_path, arcname=f"clips/{Path(c.render_path).name}")
            for platform in ("tiktok", "instagram", "youtube"):
                z.writestr(f"captions_{platform}.csv", captions_csv(clips, platform))
            z.writestr("LIESMICH.txt", (
                "Clip-Fabrik Export\n\n"
                "1. ZIP am Handy entpacken (Dateien-App).\n"
                "2. Clip in TikTok/Instagram/YouTube auswählen.\n"
                "3. Text aus captions_<plattform>.csv kopieren und einfügen.\n"
            ))
    if on_progress:
        on_progress(1.0, "Export fertig")
    return out
