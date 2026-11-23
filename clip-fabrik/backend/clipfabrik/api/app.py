"""FastAPI-App: API-Router + ausgeliefertes Frontend (PWA) mit SPA-Fallback."""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .. import auth
from ..config import get_settings
from ..db import init_engine
from ..logging_setup import register_secret, setup_logging
from . import routes_clips, routes_core, routes_publish, routes_system

log = logging.getLogger(__name__)


def _frontend_dir() -> Path | None:
    s = get_settings()
    candidates = [s.frontend_dist] if s.frontend_dist else []
    here = Path(__file__).resolve()
    candidates += [here.parents[3] / "frontend" / "dist", Path("/app/frontend/dist")]
    for c in candidates:
        if c and (c / "index.html").exists():
            return c
    return None


def create_app() -> FastAPI:
    settings = get_settings()
    setup_logging(settings.log_level)
    for secret in (settings.secret_key, settings.anthropic_api_key, settings.twitch_client_secret, settings.admin_password,
                   settings.tiktok_client_secret, settings.meta_app_secret, settings.google_client_secret, settings.telegram_bot_token):
        register_secret(secret)
    init_engine()
    auth.ensure_admin_password()

    app = FastAPI(title="Clip-Fabrik", version="0.1.0", docs_url="/api/docs", openapi_url="/api/openapi.json")

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_req: Request, exc: RequestValidationError):
        msgs = []
        for e in exc.errors():
            loc = ".".join(str(x) for x in e.get("loc", []) if x != "body")
            msgs.append(f"{loc}: {e.get('msg')}")
        return JSONResponse({"detail": "Ungültige Eingabe – " + "; ".join(msgs)}, status_code=422)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault("X-Frame-Options", "DENY")
        return response

    for r in (routes_core.router, routes_core.protected, routes_clips.router, routes_publish.public, routes_publish.router,
              routes_system.router):
        app.include_router(r)

    dist = _frontend_dir()
    if dist is not None:
        index = dist / "index.html"

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str):
            if path.startswith("api/"):
                raise StarletteHTTPException(404, "Nicht gefunden")
            f = (dist / path).resolve()
            if path and f.is_file() and dist in f.parents:
                headers = {}
                if f.name in ("sw.js", "manifest.webmanifest", "index.html"):
                    headers["Cache-Control"] = "no-cache"
                elif "/assets/" in f.as_posix():
                    headers["Cache-Control"] = "public, max-age=31536000, immutable"
                return FileResponse(f, headers=headers)
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
    else:
        log.warning("Frontend-Build nicht gefunden (frontend/dist) – nur API verfügbar")

    return app
