"""Instagram Reels über die Instagram API mit Instagram-Login (offiziell, Business-/Creator-Konto nötig).

Ablauf: Container anlegen (media_type=REELS, upload_type=resumable) -> Datei an rupload senden ->
Status abfragen bis FINISHED -> media_publish. Limit: 50 API-Posts pro 24 h (content_publishing_limit).
"""

from __future__ import annotations

import datetime as dt
import time
from typing import Any
from urllib.parse import urlencode

import httpx

from .. import settings_store
from ..config import get_settings
from .base import AccountIdentity, PlatformAdapter, PublishError, PublishResult, QuotaRule, TokenBundle, UploadRequest

AUTH_URL = "https://www.instagram.com/oauth/authorize"
TOKEN_URL = "https://api.instagram.com/oauth/access_token"
SCOPES = ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_insights"]


class InstagramAdapter(PlatformAdapter):
    platform = "instagram"
    label = "Instagram Reels"

    def __init__(self, http: httpx.Client | None = None) -> None:
        s = get_settings()
        self.app_id = s.meta_app_id
        self.secret = settings_store.get("meta_app_secret") or s.meta_app_secret
        self.graph = s.instagram_graph_base.rstrip("/")
        self.upload_base = s.instagram_upload_base.rstrip("/")
        self.ver = s.instagram_api_version
        self.http = http or httpx.Client(timeout=120)

    def configured(self) -> bool:
        return bool(self.app_id and self.secret)

    def authorize_url(self, redirect_uri: str, state: str) -> str:
        return AUTH_URL + "?" + urlencode({"client_id": self.app_id, "redirect_uri": redirect_uri, "response_type": "code",
                                           "scope": ",".join(SCOPES), "state": state})

    def _err(self, r: httpx.Response, what: str) -> PublishError:
        try:
            e = r.json().get("error", {})
        except ValueError:
            e = {}
        code = e.get("code")
        msg = e.get("error_user_msg") or e.get("message") or r.text[:200]
        auth = code in (190, 102) or r.status_code == 401
        retry = r.status_code >= 500 or code in (4, 17, 32, 613, 2)
        if code == 9 or "limit" in str(msg).lower():
            msg = f"Veröffentlichungslimit erreicht ({msg})"
        return PublishError(f"Instagram {what}: {msg}", retry=retry, auth=auth)

    def exchange_code(self, code: str, redirect_uri: str, **kw: Any) -> TokenBundle:
        r = self.http.post(TOKEN_URL, data={"client_id": self.app_id, "client_secret": self.secret, "grant_type": "authorization_code",
                                            "redirect_uri": redirect_uri, "code": code})
        if r.status_code != 200:
            raise self._err(r, "Login")
        short = r.json()
        # gegen langlebiges Token (60 Tage) tauschen
        r2 = self.http.get(f"{self.graph}/access_token", params={"grant_type": "ig_exchange_token", "client_secret": self.secret,
                                                                  "access_token": short["access_token"]})
        if r2.status_code != 200:
            raise self._err(r2, "Token-Tausch")
        d = r2.json()
        return TokenBundle(d["access_token"], None, dt.datetime.utcnow() + dt.timedelta(seconds=int(d.get("expires_in", 5184000))),
                           SCOPES, {"user_id": str(short.get("user_id", ""))})

    def refresh(self, tokens: TokenBundle) -> TokenBundle:
        r = self.http.get(f"{self.graph}/refresh_access_token", params={"grant_type": "ig_refresh_token", "access_token": tokens.access_token})
        if r.status_code != 200:
            raise self._err(r, "Token-Erneuerung")
        d = r.json()
        return TokenBundle(d["access_token"], None, dt.datetime.utcnow() + dt.timedelta(seconds=int(d.get("expires_in", 5184000))),
                           tokens.scopes, tokens.extra)

    def identity(self, tokens: TokenBundle) -> AccountIdentity:
        r = self.http.get(f"{self.graph}/{self.ver}/me", params={"fields": "user_id,username,account_type", "access_token": tokens.access_token})
        if r.status_code != 200:
            raise self._err(r, "Profil")
        d = r.json()
        if d.get("account_type") not in (None, "BUSINESS", "MEDIA_CREATOR", "CREATOR"):
            raise PublishError("Instagram-Konto muss ein Business- oder Creator-Konto sein", retry=False)
        return AccountIdentity(str(d.get("user_id") or d.get("id")), "@" + d.get("username", "instagram"), {"account_type": d.get("account_type")})

    def upload(self, tokens: TokenBundle, account_meta: dict, req: UploadRequest) -> PublishResult:
        uid = account_meta.get("external_id") or tokens.extra.get("user_id")
        caption = (req.description + "\n\n" + " ".join(req.hashtags)).strip()[:2200]
        r = self.http.post(f"{self.graph}/{self.ver}/{uid}/media", params={"access_token": tokens.access_token},
                           data={"media_type": "REELS", "upload_type": "resumable", "caption": caption, "share_to_feed": "true"})
        if r.status_code != 200:
            raise self._err(r, "Container")
        container = r.json()["id"]
        size = req.video.stat().st_size
        with open(req.video, "rb") as f:
            ur = self.http.post(f"{self.upload_base}/ig-api-upload/{self.ver}/{container}", content=f.read(), headers={
                "Authorization": f"OAuth {tokens.access_token}", "offset": "0", "file_size": str(size)})
        if ur.status_code != 200:
            raise self._err(ur, "Upload")
        deadline = time.time() + 300
        while time.time() < deadline:
            sr = self.http.get(f"{self.graph}/{self.ver}/{container}", params={"fields": "status_code,status", "access_token": tokens.access_token})
            if sr.status_code != 200:
                raise self._err(sr, "Status")
            st = sr.json().get("status_code")
            if st == "FINISHED":
                break
            if st in ("ERROR", "EXPIRED"):
                raise PublishError(f"Instagram-Verarbeitung: {sr.json().get('status', st)}", retry=False)
            time.sleep(3)
        else:
            return PublishResult(container, None, "processing", "Instagram verarbeitet noch")
        pr = self.http.post(f"{self.graph}/{self.ver}/{uid}/media_publish", params={"access_token": tokens.access_token},
                            data={"creation_id": container})
        if pr.status_code != 200:
            raise self._err(pr, "Veröffentlichen")
        media_id = pr.json()["id"]
        lr = self.http.get(f"{self.graph}/{self.ver}/{media_id}", params={"fields": "permalink", "access_token": tokens.access_token})
        link = lr.json().get("permalink") if lr.status_code == 200 else None
        return PublishResult(media_id, link, "live")

    def fetch_metrics(self, tokens: TokenBundle, account_meta: dict, external_ids: list[str]) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for mid in external_ids:
            r = self.http.get(f"{self.graph}/{self.ver}/{mid}/insights", params={
                "metric": "views,likes,comments,shares,saved,ig_reels_avg_watch_time", "access_token": tokens.access_token})
            if r.status_code != 200:
                continue
            m = {x["name"]: (x.get("values") or [{}])[0].get("value", 0) for x in r.json().get("data", [])}
            out[mid] = {"views": m.get("views", 0), "likes": m.get("likes", 0), "comments": m.get("comments", 0),
                        "shares": m.get("shares", 0), "saves": m.get("saved", 0), "avg_watch_ms": m.get("ig_reels_avg_watch_time", 0)}
        return out

    def publishing_limit(self, tokens: TokenBundle, uid: str) -> dict | None:
        r = self.http.get(f"{self.graph}/{self.ver}/{uid}/content_publishing_limit", params={
            "fields": "quota_usage,config", "access_token": tokens.access_token})
        if r.status_code != 200:
            return None
        data = (r.json().get("data") or [{}])[0]
        return {"used": data.get("quota_usage", 0), "total": (data.get("config") or {}).get("quota_total", 50)}

    def quota_rule(self, account_meta: dict) -> QuotaRule:
        return QuotaRule(daily_uploads=int(settings_store.get("instagram_daily_limit") or 50),
                         note="" if account_meta.get("api_approved") else "Meta-App-Prüfung nötig, solange nur Test-Nutzer")

    def approval_hint(self) -> str:
        return "Meta-App mit Instagram-API (Instagram-Login), Business-/Creator-Konto, App-Prüfung für instagram_business_content_publish."
