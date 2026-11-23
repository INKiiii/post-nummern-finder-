"""Quota-Tracker: kennt Plattform-Limits und eigene Tageslimits pro Konto und zeigt verständlich,
was heute noch möglich ist. Tagesgrenze: YouTube rechnet in Pazifik-Zeit, sonst Europe/Berlin."""

from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import QuotaUsage, SocialAccount
from .registry import adapter_for

PLATFORM_TZ = {"youtube": "America/Los_Angeles"}


def quota_day(platform: str, now: dt.datetime | None = None) -> str:
    tz = ZoneInfo(PLATFORM_TZ.get(platform, "Europe/Berlin"))
    now = now or dt.datetime.now(dt.UTC)
    if now.tzinfo is None:
        now = now.replace(tzinfo=dt.UTC)
    return now.astimezone(tz).strftime("%Y-%m-%d")


def usage_for(s: Session, account: SocialAccount, day: str | None = None) -> QuotaUsage:
    day = day or quota_day(account.platform)
    row = s.scalar(select(QuotaUsage).where(QuotaUsage.account_id == account.id, QuotaUsage.day == day))
    if row is None:
        row = QuotaUsage(account_id=account.id, day=day, units=0, uploads=0)
        s.add(row)
        s.flush()
    return row


def remaining(s: Session, account: SocialAccount, now: dt.datetime | None = None) -> dict:
    """Wie viele Uploads heute noch gehen (Minimum aus Plattform-Regel und eigenem Tageslimit)."""
    rule = adapter_for(account.platform).quota_rule({"api_approved": account.api_approved})
    u = usage_for(s, account, quota_day(account.platform, now))
    limits = [account.daily_limit]
    if rule.daily_uploads is not None:
        limits.append(rule.daily_uploads)
    if rule.daily_units is not None:
        limits.append(rule.daily_units // max(1, rule.units_per_upload))
    cap = max(0, min(limits))
    left = max(0, cap - u.uploads)
    if rule.daily_units is not None:
        left = min(left, max(0, (rule.daily_units - u.units) // max(1, rule.units_per_upload)))
    return {
        "account_id": account.id, "platform": account.platform, "name": account.name, "day": u.day,
        "used": u.uploads, "cap": cap, "left": left, "units_used": u.units, "units_total": rule.daily_units,
        "note": rule.note, "own_limit": account.daily_limit,
    }


def consume(s: Session, account: SocialAccount, now: dt.datetime | None = None) -> None:
    rule = adapter_for(account.platform).quota_rule({"api_approved": account.api_approved})
    u = usage_for(s, account, quota_day(account.platform, now))
    u.uploads += 1
    u.units += rule.units_per_upload if rule.daily_units is not None else 0


def mark_exhausted(s: Session, account: SocialAccount) -> None:
    """Plattform meldet „Kontingent aufgebraucht“: für heute als voll markieren."""
    rule = adapter_for(account.platform).quota_rule({"api_approved": account.api_approved})
    u = usage_for(s, account)
    u.uploads = max(u.uploads, account.daily_limit)
    if rule.daily_units is not None:
        u.units = rule.daily_units
