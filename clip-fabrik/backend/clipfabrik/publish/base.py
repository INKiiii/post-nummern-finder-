"""Gemeinsames Interface für Plattform-Adapter (nur offizielle APIs)."""

from __future__ import annotations

import datetime as dt
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


class PublishError(RuntimeError):
    """Fehler beim Veröffentlichen. ``retry`` = später erneut versuchen sinnvoll."""

    def __init__(self, msg: str, *, retry: bool = True, auth: bool = False) -> None:
        super().__init__(msg)
        self.retry = retry
        self.auth = auth


@dataclass
class TokenBundle:
    access_token: str
    refresh_token: str | None = None
    expires_at: dt.datetime | None = None
    scopes: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict:
        return {
            "access_token": self.access_token, "refresh_token": self.refresh_token,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None, "scopes": self.scopes, "extra": self.extra,
        }

    @classmethod
    def from_json(cls, d: dict) -> "TokenBundle":
        exp = d.get("expires_at")
        return cls(d["access_token"], d.get("refresh_token"), dt.datetime.fromisoformat(exp) if exp else None,
                   d.get("scopes", []), d.get("extra", {}))


@dataclass
class AccountIdentity:
    external_id: str
    name: str
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class UploadRequest:
    video: Path
    title: str
    description: str
    hashtags: list[str]
    tags: list[str]
    privacy: str = ""
    draft: bool = False


@dataclass
class PublishResult:
    external_id: str
    url: str | None = None
    status: str = "live"  # live | processing
    note: str = ""


@dataclass
class QuotaRule:
    """Was heute laut Plattform möglich ist (zusätzlich zum eigenen Tageslimit pro Konto)."""

    daily_uploads: int | None = None
    daily_units: int | None = None
    units_per_upload: int = 1
    note: str = ""


class PlatformAdapter(ABC):
    platform: str = ""
    label: str = ""

    @abstractmethod
    def configured(self) -> bool: ...

    @abstractmethod
    def authorize_url(self, redirect_uri: str, state: str) -> str: ...

    @abstractmethod
    def exchange_code(self, code: str, redirect_uri: str, **kw: Any) -> TokenBundle: ...

    @abstractmethod
    def refresh(self, tokens: TokenBundle) -> TokenBundle: ...

    @abstractmethod
    def identity(self, tokens: TokenBundle) -> AccountIdentity: ...

    @abstractmethod
    def upload(self, tokens: TokenBundle, account_meta: dict, req: UploadRequest) -> PublishResult: ...

    def check_status(self, tokens: TokenBundle, account_meta: dict, external_id: str) -> PublishResult | None:
        return None

    def fetch_metrics(self, tokens: TokenBundle, account_meta: dict, external_ids: list[str]) -> dict[str, dict]:
        return {}

    def quota_rule(self, account_meta: dict) -> QuotaRule:
        return QuotaRule()

    def approval_hint(self) -> str:
        return ""
