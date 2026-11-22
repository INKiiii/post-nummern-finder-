"""Logging mit Schwärzung von Geheimnissen.

Jeder Log-Eintrag läuft durch ``RedactingFilter``. Er entfernt bekannte Secret-Werte
(registriert über ``register_secret``) und typische Token-Muster. So landen API-Keys,
OAuth-Tokens und Passwörter nie im Log, auch nicht in Fehlermeldungen von Bibliotheken.
"""

from __future__ import annotations

import logging
import re
import sys
import threading

_lock = threading.Lock()
_secrets: set[str] = set()

_PATTERNS = [
    (re.compile(r"(sk-ant-[A-Za-z0-9_\-]{6})[A-Za-z0-9_\-]+"), r"\1…[geschwärzt]"),
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-~+/=]{8,}"), r"\1[geschwärzt]"),
    (re.compile(r"(?i)(oauth[:\s]+)[A-Za-z0-9]{10,}"), r"\1[geschwärzt]"),
    (
        re.compile(
            r"(?i)((?:access_token|refresh_token|client_secret|api_key|apikey|password|passwort|token|secret)"
            r"[\"']?\s*[:=]\s*[\"']?)([^\"'&\s,}]{4,})"
        ),
        r"\1[geschwärzt]",
    ),
]


def register_secret(value: str | None) -> None:
    """Merkt sich einen Secret-Wert, damit er in Logs ersetzt wird."""
    if value and len(value) >= 6:
        with _lock:
            _secrets.add(value)


def redact(text: str) -> str:
    with _lock:
        secrets = sorted(_secrets, key=len, reverse=True)
    for s in secrets:
        if s in text:
            text = text.replace(s, "[geschwärzt]")
    for pat, repl in _PATTERNS:
        text = pat.sub(repl, text)
    return text


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:  # pragma: no cover - defekte Format-Strings nicht verschlucken
            msg = str(record.msg)
        record.msg = redact(msg)
        record.args = None
        if record.exc_info and record.exc_info[1] is not None:
            # Exception-Text wird beim Formatieren erzeugt -> vorher schwärzen
            record.exc_text = redact(logging.Formatter().formatException(record.exc_info))
            record.exc_info = None
        return True


_configured = False


def setup_logging(level: str = "INFO") -> None:
    global _configured
    if _configured:
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s"))
    handler.addFilter(RedactingFilter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    for noisy in ("httpx", "httpcore", "urllib3", "anthropic._base_client", "multipart"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    _configured = True
