"""Twitch Helix API + OAuth (nur offizielle Endpunkte, kein Scraping).

* App-Token (Client Credentials) für Live-Status und EventSub-Webhooks.
* User-Token meines Mod-Kontos für Chat (IRC) und „Create Clip“. Keine Broadcaster-Rechte nötig.
"""

from __future__ import annotations

import datetime as dt
import logging
import time
from typing import Any
from urllib.parse import urlencode

import httpx
from sqlalchemy import select

from .. import crypto, settings_store
from ..config import get_settings
from ..db import TwitchAccount, session_scope, utcnow

log = logging.getLogger(__name__)

# So wenig Rechte wie möglich: Chat lesen, Clips erstellen (Marker im Live-Modus)
MOD_SCOPES = ["chat:read", "clips:edit"]
STREAMER_SCOPES: list[str] = []  # nur Identität: bestätigt, dass der Streamer selbst zustimmt


class TwitchError(RuntimeError):
    def __init__(self, msg: str, status: int | None = None) -> None:
        super().__init__(msg)
        self.status = status


class Helix:
    def __init__(self, http: httpx.Client | None = None) -> None:
        s = get_settings()
        self.client_id = settings_store.get("twitch_client_id") or s.twitch_client_id
        self.client_secret = settings_store.get("twitch_client_secret") or s.twitch_client_secret
        self.api = s.twitch_api_base.rstrip("/")
        self.auth = s.twitch_auth_base.rstrip("/")
        self.http = http or httpx.Client(timeout=20)

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.client_secret)

    # ---------------- Tokens
    def app_token(self, force: bool = False) -> str:
        cached = settings_store.get("twitch_app_token")
        if cached and not force and cached.get("expires", 0) > time.time() + 300:
            return crypto.decrypt(cached["token"])
        if not self.configured:
            raise TwitchError("Twitch Client-ID/Secret fehlen (Settings → Twitch)")
        r = self.http.post(f"{self.auth}/token", data={
            "client_id": self.client_id, "client_secret": self.client_secret, "grant_type": "client_credentials"})
        if r.status_code != 200:
            raise TwitchError(f"App-Token fehlgeschlagen: {r.status_code} {r.text[:200]}", r.status_code)
        d = r.json()
        settings_store.set_value("twitch_app_token", {"token": crypto.encrypt(d["access_token"]),
                                                      "expires": time.time() + int(d.get("expires_in", 3600))})
        return d["access_token"]

    def authorize_url(self, redirect_uri: str, scopes: list[str], state: str, *, force_verify: bool = True) -> str:
        q = {"client_id": self.client_id, "redirect_uri": redirect_uri, "response_type": "code",
             "scope": " ".join(scopes), "state": state}
        if force_verify:
            q["force_verify"] = "true"
        return f"{self.auth}/authorize?{urlencode(q)}"

    def exchange_code(self, code: str, redirect_uri: str) -> dict:
        r = self.http.post(f"{self.auth}/token", data={
            "client_id": self.client_id, "client_secret": self.client_secret, "code": code,
            "grant_type": "authorization_code", "redirect_uri": redirect_uri})
        if r.status_code != 200:
            raise TwitchError(f"Twitch-Login fehlgeschlagen: {r.text[:200]}", r.status_code)
        return r.json()

    def refresh(self, refresh_token: str) -> dict:
        r = self.http.post(f"{self.auth}/token", data={
            "client_id": self.client_id, "client_secret": self.client_secret, "grant_type": "refresh_token",
            "refresh_token": refresh_token})
        if r.status_code != 200:
            raise TwitchError("Twitch-Token abgelaufen, bitte neu einloggen", r.status_code)
        return r.json()

    def validate(self, token: str) -> dict:
        r = self.http.get(f"{self.auth}/validate", headers={"Authorization": f"OAuth {token}"})
        if r.status_code != 200:
            raise TwitchError("Token ungültig", r.status_code)
        return r.json()

    def user_token(self, role: str = "mod") -> tuple[str, TwitchAccount] | None:
        """Gültiges User-Token (wird bei Bedarf erneuert)."""
        with session_scope() as s:
            acc = s.scalar(select(TwitchAccount).where(TwitchAccount.role == role).order_by(TwitchAccount.id.desc()))
            if acc is None or not acc.tokens_enc:
                return None
            tokens = crypto.decrypt_json(acc.tokens_enc)
            if acc.expires_at and acc.expires_at < utcnow() + dt.timedelta(minutes=5) and tokens.get("refresh_token"):
                new = self.refresh(tokens["refresh_token"])
                tokens = {"access_token": new["access_token"], "refresh_token": new.get("refresh_token", tokens["refresh_token"])}
                acc.tokens_enc = crypto.encrypt_json(tokens)
                acc.expires_at = utcnow() + dt.timedelta(seconds=int(new.get("expires_in", 14000)))
            s.expunge(acc)
            return tokens["access_token"], acc

    # ---------------- API
    def _req(self, method: str, path: str, *, token: str | None = None, params: Any = None, json: Any = None,
             retry_auth: bool = True) -> httpx.Response:
        tok = token or self.app_token()
        r = self.http.request(method, f"{self.api}{path}", params=params, json=json,
                              headers={"Client-Id": self.client_id or "", "Authorization": f"Bearer {tok}"})
        if r.status_code == 401 and retry_auth and token is None:
            self.app_token(force=True)
            return self._req(method, path, params=params, json=json, retry_auth=False)
        if r.status_code == 429:
            reset = float(r.headers.get("Ratelimit-Reset", time.time() + 2))
            time.sleep(min(10.0, max(0.5, reset - time.time())))
            return self.http.request(method, f"{self.api}{path}", params=params, json=json,
                                     headers={"Client-Id": self.client_id or "", "Authorization": f"Bearer {tok}"})
        return r

    def get_users(self, logins: list[str]) -> list[dict]:
        if not logins:
            return []
        r = self._req("GET", "/users", params=[("login", login.lower()) for login in logins[:100]])
        if r.status_code != 200:
            raise TwitchError(f"Users-Abfrage fehlgeschlagen: {r.status_code}", r.status_code)
        return r.json().get("data", [])

    def get_streams(self, logins: list[str]) -> dict[str, dict]:
        """Live-Streams nach Login (kleingeschrieben). Nicht enthaltene Logins sind offline."""
        out: dict[str, dict] = {}
        for i in range(0, len(logins), 100):
            chunk = logins[i:i + 100]
            r = self._req("GET", "/streams", params=[("user_login", login.lower()) for login in chunk] + [("type", "live")])
            if r.status_code != 200:
                raise TwitchError(f"Streams-Abfrage fehlgeschlagen: {r.status_code} {r.text[:200]}", r.status_code)
            for st in r.json().get("data", []):
                out[st["user_login"].lower()] = st
        return out

    def create_clip(self, broadcaster_id: str, user_token: str) -> dict:
        """Twitch-Clip als Marker/Sicherheitskopie. Braucht clips:edit (als Mod möglich, wenn Clips erlaubt sind)."""
        r = self._req("POST", "/clips", token=user_token, params={"broadcaster_id": broadcaster_id})
        if r.status_code not in (200, 202):
            raise TwitchError(f"Clip erstellen fehlgeschlagen ({r.status_code}): {r.text[:200]}", r.status_code)
        data = r.json().get("data", [{}])[0]
        return {"id": data.get("id"), "edit_url": data.get("edit_url")}

    def get_latest_vod(self, user_id: str) -> dict | None:
        r = self._req("GET", "/videos", params={"user_id": user_id, "type": "archive", "first": 1})
        if r.status_code != 200:
            return None
        items = r.json().get("data", [])
        return items[0] if items else None

    # ---------------- EventSub (Webhook)
    def eventsub_subscribe(self, sub_type: str, broadcaster_id: str, callback: str, secret: str) -> str:
        r = self._req("POST", "/eventsub/subscriptions", json={
            "type": sub_type, "version": "1", "condition": {"broadcaster_user_id": broadcaster_id},
            "transport": {"method": "webhook", "callback": callback, "secret": secret}})
        if r.status_code == 409:
            return "exists"
        if r.status_code not in (200, 202):
            raise TwitchError(f"EventSub {sub_type} fehlgeschlagen: {r.status_code} {r.text[:200]}", r.status_code)
        return r.json()["data"][0]["id"]

    def eventsub_list(self) -> list[dict]:
        r = self._req("GET", "/eventsub/subscriptions")
        return r.json().get("data", []) if r.status_code == 200 else []

    def eventsub_delete(self, sub_id: str) -> None:
        self._req("DELETE", "/eventsub/subscriptions", params={"id": sub_id})


def store_user_tokens(tokens: dict, info: dict, role: str) -> int:
    with session_scope() as s:
        acc = s.scalar(select(TwitchAccount).where(TwitchAccount.role == role, TwitchAccount.twitch_user_id == info["user_id"]))
        if acc is None:
            acc = TwitchAccount(role=role, twitch_user_id=info["user_id"], login=info.get("login", ""))
            s.add(acc)
        acc.login = info.get("login", acc.login)
        acc.display_name = info.get("login", acc.login)
        acc.scopes = info.get("scopes", [])
        acc.tokens_enc = crypto.encrypt_json({"access_token": tokens["access_token"], "refresh_token": tokens.get("refresh_token")})
        acc.expires_at = utcnow() + dt.timedelta(seconds=int(tokens.get("expires_in", 14000)))
        s.flush()
        return acc.id
