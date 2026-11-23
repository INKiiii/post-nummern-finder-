"""Claude-Client: strukturierte JSON-Ausgabe, Prompt-Caching, Ergebnis-Cache, Kostenerfassung.

* Modell aus den Settings (Standard ``claude-sonnet-5-5``), Effort einstellbar.
* ``output_config.format`` mit JSON-Schema -> die Antwort ist garantiert gültiges JSON.
* System-Prompt in Blöcken mit ``cache_control`` (Raster + Lern-Beispiele werden gecacht).
* Gleicher Request -> Antwort aus ``llm_cache`` (keine zweite Abrechnung).
* Server-seitige Fallbacks (Beta) bei Ablehnung durch Sicherheitsklassifikatoren, abschaltbar.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .. import settings_store
from ..db import LLMCache, LLMUsage, session_scope

log = logging.getLogger(__name__)

FALLBACK_BETA = "server-side-fallback-2026-07-01"


class LLMError(RuntimeError):
    pass


class LLMRefusal(LLMError):
    """Claude hat die Anfrage abgelehnt (stop_reason=refusal). Wird als Safety-Hinweis behandelt."""

    def __init__(self, category: str | None, explanation: str | None) -> None:
        super().__init__(f"Abgelehnt ({category or 'ohne Kategorie'}): {explanation or ''}")
        self.category = category
        self.explanation = explanation


@dataclass
class Usage:
    input_tokens: int = 0
    cache_read: int = 0
    cache_write: int = 0
    output_tokens: int = 0


def price_for(model: str) -> dict[str, float]:
    prices = settings_store.get("model_prices") or {}
    return prices.get(model) or prices.get("claude-sonnet-5-5") or {"input": 2.0, "output": 10.0, "cache_read": 0.1}


def cost_usd(model: str, u: Usage) -> float:
    p = price_for(model)
    cache_write_price = p["input"] * 1.25
    return (
        u.input_tokens * p["input"]
        + u.cache_read * p.get("cache_read", p["input"] * 0.1)
        + u.cache_write * cache_write_price
        + u.output_tokens * p["output"]
    ) / 1_000_000


def estimate_tokens(text: str) -> int:
    """Grobe Schätzung für Deutsch (~3,4 Zeichen pro Token)."""
    return int(len(text) / 3.4) + 1


def image_block(path: Path) -> dict:
    data = base64.standard_b64encode(path.read_bytes()).decode()
    media = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    return {"type": "image", "source": {"type": "base64", "media_type": media, "data": data}}


class ClaudeClient:
    def __init__(self, api_key: str | None = None, model: str | None = None, *, client: Any = None) -> None:
        self.model = model or settings_store.get("claude_model") or "claude-sonnet-5-5"
        self.effort = settings_store.get("claude_effort") or "medium"
        self.fallbacks = bool(settings_store.get("claude_fallbacks"))
        self._client = client
        self._api_key = api_key or settings_store.get("anthropic_api_key")

    @property
    def client(self) -> Any:
        if self._client is None:
            if not self._api_key:
                raise LLMError("Kein Anthropic-API-Key hinterlegt (Settings → KI)")
            import anthropic

            self._client = anthropic.Anthropic(api_key=self._api_key, max_retries=3, timeout=180.0)
        return self._client

    def json_call(
        self,
        *,
        purpose: str,
        system_blocks: list[str],
        user_text: str,
        schema: dict,
        max_tokens: int = 8000,
        images: list[Path] | None = None,
        stream_id: int | None = None,
        use_cache: bool = True,
    ) -> dict:
        images = images or []
        key_src = json.dumps(
            {
                "m": self.model, "e": self.effort, "p": purpose, "s": system_blocks, "u": user_text, "schema": schema,
                "img": [hashlib.sha256(p.read_bytes()).hexdigest() for p in images],
            },
            sort_keys=True,
            ensure_ascii=False,
        )
        key = hashlib.sha256(key_src.encode()).hexdigest()
        if use_cache:
            with session_scope() as s:
                hit = s.get(LLMCache, key)
                if hit is not None:
                    s.add(LLMUsage(stream_id=stream_id, purpose=purpose, model=self.model, cached=True))
                    return hit.response

        system = [
            {"type": "text", "text": block, "cache_control": {"type": "ephemeral"}} if i < 2 else {"type": "text", "text": block}
            for i, block in enumerate(system_blocks)
            if block
        ]
        content: list[dict] = [image_block(p) for p in images]
        content.append({"type": "text", "text": user_text})
        kwargs: dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": content}],
            "output_config": {"effort": self.effort, "format": {"type": "json_schema", "schema": schema}},
        }
        t0 = time.monotonic()
        resp = self._create(kwargs)
        if getattr(resp, "stop_reason", None) == "refusal":
            details = getattr(resp, "stop_details", None)
            raise LLMRefusal(getattr(details, "category", None), getattr(details, "explanation", None))
        if getattr(resp, "stop_reason", None) == "max_tokens":
            raise LLMError(f"{purpose}: Antwort abgeschnitten (max_tokens={max_tokens})")
        text = next((b.text for b in resp.content if getattr(b, "type", "") == "text"), None)
        if text is None:
            raise LLMError(f"{purpose}: keine Textantwort")
        data = parse_json(text)
        u = resp.usage
        usage = Usage(
            input_tokens=getattr(u, "input_tokens", 0) or 0,
            cache_read=getattr(u, "cache_read_input_tokens", 0) or 0,
            cache_write=getattr(u, "cache_creation_input_tokens", 0) or 0,
            output_tokens=getattr(u, "output_tokens", 0) or 0,
        )
        served_model = getattr(resp, "model", self.model) or self.model
        cost = cost_usd(served_model, usage)
        log.info(
            "Claude %s: %d in (%d cache) / %d out, %.4f USD, %.1fs, request_id=%s",
            purpose, usage.input_tokens, usage.cache_read, usage.output_tokens, cost, time.monotonic() - t0,
            getattr(resp, "_request_id", "?"),
        )
        with session_scope() as s:
            s.add(LLMUsage(
                stream_id=stream_id, purpose=purpose, model=served_model, input_tokens=usage.input_tokens,
                cache_read_tokens=usage.cache_read, cache_write_tokens=usage.cache_write,
                output_tokens=usage.output_tokens, cost_usd=cost,
            ))
            if use_cache:
                s.merge(LLMCache(key=key, model=served_model, purpose=purpose, response=data,
                                 input_tokens=usage.input_tokens, output_tokens=usage.output_tokens, cost_usd=cost))
            if stream_id:
                from ..db import Stream

                st = s.get(Stream, stream_id)
                if st is not None:
                    st.cost_actual_usd = (st.cost_actual_usd or 0.0) + cost
        return data

    def _create(self, kwargs: dict) -> Any:
        import anthropic

        try:
            if self.fallbacks:
                return self.client.beta.messages.create(betas=[FALLBACK_BETA], fallbacks="default", **kwargs)
            return self.client.messages.create(**kwargs)
        except anthropic.BadRequestError as exc:
            if self.fallbacks and "fallback" in str(exc).lower():
                log.warning("Server-Fallbacks nicht verfügbar, sende ohne: %s", exc)
                self.fallbacks = False
                return self.client.messages.create(**kwargs)
            raise LLMError(f"Ungültige Anfrage an Claude: {exc}") from exc
        except anthropic.AuthenticationError as exc:
            raise LLMError("Anthropic-API-Key ungültig") from exc
        except anthropic.PermissionDeniedError as exc:
            raise LLMError("Anthropic-API-Key hat keine Berechtigung für dieses Modell") from exc
        except anthropic.NotFoundError as exc:
            raise LLMError(f"Modell {self.model} nicht gefunden (Settings → KI prüfen)") from exc
        except anthropic.RateLimitError as exc:
            raise LLMError("Anthropic-Ratenlimit erreicht, Job wird später wiederholt") from exc
        except anthropic.APIStatusError as exc:
            raise LLMError(f"Anthropic-Fehler {exc.status_code}: {exc.message}") from exc
        except anthropic.APIConnectionError as exc:
            raise LLMError("Keine Verbindung zur Anthropic-API") from exc


def parse_json(text: str) -> Any:
    """Robustes JSON-Parsing (Code-Fences, Text drumherum)."""
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else t[3:]
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    for open_c, close_c in (("{", "}"), ("[", "]")):
        a, b = t.find(open_c), t.rfind(close_c)
        if a >= 0 and b > a:
            try:
                return json.loads(t[a:b + 1])
            except json.JSONDecodeError:
                continue
    raise LLMError(f"Antwort ist kein gültiges JSON: {text[:200]}")
