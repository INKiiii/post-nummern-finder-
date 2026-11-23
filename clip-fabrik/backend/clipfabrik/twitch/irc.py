"""Twitch-Chat über IRC (WebSocket) mit meinem Mod-Token (Scope chat:read).

Liest Nachrichten, Subs/Raids/Bits (USERNOTICE), Timeouts/Bans (CLEARCHAT) und gelöschte
Nachrichten (CLEARMSG). Shared-Chat-Nachrichten aus anderen Kanälen sind über das Tag
``source-room-id`` erkennbar. Ohne Login wird anonym (nur lesen) verbunden.
"""

from __future__ import annotations

import logging
import random
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

from ..analysis.chat import ChatEvent

log = logging.getLogger(__name__)

_TAG_UNESCAPE = {"\\s": " ", "\\:": ";", "\\\\": "\\", "\\r": "\r", "\\n": "\n"}


@dataclass
class IrcMessage:
    tags: dict[str, str] = field(default_factory=dict)
    prefix: str = ""
    command: str = ""
    params: list[str] = field(default_factory=list)

    @property
    def nick(self) -> str:
        return self.prefix.split("!", 1)[0] if self.prefix else ""

    @property
    def trailing(self) -> str:
        return self.params[-1] if self.params else ""


def _unescape(v: str) -> str:
    out = []
    i = 0
    while i < len(v):
        two = v[i:i + 2]
        if two in _TAG_UNESCAPE:
            out.append(_TAG_UNESCAPE[two])
            i += 2
        else:
            out.append(v[i])
            i += 1
    return "".join(out)


def parse_irc(line: str) -> IrcMessage:
    msg = IrcMessage()
    rest = line.rstrip("\r\n")
    if rest.startswith("@"):
        tag_str, _, rest = rest[1:].partition(" ")
        for kv in tag_str.split(";"):
            k, _, v = kv.partition("=")
            msg.tags[k] = _unescape(v)
    if rest.startswith(":"):
        msg.prefix, _, rest = rest[1:].partition(" ")
    if " :" in rest:
        head, _, trailing = rest.partition(" :")
        parts = head.split()
        msg.command = parts[0] if parts else ""
        msg.params = parts[1:] + [trailing]
    else:
        parts = rest.split()
        msg.command = parts[0] if parts else ""
        msg.params = parts[1:]
    return msg


def _badges(tags: dict[str, str]) -> set[str]:
    return {b.split("/", 1)[0] for b in tags.get("badges", "").split(",") if b}


def _emote_count(tags: dict[str, str]) -> int:
    em = tags.get("emotes", "")
    if not em:
        return 0
    return sum(len(part.split(":", 1)[1].split(",")) for part in em.split("/") if ":" in part)


def to_event(msg: IrcMessage, now: float | None = None) -> ChatEvent | None:
    t = now if now is not None else time.time()
    if "tmi-sent-ts" in msg.tags:
        try:
            t = int(msg.tags["tmi-sent-ts"]) / 1000.0
        except ValueError:
            pass
    shared = bool(msg.tags.get("source-room-id")) and msg.tags.get("source-room-id") != msg.tags.get("room-id")
    if msg.command == "PRIVMSG":
        badges = _badges(msg.tags)
        bits = int(msg.tags.get("bits", "0") or 0)
        return ChatEvent(
            t=t, kind="msg", user=msg.tags.get("display-name") or msg.nick, text=msg.trailing, emotes=_emote_count(msg.tags),
            bits=bits, is_mod=("moderator" in badges or msg.tags.get("mod") == "1"), is_broadcaster="broadcaster" in badges,
            shared=shared,
        )
    if msg.command == "USERNOTICE":
        mid = msg.tags.get("msg-id", "")
        kind = {"sub": "sub", "resub": "resub", "subgift": "subgift", "submysterygift": "submysterygift", "raid": "raid",
                "anonsubgift": "subgift", "giftpaidupgrade": "sub"}.get(mid)
        if kind is None:
            return None
        viewers = int(msg.tags.get("msg-param-viewerCount", "0") or 0) if kind == "raid" else 0
        return ChatEvent(t=t, kind=kind, user=msg.tags.get("display-name", ""), text=msg.trailing if len(msg.params) > 1 else "",
                         viewers=viewers, shared=shared)
    if msg.command == "CLEARCHAT":
        if len(msg.params) < 2:
            return ChatEvent(t=t, kind="clear")
        kind = "timeout" if msg.tags.get("ban-duration") else "ban"
        return ChatEvent(t=t, kind=kind, user=msg.trailing, shared=shared)
    if msg.command == "CLEARMSG":
        return ChatEvent(t=t, kind="clear", user=msg.tags.get("login", ""), shared=shared)
    return None


def is_clip_command(ev: ChatEvent, *, my_login: str | None = None, command: str = "!clip") -> bool:
    """!clip nur von Mods, dem Streamer oder mir selbst."""
    if ev.kind != "msg" or ev.shared:
        return False
    text = ev.text.strip().lower()
    if not (text == command or text.startswith(command + " ")):
        return False
    return ev.is_mod or ev.is_broadcaster or (my_login is not None and ev.user.lower() == my_login.lower())


class ChatClient:
    """Liest den Chat eines Kanals in einem eigenen Thread, mit automatischem Wiederverbinden."""

    def __init__(self, channel: str, *, url: str, token: str | None, login: str | None,
                 on_event: Callable[[ChatEvent], None]) -> None:
        self.channel = channel.lower()
        self.url = url
        self.token = token
        self.login = login if token else f"justinfan{random.randint(10000, 99999)}"
        self.on_event = on_event
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.connected = False
        self.last_error: str | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name=f"chat-{self.channel}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        from websockets.sync.client import connect

        backoff = 2.0
        while not self._stop.is_set():
            try:
                with connect(self.url, open_timeout=15, close_timeout=3) as ws:
                    ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands")
                    ws.send(f"PASS oauth:{self.token}" if self.token else "PASS SCHMOOPIIE")
                    ws.send(f"NICK {self.login}")
                    ws.send(f"JOIN #{self.channel}")
                    self.connected = True
                    backoff = 2.0
                    log.info("Chat verbunden: #%s (%s)", self.channel, "Mod-Login" if self.token else "anonym")
                    while not self._stop.is_set():
                        try:
                            data = ws.recv(timeout=1.0)
                        except TimeoutError:
                            continue
                        for line in str(data).split("\r\n"):
                            if not line:
                                continue
                            msg = parse_irc(line)
                            if msg.command == "PING":
                                ws.send("PONG :" + msg.trailing)
                            elif msg.command == "RECONNECT":
                                raise ConnectionError("Server verlangt Reconnect")
                            elif msg.command == "NOTICE" and "authentication failed" in msg.trailing.lower():
                                self.last_error = "Chat-Login fehlgeschlagen (Token abgelaufen?)"
                                raise ConnectionError(self.last_error)
                            else:
                                ev = to_event(msg)
                                if ev is not None:
                                    try:
                                        self.on_event(ev)
                                    except Exception:  # noqa: BLE001
                                        log.exception("Chat-Ereignis-Verarbeitung")
            except Exception as exc:  # noqa: BLE001
                self.connected = False
                if self._stop.is_set():
                    break
                self.last_error = str(exc)
                log.warning("Chat #%s getrennt (%s), neuer Versuch in %.0fs", self.channel, exc, backoff)
                self._stop.wait(backoff)
                backoff = min(60.0, backoff * 2)
        self.connected = False
