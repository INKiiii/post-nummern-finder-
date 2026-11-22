"""Mock-Adapter für Tests und Demo: „veröffentlicht“ in einen lokalen Ordner."""

from __future__ import annotations

import hashlib
import json
import shutil
from typing import Any

from ..config import get_settings
from .base import AccountIdentity, PlatformAdapter, PublishError, PublishResult, QuotaRule, TokenBundle, UploadRequest


class MockAdapter(PlatformAdapter):
    platform = "mock"
    label = "Test-Plattform"
    fail_next: int = 0  # für Tests: so viele Uploads schlagen fehl

    def configured(self) -> bool:
        return True

    def authorize_url(self, redirect_uri: str, state: str) -> str:
        return f"{redirect_uri}?code=mockcode&state={state}"

    def exchange_code(self, code: str, redirect_uri: str, **kw: Any) -> TokenBundle:
        return TokenBundle("mock-access", "mock-refresh")

    def refresh(self, tokens: TokenBundle) -> TokenBundle:
        return tokens

    def identity(self, tokens: TokenBundle) -> AccountIdentity:
        return AccountIdentity("mock-1", "Test-Konto")

    def upload(self, tokens: TokenBundle, account_meta: dict, req: UploadRequest) -> PublishResult:
        if MockAdapter.fail_next > 0:
            MockAdapter.fail_next -= 1
            raise PublishError("Simulierter Fehler (Mock)", retry=True)
        out = get_settings().data_dir / "mock_published"
        out.mkdir(parents=True, exist_ok=True)
        vid = hashlib.sha1(f"{req.video}{req.title}".encode()).hexdigest()[:10]
        shutil.copy(req.video, out / f"{vid}.mp4")
        (out / f"{vid}.json").write_text(json.dumps({"title": req.title, "description": req.description, "hashtags": req.hashtags,
                                                     "tags": req.tags}, ensure_ascii=False, indent=2))
        return PublishResult(vid, f"https://example.invalid/mock/{vid}", "live")

    def fetch_metrics(self, tokens: TokenBundle, account_meta: dict, external_ids: list[str]) -> dict[str, dict]:
        return {e: {"views": int(e[:4], 16) % 50000, "likes": int(e[4:7], 16) % 3000} for e in external_ids}

    def quota_rule(self, account_meta: dict) -> QuotaRule:
        return QuotaRule(daily_uploads=100)
