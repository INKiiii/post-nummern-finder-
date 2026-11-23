"""TikTok Content Posting API (offiziell).

* Direkt posten: ``/v2/post/publish/video/init/`` (Scope ``video.publish``). Ohne Audit der App sind nur
  private Posts (SELF_ONLY) erlaubt – die App setzt das automatisch und sagt es dir.
* Entwurf: ``/v2/post/publish/inbox/video/init/`` (Scope ``video.upload``) – landet in der TikTok-Inbox,
  du veröffentlichst in der TikTok-App selbst. Regelkonformer Weg, solange das Audit fehlt.
* Upload per FILE_UPLOAD in Chunks, Status über ``/v2/post/publish/status/fetch/``.
"""

from __future__ import annotations

import datetime as dt
import math
import time
from typing import Any
from urllib.parse import urlencode

import httpx

from .. import settings_store
from ..config import get_settings
from .base import AccountIdentity, PlatformAdapter, PublishError, PublishResult, QuotaRule, TokenBundle, UploadRequest

AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/"
SCOPES = ["user.info.basic", "video.upload", "video.publish", "video.list"]
CHUNK = 10 * 1024 * 1024


class TikTokAdapter(PlatformAdapter):
    platform = "tiktok"
    label = "TikTok"

    def __init__(self, http: httpx.Client | None = None) -> None:
        s = get_settings()
        self.key = s.tiktok_client_key
        self.secret = settings_store.get("tiktok_client_secret") or s.tiktok_client_secret
        self.base = s.tiktok_api_base.rstrip("/")
        self.http = http or httpx.Client(timeout=60)

    def configured(self) -> bool:
        return bool(self.key and self.secret)

    def authorize_url(self, redirect_uri: str, state: str) -> str:
        return AUTH_URL + "?" + urlencode({"client_key": self.key, "scope": ",".join(SCOPES), "response_type": "code",
                                           "redirect_uri": redirect_uri, "state": state})

    def _token_req(self, data: dict) -> TokenBundle:
        r = self.http.post(f"{self.base}/v2/oauth/token/", data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
        d = r.json() if r.content else {}
        if r.status_code != 200 or "access_token" not in d:
            raise PublishError(f"TikTok-Login fehlgeschlagen: {d.get('error_description') or d.get('error') or r.status_code}",
                               retry=False, auth=True)
        return TokenBundle(d["access_token"], d.get("refresh_token"),
                           dt.datetime.utcnow() + dt.timedelta(seconds=int(d.get("expires_in", 86400))),
                           d.get("scope", "").split(","), {"open_id": d.get("open_id")})

    def exchange_code(self, code: str, redirect_uri: str, **kw: Any) -> TokenBundle:
        return self._token_req({"client_key": self.key, "client_secret": self.secret, "code": code,
                                "grant_type": "authorization_code", "redirect_uri": redirect_uri})

    def refresh(self, tokens: TokenBundle) -> TokenBundle:
        if not tokens.refresh_token:
            raise PublishError("TikTok-Token abgelaufen, bitte neu verbinden", retry=False, auth=True)
        new = self._token_req({"client_key": self.key, "client_secret": self.secret, "grant_type": "refresh_token",
                               "refresh_token": tokens.refresh_token})
        new.extra = {**tokens.extra, **new.extra}
        return new

    def _h(self, tokens: TokenBundle) -> dict:
        return {"Authorization": f"Bearer {tokens.access_token}", "Content-Type": "application/json; charset=UTF-8"}

    def _check(self, r: httpx.Response, what: str) -> dict:
        try:
            d = r.json()
        except ValueError:
            d = {}
        err = (d.get("error") or {})
        code = err.get("code", "ok")
        if r.status_code >= 400 or code not in ("ok", ""):
            msg = err.get("message") or r.text[:200]
            auth = code in ("access_token_invalid", "scope_not_authorized") or r.status_code == 401
            retry = code in ("rate_limit_exceeded", "internal_error") or r.status_code >= 500
            hint = {
                "spam_risk_too_many_posts": "Tageslimit von TikTok erreicht",
                "unaudited_client_can_only_post_to_private_accounts": "App nicht auditiert: nur private Posts möglich",
                "scope_not_authorized": "Berechtigung fehlt – Konto neu verbinden",
                "url_ownership_unverified": "Domain nicht verifiziert",
            }.get(code, "")
            raise PublishError(f"TikTok {what}: {hint or msg} ({code})", retry=retry, auth=auth)
        return d.get("data", {})

    def identity(self, tokens: TokenBundle) -> AccountIdentity:
        r = self.http.get(f"{self.base}/v2/user/info/", params={"fields": "open_id,display_name,avatar_url"}, headers=self._h(tokens))
        u = self._check(r, "Profil").get("user", {})
        return AccountIdentity(u.get("open_id") or tokens.extra.get("open_id", ""), u.get("display_name", "TikTok"), {"avatar": u.get("avatar_url")})

    def creator_info(self, tokens: TokenBundle) -> dict:
        r = self.http.post(f"{self.base}/v2/post/publish/creator_info/query/", headers=self._h(tokens))
        return self._check(r, "Creator-Info")

    def upload(self, tokens: TokenBundle, account_meta: dict, req: UploadRequest) -> PublishResult:
        size = req.video.stat().st_size
        chunk = size if size <= CHUNK else CHUNK
        count = max(1, math.floor(size / chunk))
        source = {"source": "FILE_UPLOAD", "video_size": size, "chunk_size": chunk, "total_chunk_count": count}
        caption = (req.description + " " + " ".join(req.hashtags)).strip()[:2200]
        if req.draft:
            r = self.http.post(f"{self.base}/v2/post/publish/inbox/video/init/", headers=self._h(tokens), json={"source_info": source})
        else:
            info = self.creator_info(tokens)
            options = info.get("privacy_level_options") or ["SELF_ONLY"]
            privacy = req.privacy if req.privacy in options else ("PUBLIC_TO_EVERYONE" if "PUBLIC_TO_EVERYONE" in options and account_meta.get("api_approved") else "SELF_ONLY")
            if privacy not in options:
                privacy = options[0]
            r = self.http.post(f"{self.base}/v2/post/publish/video/init/", headers=self._h(tokens), json={
                "post_info": {"title": caption, "privacy_level": privacy, "disable_duet": False, "disable_comment": False,
                              "disable_stitch": False, "video_cover_timestamp_ms": 1000},
                "source_info": source})
        data = self._check(r, "Upload-Start")
        publish_id, upload_url = data["publish_id"], data["upload_url"]
        with open(req.video, "rb") as f:
            for i in range(count):
                start = i * chunk
                end = size - 1 if i == count - 1 else start + chunk - 1
                f.seek(start)
                body = f.read(end - start + 1)
                ur = self.http.put(upload_url, content=body, headers={
                    "Content-Type": "video/mp4", "Content-Length": str(len(body)), "Content-Range": f"bytes {start}-{end}/{size}"})
                if ur.status_code not in (200, 201, 206):
                    raise PublishError(f"TikTok Upload-Chunk {i + 1}/{count} fehlgeschlagen ({ur.status_code})")
        res = self.check_status(tokens, account_meta, publish_id)
        note = "Als Entwurf in deiner TikTok-Inbox – in der App veröffentlichen" if req.draft else ""
        if res and res.status == "live":
            res.note = note
            return res
        return PublishResult(publish_id, None, "processing", note)

    def check_status(self, tokens: TokenBundle, account_meta: dict, external_id: str) -> PublishResult | None:
        for _ in range(3):
            r = self.http.post(f"{self.base}/v2/post/publish/status/fetch/", headers=self._h(tokens), json={"publish_id": external_id})
            d = self._check(r, "Status")
            st = d.get("status", "")
            if st == "FAILED":
                raise PublishError(f"TikTok-Verarbeitung fehlgeschlagen: {d.get('fail_reason', 'unbekannt')}", retry=False)
            if st in ("PUBLISH_COMPLETE", "SEND_TO_USER_INBOX"):
                ids = d.get("publicaly_available_post_id") or d.get("publicly_available_post_id") or []
                vid = str(ids[0]) if ids else external_id
                return PublishResult(vid, f"https://www.tiktok.com/video/{vid}" if ids else None, "live")
            time.sleep(1.5)
        return PublishResult(external_id, None, "processing")

    def fetch_metrics(self, tokens: TokenBundle, account_meta: dict, external_ids: list[str]) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for i in range(0, len(external_ids), 20):
            r = self.http.post(f"{self.base}/v2/video/query/", params={"fields": "id,view_count,like_count,comment_count,share_count"},
                               headers=self._h(tokens), json={"filters": {"video_ids": external_ids[i:i + 20]}})
            for v in self._check(r, "Metriken").get("videos", []):
                out[str(v["id"])] = {"views": v.get("view_count", 0), "likes": v.get("like_count", 0),
                                     "comments": v.get("comment_count", 0), "shares": v.get("share_count", 0)}
        return out

    def quota_rule(self, account_meta: dict) -> QuotaRule:
        lim = int(settings_store.get("tiktok_daily_limit") or 15)
        note = "" if account_meta.get("api_approved") else "App ohne Audit: Posts nur privat, oder als Entwurf in die Inbox"
        return QuotaRule(daily_uploads=lim, note=note)

    def approval_hint(self) -> str:
        return "Für öffentliche Posts braucht die TikTok-App ein Audit (Content Posting API). Bis dahin: Entwurf-Modus oder Export."
