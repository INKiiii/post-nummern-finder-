"""Mock-Twitch-Server für Tests und Demo: Helix-API, OAuth, EventSub-Registrierung, HLS-Livestream
(per ffmpeg erzeugt) und IRC-Chat über WebSocket.

Start als Programm (Demo):  python -m clipfabrik.devtools.mock_twitch --port 9999 --login teststreamer
"""

from __future__ import annotations

import argparse
import asyncio
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class MockTwitch:
    def __init__(self, port: int | None = None, workdir: Path | None = None) -> None:
        self.port = port or free_port()
        self.dir = workdir or Path(tempfile.mkdtemp(prefix="mocktwitch_"))
        self.users: dict[str, dict] = {}
        self.live: dict[str, dict] = {}
        self.gen: dict[str, subprocess.Popen] = {}
        self.clips_created: list[dict] = []
        self.eventsub: list[dict] = []
        self.irc_clients: list[tuple[asyncio.Queue, set[str]]] = []
        self.loop: asyncio.AbstractEventLoop | None = None
        self.server: uvicorn.Server | None = None
        self.thread: threading.Thread | None = None
        self.app = self._build_app()

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def env(self) -> dict[str, str]:
        return {
            "TWITCH_CLIENT_ID": "mock-client-id", "TWITCH_CLIENT_SECRET": "mock-client-secret",
            "TWITCH_API_BASE": f"{self.base}/helix", "TWITCH_AUTH_BASE": f"{self.base}/oauth2",
            "TWITCH_IRC_URL": f"ws://127.0.0.1:{self.port}/irc",
            "TWITCH_STREAM_URL_TEMPLATE": f"hls://{self.base}/hls/{{login}}/index.m3u8",
        }

    def add_user(self, login: str, uid: str | None = None) -> dict:
        u = {"id": uid or str(100000 + len(self.users)), "login": login.lower(), "display_name": login,
             "profile_image_url": "https://example.invalid/avatar.png"}
        self.users[login.lower()] = u
        return u

    # ------------------------------------------------------------------ Live-Steuerung
    def set_live(self, login: str, live: bool, title: str = "Testturnier") -> None:
        login = login.lower()
        if live:
            u = self.users.get(login) or self.add_user(login)
            self.live[login] = {"id": str(int(time.time())), "user_id": u["id"], "user_login": login, "user_name": u["display_name"],
                                "type": "live", "title": title, "game_name": "Testspiel", "viewer_count": 123}
            self._start_hls(login)
        else:
            self.live.pop(login, None)
            self._stop_hls(login, end=True)

    def interrupt(self, login: str, seconds: float) -> None:
        """Simuliert einen Verbindungsabbruch (Playlist verschwindet kurz), Stream bleibt laut API live."""
        self._stop_hls(login, end=False, remove=True)
        time.sleep(seconds)
        self._start_hls(login)

    def _start_hls(self, login: str) -> None:
        out = self.dir / "hls" / login
        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        # Bild + Ton mit regelmäßigen lauten Stellen (Ausraster) alle 20 s
        cmd = [
            shutil.which("ffmpeg") or "ffmpeg", "-hide_banner", "-loglevel", "error", "-re",
            "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30",
            "-f", "lavfi", "-i", "sine=f=330:r=48000",
            "-filter_complex", "[1:a]volume='if(lt(mod(t,20),2),1.0,0.08)':eval=frame[a]",
            "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "30",
            "-c:a", "aac", "-b:a", "96k", "-f", "hls", "-hls_time", "1", "-hls_list_size", "8",
            "-hls_flags", "delete_segments+independent_segments", str(out / "index.m3u8"),
        ]
        self.gen[login] = subprocess.Popen(cmd, stdin=subprocess.DEVNULL)
        deadline = time.time() + 15
        while time.time() < deadline and not (out / "index.m3u8").exists():
            time.sleep(0.2)

    def _stop_hls(self, login: str, *, end: bool, remove: bool = False) -> None:
        p = self.gen.pop(login, None)
        if p is not None:
            p.terminate()
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
        pl = self.dir / "hls" / login / "index.m3u8"
        if remove:
            pl.unlink(missing_ok=True)
        elif end and pl.exists() and "#EXT-X-ENDLIST" not in pl.read_text():
            with open(pl, "a") as f:
                f.write("#EXT-X-ENDLIST\n")

    # ------------------------------------------------------------------ Chat
    def say(self, channel: str, user: str, text: str, *, mod: bool = False, broadcaster: bool = False, room_id: str = "1") -> None:
        badges = "broadcaster/1" if broadcaster else ("moderator/1" if mod else "")
        ts = int(time.time() * 1000)
        line = (f"@badges={badges};display-name={user};emotes=;mod={1 if mod else 0};room-id={room_id};tmi-sent-ts={ts} "
                f":{user.lower()}!{user.lower()}@{user.lower()}.tmi.twitch.tv PRIVMSG #{channel.lower()} :{text}")
        self._broadcast(channel, line)

    def usernotice(self, channel: str, msg_id: str, **tags: str) -> None:
        t = ";".join([f"msg-id={msg_id}", f"tmi-sent-ts={int(time.time() * 1000)}"] + [f"{k}={v}" for k, v in tags.items()])
        self._broadcast(channel, f"@{t} :tmi.twitch.tv USERNOTICE #{channel.lower()}")

    def _broadcast(self, channel: str, line: str) -> None:
        if self.loop is None:
            return
        for q, joined in list(self.irc_clients):
            if channel.lower() in joined:
                asyncio.run_coroutine_threadsafe(q.put(line), self.loop)

    def irc_joined(self, channel: str) -> bool:
        return any(channel.lower() in j for _, j in self.irc_clients)

    # ------------------------------------------------------------------ App
    def _build_app(self) -> FastAPI:
        app = FastAPI()
        mock = self

        @app.on_event("startup")
        async def _startup() -> None:
            mock.loop = asyncio.get_running_loop()

        @app.post("/oauth2/token")
        async def token(request: Request):
            form = await request.form()
            if form.get("grant_type") == "client_credentials":
                return {"access_token": "mock-app-token", "expires_in": 3600, "token_type": "bearer"}
            return {"access_token": "mock-user-token", "refresh_token": "mock-refresh", "expires_in": 14000,
                    "scope": ["chat:read", "clips:edit"], "token_type": "bearer"}

        @app.get("/oauth2/validate")
        async def validate():
            return {"client_id": "mock-client-id", "login": "modmaus", "user_id": "999", "scopes": ["chat:read", "clips:edit"],
                    "expires_in": 14000}

        @app.get("/oauth2/authorize")
        async def authorize(redirect_uri: str, state: str):
            return RedirectResponse(f"{redirect_uri}?code=mockcode&state={state}")

        @app.get("/helix/users")
        async def users(request: Request):
            logins = request.query_params.getlist("login")
            return {"data": [mock.users.get(lg.lower()) or mock.add_user(lg) for lg in logins]}

        @app.get("/helix/streams")
        async def streams(request: Request):
            logins = [x.lower() for x in request.query_params.getlist("user_login")]
            return {"data": [mock.live[lg] for lg in logins if lg in mock.live]}

        @app.post("/helix/clips")
        async def clips(request: Request):
            if not request.headers.get("authorization", "").endswith("mock-user-token"):
                return JSONResponse({"error": "Unauthorized", "status": 401, "message": "user token required"}, status_code=401)
            cid = f"MockClip{len(mock.clips_created) + 1}"
            mock.clips_created.append({"broadcaster_id": request.query_params.get("broadcaster_id"), "id": cid})
            return JSONResponse({"data": [{"id": cid, "edit_url": f"https://clips.twitch.tv/{cid}/edit"}]}, status_code=202)

        @app.get("/helix/videos")
        async def videos(user_id: str):
            return {"data": [{"id": "v1", "url": f"{mock.base}/vod/v1", "type": "archive"}]}

        @app.post("/helix/eventsub/subscriptions")
        async def eventsub(request: Request):
            body = await request.json()
            mock.eventsub.append(body)
            return JSONResponse({"data": [{"id": f"sub{len(mock.eventsub)}", "status": "webhook_callback_verification_pending",
                                           "type": body["type"]}]}, status_code=202)

        @app.get("/hls/{login}/{name}")
        async def hls(login: str, name: str):
            f = mock.dir / "hls" / login / name
            if not f.exists():
                return PlainTextResponse("nicht gefunden", status_code=404)
            media = "application/vnd.apple.mpegurl" if name.endswith(".m3u8") else "video/mp2t"
            return FileResponse(f, media_type=media, headers={"Cache-Control": "no-cache"})

        @app.websocket("/irc")
        async def irc(ws: WebSocket):
            await ws.accept()
            q: asyncio.Queue = asyncio.Queue()
            joined: set[str] = set()
            entry = (q, joined)
            mock.irc_clients.append(entry)

            async def sender() -> None:
                while True:
                    line = await q.get()
                    await ws.send_text(line + "\r\n")

            task = asyncio.create_task(sender())
            try:
                while True:
                    data = await ws.receive_text()
                    for line in data.split("\r\n"):
                        if line.startswith("NICK"):
                            nick = line.split()[1]
                            await q.put(f":tmi.twitch.tv 001 {nick} :Welcome, GLHF!")
                        elif line.startswith("JOIN"):
                            joined.add(line.split()[1].lstrip("#").lower())
                        elif line.startswith("CAP REQ"):
                            await q.put(":tmi.twitch.tv CAP * ACK :twitch.tv/tags twitch.tv/commands")
            except WebSocketDisconnect:
                pass
            finally:
                task.cancel()
                mock.irc_clients.remove(entry)

        return app

    def start(self) -> "MockTwitch":
        config = uvicorn.Config(self.app, host="127.0.0.1", port=self.port, log_level="warning", lifespan="on")
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.5):
                    break
            except OSError:
                time.sleep(0.1)
        while self.loop is None and time.time() < deadline:
            time.sleep(0.05)
        return self

    def stop(self) -> None:
        for login in list(self.gen):
            self._stop_hls(login, end=True)
        if self.server:
            self.server.should_exit = True
        if self.thread:
            self.thread.join(timeout=5)
        shutil.rmtree(self.dir, ignore_errors=True)


def main() -> None:
    ap = argparse.ArgumentParser(description="Mock-Twitch-Server (Demo)")
    ap.add_argument("--port", type=int, default=9999)
    ap.add_argument("--login", default="teststreamer")
    args = ap.parse_args()
    m = MockTwitch(port=args.port).start()
    m.add_user(args.login)
    print("Umgebungsvariablen für die Clip-Fabrik:")
    for k, v in m.env().items():
        print(f"  {k}={v}")
    print(f"\nTasten: [l] live an/aus, [c] Chat-Spitze, [k] !clip als Mod, [q] Ende (Kanal: {args.login})")
    live = False
    try:
        while True:
            cmd = input("> ").strip().lower()
            if cmd == "l":
                live = not live
                m.set_live(args.login, live)
                print("live" if live else "offline")
            elif cmd == "c":
                for i in range(30):
                    m.say(args.login, f"zuschauer{i}", "KEKW KEKW OMEGALUL")
                    time.sleep(0.1)
            elif cmd == "k":
                m.say(args.login, "ModMaus", "!clip", mod=True)
            elif cmd == "q":
                break
    finally:
        m.stop()


if __name__ == "__main__":
    main()
