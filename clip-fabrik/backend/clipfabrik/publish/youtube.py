"""YouTube Shorts über die YouTube Data API v3 (resumable Upload, offiziell).

Shorts = hochkant, ≤ 3 min; „#Shorts“ in Titel/Beschreibung hilft der Einordnung.
Kontingent: 10.000 Einheiten/Tag (Standard), ein Upload kostet laut Doku 1.600 Einheiten
(einstellbar, falls Google das ändert) -> ohne Erweiterung ~6 Uploads/Tag.
"""

from __future__ import annotations

import datetime as dt
import json
from typing import Any
from urllib.parse import urlencode

import httpx

from .. import settings_store
from ..config import get_settings
from .base import AccountIdentity, PlatformAdapter, PublishError, PublishResult, QuotaRule, TokenBundle, UploadRequest

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"]


class YouTubeAdapter(PlatformAdapter):
    platform = "youtube"
    label = "YouTube Shorts"

    def __init__(self, http: httpx.Client | None = None) -> None:
        s = get_settings()
        self.cid = s.google_client_id
        self.secret = settings_store.get("google_client_secret") or s.google_client_secret
        self.base = s.youtube_api_base.rstrip("/")
        self.http = http or httpx.Client(timeout=120)

    def configured(self) -> bool:
        return bool(self.cid and self.secret)

    def authorize_url(self, redirect_uri: str, state: str) -> str:
        return AUTH_URL + "?" + urlencode({"client_id": self.cid, "redirect_uri": redirect_uri, "response_type": "code",
                                           "scope": " ".join(SCOPES), "access_type": "offline", "prompt": "consent",
                                           "include_granted_scopes": "true", "state": state})

    def _err(self, r: httpx.Response, what: str) -> PublishError:
        try:
            e = r.json().get("error", {})
        except ValueError:
            e = {}
        reason = ((e.get("errors") or [{}])[0]).get("reason", "") if isinstance(e, dict) else ""
        msg = e.get("message", r.text[:200]) if isinstance(e, dict) else str(e)
        if reason in ("quotaExceeded", "dailyLimitExceeded"):
            return PublishError("YouTube: Kontingent für heute aufgebraucht (morgen geht es weiter oder Erweiterung beantragen)", retry=True)
        if reason == "uploadLimitExceeded":
            return PublishError("YouTube-Upload-Limit des Kanals erreicht", retry=True)
        return PublishError(f"YouTube {what}: {msg}", retry=r.status_code >= 500, auth=r.status_code == 401)

    def _token(self, data: dict) -> dict:
        r = self.http.post(TOKEN_URL, data=data)
        if r.status_code != 200:
            raise PublishError(f"Google-Login fehlgeschlagen: {r.text[:200]}", retry=False, auth=True)
        return r.json()

    def exchange_code(self, code: str, redirect_uri: str, **kw: Any) -> TokenBundle:
        d = self._token({"client_id": self.cid, "client_secret": self.secret, "code": code, "grant_type": "authorization_code",
                         "redirect_uri": redirect_uri})
        return TokenBundle(d["access_token"], d.get("refresh_token"), dt.datetime.utcnow() + dt.timedelta(seconds=int(d.get("expires_in", 3600))),
                           d.get("scope", "").split())

    def refresh(self, tokens: TokenBundle) -> TokenBundle:
        if not tokens.refresh_token:
            raise PublishError("Google-Token abgelaufen, bitte neu verbinden", retry=False, auth=True)
        d = self._token({"client_id": self.cid, "client_secret": self.secret, "grant_type": "refresh_token",
                         "refresh_token": tokens.refresh_token})
        return TokenBundle(d["access_token"], tokens.refresh_token, dt.datetime.utcnow() + dt.timedelta(seconds=int(d.get("expires_in", 3600))),
                           tokens.scopes, tokens.extra)

    def _h(self, tokens: TokenBundle) -> dict:
        return {"Authorization": f"Bearer {tokens.access_token}"}

    def identity(self, tokens: TokenBundle) -> AccountIdentity:
        r = self.http.get(f"{self.base}/youtube/v3/channels", params={"part": "snippet", "mine": "true"}, headers=self._h(tokens))
        if r.status_code != 200:
            raise self._err(r, "Kanal")
        items = r.json().get("items", [])
        if not items:
            raise PublishError("Dieses Google-Konto hat keinen YouTube-Kanal", retry=False)
        return AccountIdentity(items[0]["id"], items[0]["snippet"]["title"], {})

    def upload(self, tokens: TokenBundle, account_meta: dict, req: UploadRequest) -> PublishResult:
        title = req.title if "#shorts" in (req.title + req.description).lower() else req.title
        body = {
            "snippet": {"title": title[:100], "description": req.description[:5000], "tags": req.tags[:15], "categoryId": "20",
                        "defaultLanguage": "de", "defaultAudioLanguage": "de"},
            "status": {"privacyStatus": req.privacy or "public", "selfDeclaredMadeForKids": False, "embeddable": True},
        }
        size = req.video.stat().st_size
        init = self.http.post(f"{self.base}/upload/youtube/v3/videos", params={"uploadType": "resumable", "part": "snippet,status"},
                              headers={**self._h(tokens), "Content-Type": "application/json; charset=UTF-8",
                                       "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": str(size)},
                              content=json.dumps(body))
        if init.status_code != 200 or "location" not in {k.lower() for k in init.headers}:
            raise self._err(init, "Upload-Start")
        loc = init.headers["Location"]
        with open(req.video, "rb") as f:
            up = self.http.put(loc, content=f.read(), headers={**self._h(tokens), "Content-Type": "video/mp4", "Content-Length": str(size)})
        if up.status_code not in (200, 201):
            raise self._err(up, "Upload")
        vid = up.json()["id"]
        return PublishResult(vid, f"https://youtube.com/shorts/{vid}", "live")

    def fetch_metrics(self, tokens: TokenBundle, account_meta: dict, external_ids: list[str]) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for i in range(0, len(external_ids), 50):
            r = self.http.get(f"{self.base}/youtube/v3/videos", params={"part": "statistics", "id": ",".join(external_ids[i:i + 50])},
                              headers=self._h(tokens))
            if r.status_code != 200:
                raise self._err(r, "Statistiken")
            for it in r.json().get("items", []):
                st = it.get("statistics", {})
                out[it["id"]] = {"views": int(st.get("viewCount", 0)), "likes": int(st.get("likeCount", 0)),
                                 "comments": int(st.get("commentCount", 0))}
        return out

    def quota_rule(self, account_meta: dict) -> QuotaRule:
        units = int(settings_store.get("youtube_daily_units") or 10000)
        cost = int(settings_store.get("youtube_upload_cost") or 1600)
        return QuotaRule(daily_units=units, units_per_upload=cost,
                         note=f"{units // cost} Uploads/Tag mit {units:,} Einheiten".replace(",", "."))

    def approval_hint(self) -> str:
        return "Google-Cloud-Projekt mit YouTube Data API v3, OAuth-Zustimmungsbildschirm verifizieren; für mehr Uploads Kontingent-Erweiterung beantragen."
