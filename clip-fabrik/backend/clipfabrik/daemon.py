"""Daemon-Prozess: Live-Erkennung, Aufnahme, Chat, Live-Clip-Farmer und Zeitpläne.

Ablauf pro Kanal (nur mit bestätigter Zustimmung):
    offline --(stream.online / Polling)--> recording --(stream.offline / Polling)--> analyzing --> offline
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import threading
import time
from pathlib import Path

from sqlalchemy import select

from . import settings_store
from .analysis.chat import ChatEvent, LiveSpikeDetector
from .config import get_settings
from .db import Channel, Marker, Segment, Stream, session_scope, utcnow
from .ingest import FolderWatcher
from .jobs import queue
from .push.notify import notify
from .sources import from_epoch
from .storage import disk_status
from .twitch.eventsub import eventsub_secret
from .twitch.helix import Helix, TwitchError
from .twitch.irc import ChatClient, is_clip_command
from .twitch.recorder import Recorder, RecorderEvent

log = logging.getLogger(__name__)


class ChannelRuntime:
    def __init__(self, channel_id: int, login: str, stream_id: int) -> None:
        self.channel_id = channel_id
        self.login = login
        self.stream_id = stream_id
        self.recorder: Recorder | None = None
        self.chat: ChatClient | None = None
        self.detector: LiveSpikeDetector | None = None
        self.chat_file = None
        self.lock = threading.Lock()
        self.auto_candidates: list[float] = []
        self.offline_since: float | None = None


class Daemon:
    def __init__(self, *, poll_interval: float | None = None, tick: float = 2.0) -> None:
        self.settings = get_settings()
        self.poll_interval = poll_interval or self.settings.twitch_poll_interval
        self.tick = tick
        self.runtimes: dict[int, ChannelRuntime] = {}
        self.stop_event = threading.Event()
        self.folder = FolderWatcher()
        self._last: dict[str, float] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ Hauptschleife
    def run_forever(self) -> None:
        log.info("Daemon gestartet (Polling alle %.0fs)", self.poll_interval)
        self.recover()
        while not self.stop_event.is_set():
            try:
                self.step()
            except Exception:  # noqa: BLE001
                log.exception("Daemon-Schritt fehlgeschlagen")
            self.stop_event.wait(self.tick)
        self.shutdown()

    def _due(self, key: str, every: float) -> bool:
        now = time.monotonic()
        if now - self._last.get(key, -1e9) >= every:
            self._last[key] = now
            return True
        return False

    def step(self) -> None:
        self.handle_hints()
        if self._due("poll", self.poll_interval):
            self.poll()
        self.check_spikes()
        if self._due("scheduler", 30):
            from .publish.scheduler import tick as publish_tick

            publish_tick()
        if self._due("folder", 30):
            self.folder.scan()
        if self._due("disk", 60):
            self.check_disk()
        if self._due("eventsub", 600):
            self.sync_eventsub()
        if self._due("metrics", 6 * 3600):
            queue.enqueue("collect_metrics", {}, priority=300, unique_key="collect_metrics")
        if self._due("cleanup", 24 * 3600):
            queue.enqueue("cleanup_storage", {}, priority=400, unique_key="cleanup_storage")

    def shutdown(self) -> None:
        for rt in list(self.runtimes.values()):
            if rt.chat:
                rt.chat.stop()
            if rt.recorder:
                rt.recorder.stop(timeout=25)
            if rt.chat_file:
                rt.chat_file.close()

    # ------------------------------------------------------------------ Live-Erkennung
    def handle_hints(self) -> None:
        with session_scope() as s:
            hinted = s.scalars(select(Channel).where(Channel.live_hint.is_not(None))).all()
            items = [(c.id, c.live_hint) for c in hinted]
            for c in hinted:
                c.live_hint = None
        for cid, hint in items:
            if hint == "online" and cid not in self.runtimes:
                self._last["poll"] = -1e9  # sofort pollen (liefert Titel/Spiel)
            elif hint == "offline" and cid in self.runtimes:
                self.go_offline(cid)

    def poll(self) -> None:
        helix = Helix()
        with session_scope() as s:
            channels = [(c.id, c.login) for c in s.scalars(select(Channel).where(Channel.consent_confirmed.is_(True))).all()]
        if not channels:
            return
        if not helix.configured:
            if self._due("warn_helix", 3600):
                log.warning("Twitch-App (Client-ID/Secret) fehlt: Live-Erkennung aus")
            return
        try:
            live = helix.get_streams([login for _, login in channels])
        except (TwitchError, Exception) as exc:  # noqa: BLE001
            log.error("Live-Status nicht abrufbar: %s", exc)
            with session_scope() as s:
                for cid, _ in channels:
                    ch = s.get(Channel, cid)
                    if ch:
                        ch.last_error = f"Live-Status: {exc}"
            return
        now = utcnow()
        for cid, login in channels:
            info = live.get(login.lower())
            with session_scope() as s:
                ch = s.get(Channel, cid)
                if ch:
                    ch.last_checked_at = now
                    if info and not ch.twitch_user_id:
                        ch.twitch_user_id = info.get("user_id")
            if info and cid not in self.runtimes:
                self.go_online(cid, info)
            elif info and cid in self.runtimes:
                rt = self.runtimes[cid]
                rt.offline_since = None
                if rt.recorder and not rt.recorder.active and not rt.recorder.unrecordable and rt.recorder._thread and not rt.recorder._thread.is_alive():
                    self._start_recorder(rt)  # Aufnahme-Thread beendet, Stream läuft noch -> neu starten
            elif not info and cid in self.runtimes:
                rt = self.runtimes[cid]
                # zweimal offline gesehen (Twitch-API hängt manchmal kurz nach)
                if rt.offline_since is None:
                    rt.offline_since = time.time()
                elif time.time() - rt.offline_since >= self.poll_interval * 0.9:
                    self.go_offline(cid)

    def go_online(self, cid: int, info: dict, *, resume_stream_id: int | None = None) -> None:
        with session_scope() as s:
            ch = s.get(Channel, cid)
            if ch is None or not ch.consent_confirmed:
                return
            if not (ch.live_enabled or ch.post_enabled):
                ch.status = "live"
                return
            if resume_stream_id:
                st = s.get(Stream, resume_stream_id)
            else:
                st = Stream(channel_id=cid, source_type="twitch", title=info.get("title", "")[:300], game=info.get("game_name", "")[:200],
                            twitch_stream_id=info.get("id"), status="recording", dir="", live_mode=ch.live_enabled,
                            post_mode=ch.post_enabled, started_at=utcnow())
                s.add(st)
                s.flush()
                st.dir = str(self.settings.streams_dir / str(st.id))
            Path(st.dir, "segments").mkdir(parents=True, exist_ok=True)
            ch.status = "recording"
            ch.last_error = None
            rt = ChannelRuntime(cid, ch.login, st.id)
            live_mode = ch.live_enabled
            name = ch.display_name or ch.login
            sdir = Path(st.dir)
        self.runtimes[cid] = rt
        rt.chat_file = open(sdir / "chat.jsonl", "a", encoding="utf-8")
        if live_mode:
            rt.detector = LiveSpikeDetector(set(settings_store.get("chat_emotes") or []))
        self._start_recorder(rt)
        self._start_chat(rt)
        if not resume_stream_id:
            notify("stream_started", f"{name} ist live", info.get("title", "") or "Aufnahme läuft", url="/", stream_id=rt.stream_id)
        log.info("%s live: Aufnahme läuft (Stream %s)", name, rt.stream_id)

    def _start_recorder(self, rt: ChannelRuntime) -> None:
        if not disk_status()["critical"]:
            url = self.settings.twitch_stream_url_template.format(login=rt.login)
            with session_scope() as s:
                st = s.get(Stream, rt.stream_id)
                out = Path(st.dir) / "segments"
            rt.recorder = Recorder(url=url, out_dir=out, segment_seconds=self.settings.segment_seconds,
                                   on_event=lambda ev, rt=rt: self.on_recorder_event(rt, ev),
                                   still_live=lambda rt=rt: rt.channel_id in self.runtimes and rt.offline_since is None)
            rt.recorder.start()
        else:
            notify("error", "Speicher voll", "Aufnahme nicht gestartet: zu wenig freier Speicher.", url="/einstellungen")

    def _start_chat(self, rt: ChannelRuntime) -> None:
        helix = Helix()
        token = login = None
        try:
            ut = helix.user_token("mod") if helix.configured else None
            if ut:
                token, acc = ut
                login = acc.login
        except TwitchError as exc:
            log.warning("Mod-Token nicht nutzbar (%s): Chat wird anonym gelesen", exc)
        rt.chat = ChatClient(rt.login, url=self.settings.twitch_irc_url, token=token, login=login,
                             on_event=lambda ev, rt=rt: self.on_chat_event(rt, ev))
        rt.chat.my_login = login  # type: ignore[attr-defined]
        rt.chat.start()

    def go_offline(self, cid: int) -> None:
        rt = self.runtimes.pop(cid, None)
        if rt is None:
            return
        log.info("%s offline: beende Aufnahme (Stream %s)", rt.login, rt.stream_id)
        if rt.chat:
            rt.chat.stop()
        if rt.recorder:
            rt.recorder.stop(timeout=30)
        if rt.chat_file:
            with rt.lock:
                rt.chat_file.close()
        with session_scope() as s:
            ch = s.get(Channel, cid)
            st = s.get(Stream, rt.stream_id)
            for seg in s.scalars(select(Segment).where(Segment.stream_id == rt.stream_id, Segment.complete.is_(False))).all():
                if not Path(seg.path).exists() or Path(seg.path).stat().st_size == 0:
                    s.delete(seg)
            st.ended_at = utcnow()
            if st.status == "recording":
                st.status = "recorded"
            n_segments = len(s.scalars(select(Segment.id).where(Segment.stream_id == st.id)).all())
            process = (st.post_mode or st.live_mode) and n_segments > 0 and st.status != "unrecordable"
            ch.status = "analyzing" if process else "offline"
            name = ch.display_name or ch.login
            vod_backup = ch.vod_backup and ch.twitch_user_id
            user_id = ch.twitch_user_id
            minutes = int((st.ended_at - st.started_at).total_seconds() / 60)
        if process:
            queue.enqueue("process_stream", {"stream_id": rt.stream_id}, priority=50, unique_key=f"process:{rt.stream_id}",
                          stream_id=rt.stream_id)
        notify("stream_ended", f"{name} offline", f"{minutes} min aufgenommen." + (" Analyse läuft." if process else ""),
               url="/", stream_id=rt.stream_id)
        if vod_backup:
            try:
                vod = Helix().get_latest_vod(user_id)
                if vod and vod.get("url"):
                    queue.enqueue("vod_backup", {"stream_id": rt.stream_id, "vod_url": vod["url"]}, priority=350,
                                  run_after=utcnow() + dt.timedelta(minutes=20), stream_id=rt.stream_id)
            except TwitchError as exc:
                log.warning("VOD-Backup nicht möglich: %s", exc)

    def recover(self) -> None:
        """Nach Neustart: offene Aufnahmen fortsetzen (wenn noch live) oder sauber abschließen."""
        with session_scope() as s:
            open_streams = s.scalars(select(Stream).where(Stream.status == "recording", Stream.source_type == "twitch")).all()
            items = [(st.id, st.channel_id) for st in open_streams]
        if not items:
            return
        helix = Helix()
        live: dict[str, dict] = {}
        if helix.configured:
            try:
                with session_scope() as s:
                    logins = [s.get(Channel, cid).login for _, cid in items if s.get(Channel, cid)]
                live = helix.get_streams(logins)
            except Exception as exc:  # noqa: BLE001
                log.error("Recover: Live-Status nicht abrufbar: %s", exc)
        for sid, cid in items:
            with session_scope() as s:
                ch = s.get(Channel, cid)
                login = ch.login if ch else ""
            if login.lower() in live:
                log.info("Setze Aufnahme von %s fort (Stream %s)", login, sid)
                self.go_online(cid, live[login.lower()], resume_stream_id=sid)
            else:
                self.runtimes[cid] = ChannelRuntime(cid, login, sid)
                self.go_offline(cid)

    # ------------------------------------------------------------------ Ereignisse
    def on_recorder_event(self, rt: ChannelRuntime, ev: RecorderEvent) -> None:
        if ev.kind == "segment" and ev.segment:
            seg = ev.segment
            with session_scope() as s:
                row = s.scalar(select(Segment).where(Segment.stream_id == rt.stream_id, Segment.run == seg.run, Segment.idx == seg.idx))
                if row is None:
                    row = Segment(stream_id=rt.stream_id, run=seg.run, idx=seg.idx, path=str(seg.path),
                                  wall_start=from_epoch(seg.wall_start), duration=seg.duration, complete=seg.complete)
                    s.add(row)
                elif seg.complete and not row.complete:
                    row.complete = True
                    row.duration = seg.duration
                    row.wall_start = from_epoch(seg.wall_start)
                else:
                    return
                st = s.get(Stream, rt.stream_id)
                if seg.complete:
                    st.duration = (st.duration or 0) + seg.duration
                live_mode = st.live_mode
            if seg.complete and live_mode:
                queue.enqueue("live_scan_segment", {"stream_id": rt.stream_id, "path": str(seg.path), "wall_start": seg.wall_start,
                                                    "duration": seg.duration}, priority=30, stream_id=rt.stream_id)
        elif ev.kind == "ad":
            self._meta_append(rt.stream_id, "ads", {"wall": ev.wall, "msg": ev.message[:200]})
        elif ev.kind == "reconnect":
            self._meta_append(rt.stream_id, "reconnects", {"wall": ev.wall, "msg": ev.message[:200]})
        elif ev.kind == "unrecordable":
            with session_scope() as s:
                st = s.get(Stream, rt.stream_id)
                st.status = "unrecordable"
                st.error = ev.message
                ch = s.get(Channel, rt.channel_id)
                ch.status = "live"
                ch.last_error = ev.message
            notify("error", "Stream nicht aufnehmbar", f"{rt.login}: {ev.message}. Twitch-Clips/VOD als Ausweg.", url="/",
                   stream_id=rt.stream_id)

    def _meta_append(self, stream_id: int, key: str, item: dict) -> None:
        with session_scope() as s:
            st = s.get(Stream, stream_id)
            meta = dict(st.meta or {})
            meta[key] = (meta.get(key) or [])[-200:] + [item]
            st.meta = meta

    def on_chat_event(self, rt: ChannelRuntime, ev: ChatEvent) -> None:
        with rt.lock:
            if rt.chat_file and not rt.chat_file.closed:
                rt.chat_file.write(ev.to_json() + "\n")
                rt.chat_file.flush()
            if rt.detector:
                rt.detector.feed(ev)
        my_login = getattr(rt.chat, "my_login", None)
        with session_scope() as s:
            ch = s.get(Channel, rt.channel_id)
            allow_cmd = ch.chat_clip_command if ch else False
        if allow_cmd and is_clip_command(ev, my_login=my_login):
            log.info("!clip von %s in #%s", ev.user, rt.login)
            create_marker(rt.stream_id, "chat_command", note=f"!clip von {ev.user}", wall=ev.t)

    def check_spikes(self) -> None:
        now = time.time()
        for rt in list(self.runtimes.values()):
            if not rt.detector:
                continue
            with rt.lock:
                spike = rt.detector.check(now)
            if spike is None:
                continue
            rt.auto_candidates = [t for t in rt.auto_candidates if now - t < 3600] + [now]
            if len(rt.auto_candidates) > 40:
                log.info("Live-Kandidaten-Limit pro Stunde erreicht (%s)", rt.login)
                continue
            log.info("Chat-Spitze in #%s: %s", rt.login, spike.reason)
            create_marker(rt.stream_id, "auto", note=spike.reason, wall=spike.t,
                          signal={"type": "chat", "t": 0, "strength": min(5.0, 1.5 + spike.score / 3), "detail": spike.reason})

    # ------------------------------------------------------------------ Sonstiges
    def check_disk(self) -> None:
        ds = disk_status()
        if ds["critical"] and self.runtimes:
            log.error("Speicher kritisch (%.1f GB frei): beende Aufnahmen", ds["free_gb"])
            notify("error", "Speicher voll", f"Nur {ds['free_gb']} GB frei – Aufnahmen gestoppt.", url="/einstellungen")
            for rt in self.runtimes.values():
                if rt.recorder:
                    rt.recorder.stop(timeout=5)
        elif ds["warn"] and self._due("disk_warn", 6 * 3600):
            notify("error", "Speicher wird knapp", f"{ds['free_gb']} GB frei ({ds['free_percent']} %).", url="/einstellungen")

    def sync_eventsub(self) -> None:
        public = self.settings.public_url
        helix = Helix()
        if not helix.configured or not public.startswith("https://"):
            return
        callback = public.rstrip("/") + "/api/twitch/eventsub"
        secret = eventsub_secret()
        with session_scope() as s:
            channels = s.scalars(select(Channel).where(Channel.consent_confirmed.is_(True), Channel.twitch_user_id.is_not(None))).all()
            todo = [(c.id, c.twitch_user_id, list(c.eventsub_ids or [])) for c in channels]
        for cid, uid, ids in todo:
            if len(ids) >= 2:
                continue
            new_ids = []
            for t in ("stream.online", "stream.offline"):
                try:
                    new_ids.append(helix.eventsub_subscribe(t, uid, callback, secret))
                except TwitchError as exc:
                    log.warning("EventSub %s für %s fehlgeschlagen: %s", t, uid, exc)
            with session_scope() as s:
                ch = s.get(Channel, cid)
                ch.eventsub_ids = new_ids


def create_marker(stream_id: int, source: str, *, note: str = "", wall: float | None = None, lookback: float | None = None,
                  signal: dict | None = None) -> int:
    """Marker anlegen (manuell, !clip, Automatik) und Live-Kandidat einplanen; optional Twitch-Clip erzeugen."""
    wall = wall or time.time()
    lookback = lookback or float(settings_store.get("manual_lookback") or 45)
    delay = 8 if source in ("manual", "chat_command") else 16
    with session_scope() as s:
        st = s.get(Stream, stream_id)
        ch = st.channel
        m = Marker(stream_id=stream_id, wall_time=from_epoch(wall), lookback=lookback, source=source, note=note[:300],
                   signal=signal or {})
        s.add(m)
        s.flush()
        mid = m.id
        make_twitch_clip = bool(ch and ch.create_twitch_clips and ch.twitch_user_id)
        broadcaster = ch.twitch_user_id if ch else None
    payload = {"stream_id": stream_id, "wall": wall, "source": source, "lookback": lookback, "marker_id": mid}
    if signal:
        payload["signals"] = [signal]
    queue.enqueue("live_candidate", payload, priority=20, unique_key=f"live:{stream_id}:{int(wall // 20)}:{source}",
                  run_after=utcnow() + dt.timedelta(seconds=delay), stream_id=stream_id)
    if make_twitch_clip and broadcaster:
        threading.Thread(target=_twitch_clip, args=(mid, broadcaster), daemon=True).start()
    return mid


def _twitch_clip(marker_id: int, broadcaster_id: str) -> None:
    helix = Helix()
    try:
        ut = helix.user_token("mod")
        if not ut:
            return
        clip = helix.create_clip(broadcaster_id, ut[0])
        with session_scope() as s:
            m = s.get(Marker, marker_id)
            if m:
                m.twitch_clip_id = clip.get("id")
                m.twitch_clip_url = clip.get("edit_url")
    except TwitchError as exc:
        log.warning("Twitch-Clip als Marker fehlgeschlagen: %s", exc)


__all__ = ["Daemon", "create_marker", "json"]
