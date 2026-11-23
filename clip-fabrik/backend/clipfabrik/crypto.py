"""Verschlüsselung von Secrets (API-Keys, OAuth-Tokens) in der Datenbank.

Schlüssel wird per HKDF aus ``SECRET_KEY`` abgeleitet. Verschlüsselte Werte beginnen mit
``enc:v1:``. Ohne gültigen SECRET_KEY lassen sie sich nicht entschlüsseln.
"""

from __future__ import annotations

import base64
import json
from functools import lru_cache
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .logging_setup import register_secret

PREFIX = "enc:v1:"


class DecryptionError(RuntimeError):
    pass


@lru_cache(maxsize=4)
def _fernet(secret_key: str) -> Fernet:
    hkdf = HKDF(algorithm=hashes.SHA256(), length=32, salt=b"clipfabrik-secrets", info=b"fernet-v1")
    key = base64.urlsafe_b64encode(hkdf.derive(secret_key.encode()))
    return Fernet(key)


def _key() -> str:
    from .config import get_settings

    return get_settings().secret_key


def encrypt(value: str, secret_key: str | None = None) -> str:
    register_secret(value)
    token = _fernet(secret_key or _key()).encrypt(value.encode()).decode()
    return PREFIX + token


def decrypt(value: str, secret_key: str | None = None) -> str:
    if not value.startswith(PREFIX):
        raise DecryptionError("Wert ist nicht verschlüsselt")
    try:
        plain = _fernet(secret_key or _key()).decrypt(value[len(PREFIX):].encode()).decode()
    except InvalidToken as exc:
        raise DecryptionError(
            "Secret lässt sich nicht entschlüsseln (SECRET_KEY geändert?)"
        ) from exc
    register_secret(plain)
    return plain


def is_encrypted(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(PREFIX)


def encrypt_json(data: Any) -> str:
    if isinstance(data, dict):
        for k, v in data.items():
            if isinstance(v, str) and ("token" in k or "secret" in k):
                register_secret(v)
    return encrypt(json.dumps(data))


def decrypt_json(value: str | None) -> Any:
    if not value:
        return None
    data = json.loads(decrypt(value))
    if isinstance(data, dict):
        for k, v in data.items():
            if isinstance(v, str) and ("token" in k or "secret" in k):
                register_secret(v)
    return data
