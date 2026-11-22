"""Login für genau einen Nutzer: Passwort (Argon2) + signiertes Session-Cookie.

Schutz gegen Durchprobieren: nach 5 Fehlversuchen in 15 Minuten pro IP wird gesperrt.
"""

from __future__ import annotations

import datetime as dt
import logging
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from fastapi import HTTPException, Request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from sqlalchemy import func, select

from . import settings_store
from .config import get_settings
from .db import LoginAttempt, session_scope, utcnow

log = logging.getLogger(__name__)
_ph = PasswordHasher()

COOKIE_NAME = "cf_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 30  # 30 Tage
MAX_FAILURES = 5
LOCK_WINDOW = dt.timedelta(minutes=15)


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().secret_key, salt="cf-session")


def hash_password(pw: str) -> str:
    return _ph.hash(pw)


def ensure_admin_password() -> None:
    """Beim Start: Passwort aus ADMIN_PASSWORD übernehmen, falls noch keins gesetzt ist."""
    current = settings_store.get("admin_password_hash")
    env_pw = get_settings().admin_password
    if not current and env_pw:
        settings_store.set_value("admin_password_hash", hash_password(env_pw))
        log.info("Admin-Passwort aus ADMIN_PASSWORD übernommen")
    elif not current:
        log.warning("Kein Passwort gesetzt: ADMIN_PASSWORD in .env eintragen (Einrichtungsskript macht das).")


def verify_password(pw: str) -> bool:
    stored = settings_store.get("admin_password_hash")
    if not stored:
        return False
    try:
        _ph.verify(stored, pw)
        return True
    except (VerifyMismatchError, InvalidHashError):
        return False


def change_password(old: str, new: str) -> None:
    if not verify_password(old):
        raise HTTPException(400, "Altes Passwort stimmt nicht")
    if len(new) < 10:
        raise HTTPException(400, "Neues Passwort braucht mindestens 10 Zeichen")
    settings_store.set_value("admin_password_hash", hash_password(new))
    # alle bestehenden Sessions ungültig machen
    settings_store.set_value("session_epoch", secrets.token_hex(8))


def is_locked(ip: str) -> bool:
    since = utcnow() - LOCK_WINDOW
    with session_scope() as s:
        failures = s.scalar(
            select(func.count())
            .select_from(LoginAttempt)
            .where(LoginAttempt.ip == ip, LoginAttempt.success.is_(False), LoginAttempt.created_at >= since)
        )
    return (failures or 0) >= MAX_FAILURES


def record_attempt(ip: str, success: bool) -> None:
    with session_scope() as s:
        s.add(LoginAttempt(ip=ip, success=success))
        if success:
            # erfolgreicher Login setzt Zähler zurück
            s.query(LoginAttempt).filter(LoginAttempt.ip == ip, LoginAttempt.success.is_(False)).delete()


def create_session_token() -> str:
    epoch = settings_store.get("session_epoch") or "0"
    return _serializer().dumps({"u": "admin", "e": epoch})


def check_session_token(token: str | None) -> bool:
    if not token:
        return False
    try:
        data = _serializer().loads(token, max_age=SESSION_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return False
    epoch = settings_store.get("session_epoch") or "0"
    return data.get("u") == "admin" and data.get("e") == epoch


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "?"


def require_login(request: Request) -> None:
    if not check_session_token(request.cookies.get(COOKIE_NAME)):
        raise HTTPException(status_code=401, detail="Bitte einloggen")
