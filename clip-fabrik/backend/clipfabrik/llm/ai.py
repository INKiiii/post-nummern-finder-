"""Die KI-Schritte der Highlight-Auswahl hinter einer gemeinsamen Schnittstelle.

* ``ClaudeAI``: echte Claude-Durchläufe (Kandidaten -> Raster-Bewertung -> Ranking -> Texte -> Safety).
* ``HeuristicAI``: deterministischer Ersatz für Tests und Betrieb ohne API-Key (klar gekennzeichnet).
* ``local_safety_scan``: Regex-Vorprüfung (Telefonnummern, E-Mails, Adressen, IBAN, Schimpfwörter,
  Musik-Marker) läuft immer zusätzlich – zweite Verteidigungslinie neben Claude.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, Sequence

from . import prompts as P
from .client import ClaudeClient, LLMRefusal, estimate_tokens

log = logging.getLogger(__name__)


@dataclass
class WindowInput:
    id: int
    start: float
    end: float
    anchor: float
    signals: list[dict]
    lines: list[tuple[float, float, str]]
    chat_samples: list[str] = field(default_factory=list)


@dataclass
class Proposal:
    window_id: int
    start: float
    end: float
    punchline_at: float
    category: str
    idea: str
    hook_text: str
    context: tuple[float, float] | None = None
    context_line: str = ""


@dataclass
class CandidateInput:
    id: int
    start: float
    end: float
    lines: list[tuple[float, float, str]]
    context_before: str
    signals: str
    category: str
    idea: str
    hook_text: str
    strength: float = 0.0
    frames: list[Path] = field(default_factory=list)


@dataclass
class Assessment:
    id: int
    scores: dict[str, int]
    reason: str
    title: str
    hook_text: str
    safety_flags: list[str]
    safety_note: str
    trim_start: float | None = None
    trim_end: float | None = None


@dataclass
class RankItem:
    id: int
    title: str
    category: str
    total: float
    text: str
    start: float


@dataclass
class CaptionInput:
    id: int
    title: str
    category: str
    transcript: str
    hook_text: str
    game: str = ""


@dataclass
class SafetyInput:
    id: int
    transcript: str
    captions: dict
    frames: list[Path] = field(default_factory=list)


@dataclass
class SafetyResult:
    ok: bool
    flags: list[str]
    severity: str
    note: str


class HighlightAI(Protocol):
    name: str

    def propose(self, windows: Sequence[WindowInput]) -> list[Proposal]: ...
    def assess(self, cands: Sequence[CandidateInput]) -> list[Assessment]: ...
    def rank(self, items: Sequence[RankItem]) -> tuple[list[int], dict[int, int]]: ...
    def captions(self, items: Sequence[CaptionInput]) -> dict[int, dict]: ...
    def safety(self, item: SafetyInput) -> SafetyResult: ...


def _clamp_score(v: object) -> int:
    try:
        return max(1, min(10, int(round(float(v)))))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 1


def _lines_text(lines: Sequence[tuple[float, float, str]]) -> str:
    return "\n".join(f"[{s:.1f}s | {P.fmt_ts(s)}] {t}" for s, _e, t in lines)


def _batches(items: Sequence, n: int) -> list[Sequence]:
    return [items[i:i + n] for i in range(0, len(items), n)]


# --------------------------------------------------------------------------------------
# Claude
# --------------------------------------------------------------------------------------


class ClaudeAI:
    name = "claude"

    def __init__(self, client: ClaudeClient, *, brand_voice: str = "", examples: str = "", stream_id: int | None = None,
                 channel_name: str = "", vision: bool = True) -> None:
        self.client = client
        self.brand_voice = brand_voice.strip()
        self.examples = examples.strip()
        self.stream_id = stream_id
        self.channel_name = channel_name
        self.vision = vision

    def _system(self, extra: str) -> list[str]:
        blocks = [P.SYSTEM_EDITOR + "\n\n" + extra]
        ex = ""
        if self.examples:
            ex += "Beispiele aus früheren Entscheidungen (zeigen den Humor des Streamers und was beim Publikum ankam):\n" + self.examples
        if self.brand_voice:
            ex += ("\n\n" if ex else "") + f"Brand-Voice / Tonalität des Kanals: {self.brand_voice}"
        if ex:
            blocks.append(ex)
        return blocks

    def propose(self, windows: Sequence[WindowInput]) -> list[Proposal]:
        out: list[Proposal] = []
        for batch in _batches(list(windows), 5):
            parts = []
            for w in batch:
                sig = "; ".join(f"{s['type']} bei {s['t']:.1f}s ({s.get('detail', '')})" for s in w.signals)
                chat = (" | Chat-Ausschnitte: " + " / ".join(w.chat_samples[:8])) if w.chat_samples else ""
                parts.append(
                    f"### Fenster {w.id} ({w.start:.1f}s – {w.end:.1f}s)\nSignale: {sig}{chat}\nTranskript:\n{_lines_text(w.lines)}"
                )
            user = (
                "Hier sind Ausschnitte mit auffälligen Signalen. Schlage pro Fenster höchstens einen Clip vor – "
                "nur wenn er wirklich viral-tauglich ist, sonst lass das Fenster weg. "
                "Start mit dem stärksten Moment oder einer Hook-Zeile, Ende direkt nach der Pointe, nie mitten im Satz.\n\n"
                + "\n\n".join(parts)
            )
            data = self.client.json_call(
                purpose="kandidaten", system_blocks=self._system("Aufgabe: Clip-Kandidaten finden."),
                user_text=user, schema=P.PROPOSE_SCHEMA, max_tokens=6000, stream_id=self.stream_id,
            )
            ids = {w.id: w for w in batch}
            for c in data.get("clips", []):
                w = ids.get(int(c.get("window_id", -1)))
                if w is None:
                    continue
                start = max(w.start - 10, float(c["start"]))
                end = min(w.end + 10, float(c["end"]))
                if end - start < 3:
                    continue
                ctx = None
                if float(c.get("context_start", -1)) >= 0 and float(c.get("context_end", -1)) > float(c.get("context_start", -1)):
                    ctx = (float(c["context_start"]), float(c["context_end"]))
                out.append(Proposal(
                    window_id=w.id, start=start, end=end, punchline_at=float(c.get("punchline_at", end)),
                    category=c.get("category", "Reaktion"), idea=c.get("idea", ""), hook_text=c.get("hook_text", ""),
                    context=ctx, context_line=c.get("context_line", ""),
                ))
        return out

    def assess(self, cands: Sequence[CandidateInput]) -> list[Assessment]:
        out: list[Assessment] = []
        for batch in _batches(list(cands), 4):
            parts = []
            images: list[Path] = []
            for c in batch:
                frames_note = ""
                if self.vision and c.frames:
                    frames_note = f"\nBilder {len(images) + 1}–{len(images) + len(c.frames)} gehören zu Kandidat {c.id}."
                    images.extend(c.frames)
                parts.append(
                    f"### Kandidat {c.id} ({c.start:.1f}s – {c.end:.1f}s, {c.end - c.start:.0f}s, Kategorie {c.category})\n"
                    f"Idee: {c.idea}\nSignale: {c.signals}\nKontext davor: {c.context_before or '—'}\n"
                    f"Transkript:\n{_lines_text(c.lines)}{frames_note}"
                )
            user = (
                "Bewerte jeden Kandidaten nach dem Raster. Schlage bei Bedarf bessere Grenzen vor "
                "(trim_start/trim_end in Sekunden, sonst -1): Leerlauf und Füllwörter am Anfang und Ende weg, "
                "Ende direkt nach der Pointe.\n\n" + "\n\n".join(parts)
            )
            try:
                data = self.client.json_call(
                    purpose="bewertung", system_blocks=self._system(P.RUBRIC), user_text=user,
                    schema=P.ASSESS_SCHEMA, max_tokens=6000, images=images if self.vision else None,
                    stream_id=self.stream_id,
                )
            except LLMRefusal as ref:
                log.warning("Bewertung abgelehnt (%s) – Kandidaten werden als riskant markiert", ref.category)
                for c in batch:
                    out.append(Assessment(c.id, {k: 1 for k in ("hook", "payoff", "clarity", "emotion", "meme")} | {"risk": 10},
                                          "Von Claude abgelehnt – manuell prüfen.", c.idea[:60], c.hook_text,
                                          ["plattform_richtlinie"], f"Ablehnung: {ref.category or 'unbekannt'}"))
                continue
            for a in data.get("assessments", []):
                ts, te = float(a.get("trim_start", -1)), float(a.get("trim_end", -1))
                out.append(Assessment(
                    id=int(a["id"]),
                    scores={k: _clamp_score(a.get(k)) for k in ("hook", "payoff", "clarity", "emotion", "meme", "risk")},
                    reason=a.get("reason", "").strip(), title=a.get("title", "").strip()[:120],
                    hook_text=a.get("hook_text", "").strip()[:80],
                    safety_flags=[f for f in a.get("safety_flags", []) if f in P.SAFETY_FLAGS],
                    safety_note=a.get("safety_note", ""),
                    trim_start=ts if ts >= 0 else None, trim_end=te if te >= 0 else None,
                ))
        return out

    def rank(self, items: Sequence[RankItem]) -> tuple[list[int], dict[int, int]]:
        if len(items) <= 1:
            return [i.id for i in items], {}
        lines = [
            f"- ID {i.id} | {P.fmt_ts(i.start)} | {i.category} | Score {i.total:.1f} | {i.title} | „{i.text[:220]}“"
            for i in items
        ]
        user = (
            "Das sind alle Clip-Kandidaten dieses Streams, die die Bewertung bestanden haben. "
            "Sortiere sie nach Viral-Potenzial (bester zuerst). Markiere Dubletten (gleicher Moment oder gleicher Witz) "
            "mit duplicate_of = ID des besseren Clips. Achte auf Vielfalt: ähnliche Clips nicht direkt hintereinander.\n\n"
            + "\n".join(lines)
        )
        data = self.client.json_call(
            purpose="ranking", system_blocks=self._system("Aufgabe: Gesamt-Ranking eines Streams."),
            user_text=user, schema=P.RANK_SCHEMA, max_tokens=4000, stream_id=self.stream_id,
        )
        known = {i.id for i in items}
        order = [int(x) for x in data.get("order", []) if int(x) in known]
        order += [i.id for i in sorted(items, key=lambda i: -i.total) if i.id not in order]
        dups = {int(d["id"]): int(d["duplicate_of"]) for d in data.get("duplicates", [])
                if int(d["id"]) in known and int(d["duplicate_of"]) in known and int(d["id"]) != int(d["duplicate_of"])}
        return order, dups

    def captions(self, items: Sequence[CaptionInput]) -> dict[int, dict]:
        out: dict[int, dict] = {}
        for batch in _batches(list(items), 5):
            parts = [
                f"### Clip {c.id}: {c.title} ({c.category}{', Spiel: ' + c.game if c.game else ''})\nHook: {c.hook_text}\nTranskript: {c.transcript[:900]}"
                for c in batch
            ]
            user = f"Kanal: {self.channel_name or 'unbekannt'}\n\n" + "\n\n".join(parts)
            data = self.client.json_call(
                purpose="texte", system_blocks=self._system(P.CAPTION_GUIDE), user_text=user,
                schema=P.CAPTIONS_SCHEMA, max_tokens=6000, stream_id=self.stream_id,
            )
            for c in data.get("clips", []):
                out[int(c["id"])] = normalize_captions({k: c[k] for k in ("tiktok", "instagram", "youtube")})
        return out

    def safety(self, item: SafetyInput) -> SafetyResult:
        user = (
            f"Transkript des Clips:\n{item.transcript}\n\nGeplante Texte:\n"
            + "\n".join(f"- {pl}: {txt}" for pl, txt in flatten_captions(item.captions).items())
            + ("\n\nDie Bilder sind Frames aus dem fertigen Clip." if item.frames else "")
        )
        try:
            data = self.client.json_call(
                purpose="safety", system_blocks=[P.SAFETY_SYSTEM], user_text=user, schema=P.SAFETY_SCHEMA,
                max_tokens=2000, images=item.frames or None, stream_id=None, use_cache=False,
            )
        except LLMRefusal as ref:
            return SafetyResult(False, ["plattform_richtlinie"], "high", f"Claude hat die Prüfung abgelehnt ({ref.category}).")
        flags = [f for f in data.get("flags", []) if f in P.SAFETY_FLAGS]
        return SafetyResult(bool(data.get("ok")) and data.get("severity") != "high", flags, data.get("severity", "none"), data.get("note", ""))


# --------------------------------------------------------------------------------------
# Heuristik (ohne API)
# --------------------------------------------------------------------------------------

_CATEGORY_BY_SIGNAL = {
    "lautstärke": "Ausraster", "chat": "Reaktion", "gelächter": "Reaktion", "wiederholung": "Spruch",
    "reaktion": "Reaktion", "stille_nach_pointe": "Fail", "event": "Wholesome", "mod_aktion": "Chaos", "marker": "Reaktion",
}


class HeuristicAI:
    """Ohne Claude: Auswahl nur nach Signalstärke. Deutlich schwächer – nur Notbetrieb/Tests."""

    name = "heuristik"

    def propose(self, windows: Sequence[WindowInput]) -> list[Proposal]:
        out = []
        for w in windows:
            types = sorted({s["type"] for s in w.signals}, key=lambda t: -max(s["strength"] for s in w.signals if s["type"] == t))
            cat = _CATEGORY_BY_SIGNAL.get(types[0] if types else "", "Reaktion")
            start = max(w.start, w.anchor - 16)
            end = min(w.end, w.anchor + 9)
            if w.lines:
                inside = [ln for ln in w.lines if ln[1] > start and ln[0] < end]
                if inside:
                    start = max(w.start, min(start, inside[0][0]))
                    end = min(w.end, max(end, inside[-1][1]))
            if end - start > 40:
                start = end - 40
            text = " ".join(t for s, e, t in w.lines if e > start and s < end)
            hook = " ".join(text.split()[:6])
            out.append(Proposal(w.id, start, end, w.anchor, cat, f"Moment mit {', '.join(types)}", hook))
        return out

    def assess(self, cands: Sequence[CandidateInput]) -> list[Assessment]:
        out = []
        for c in cands:
            st = c.strength
            text = " ".join(t for _s, _e, t in c.lines)
            flags = local_safety_scan(text)
            base = 4.5 + min(4.0, st * 0.8)
            scores = {
                "hook": round(base), "payoff": round(base - 0.3), "clarity": 6, "emotion": round(min(10, base + 0.5)),
                "meme": round(base - 1), "risk": 9 if flags else 2,
            }
            out.append(Assessment(c.id, {k: _clamp_score(v) for k, v in scores.items()},
                                  f"Heuristik: Signalstärke {st:.1f} ({c.signals or 'keine Details'}).",
                                  (c.hook_text or c.idea or "Clip")[:60], c.hook_text, flags,
                                  "Regex-Vorprüfung" if flags else ""))
        return out

    def rank(self, items: Sequence[RankItem]) -> tuple[list[int], dict[int, int]]:
        return [i.id for i in sorted(items, key=lambda i: (-i.total, i.start))], {}

    def captions(self, items: Sequence[CaptionInput]) -> dict[int, dict]:
        out = {}
        for c in items:
            tag = re.sub(r"\W+", "", c.game.lower()) if c.game else "gaming"
            title = c.title or c.hook_text or "Stream-Moment"
            out[c.id] = normalize_captions({
                "tiktok": {"description": f"{title} 😳", "hashtags": ["#twitch", f"#{tag}", "#fyp", "#streamer"]},
                "instagram": {"caption": f"{title} – was hättet ihr gemacht? 👇", "hashtags": ["#twitchclips", f"#{tag}", "#reels", "#gamer", "#lustig"]},
                "youtube": {"title": f"{title}"[:70], "description": "Bester Moment aus dem Stream. #Shorts", "tags": ["twitch", tag, "shorts", "clip", "deutsch"]},
            })
        return out

    def safety(self, item: SafetyInput) -> SafetyResult:
        text = item.transcript + " " + " ".join(flatten_captions(item.captions).values())
        flags = local_safety_scan(text)
        return SafetyResult(not flags, flags, "high" if flags else "none", "Regex-Prüfung (ohne Claude)" if flags else "")


# --------------------------------------------------------------------------------------
# Hilfen
# --------------------------------------------------------------------------------------

_PHONE = re.compile(r"(?<!\d)(?:\+49|0049|0)\s?(?:1[5-7]\d|[2-9]\d{1,4})[\s/-]?\d{3,}[\s-]?\d{2,}(?!\d)")
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b")
_ADDRESS = re.compile(r"\b[A-ZÄÖÜ][a-zäöüß]+(?:straße|strasse|str\.|weg|allee|platz|gasse|ring|damm)\s+\d{1,4}[a-z]?\b", re.I)
_IBAN = re.compile(r"\bDE\d{2}\s?(?:\d{4}\s?){4}\d{2}\b")
_MUSIC = re.compile(r"♪|♫|\[musik\]|\(musik\)", re.I)
_SLURS = re.compile(
    r"\b(hurensohn|hurenkind|spast(i|en)?|missgeburt|schwuchtel|neger|kanake|zigeuner|untermensch|transe|mongo)\b", re.I
)


def local_safety_scan(text: str) -> list[str]:
    flags: list[str] = []
    if _PHONE.search(text) or _EMAIL.search(text) or _ADDRESS.search(text) or _IBAN.search(text):
        flags.append("private_daten")
    if _MUSIC.search(text):
        flags.append("urheberrecht_musik")
    if _SLURS.search(text):
        flags.append("beleidigung")
    return flags


def flatten_captions(c: dict) -> dict[str, str]:
    out = {}
    if not c:
        return out
    if "tiktok" in c:
        out["TikTok"] = f"{c['tiktok'].get('description', '')} {' '.join(c['tiktok'].get('hashtags', []))}".strip()
    if "instagram" in c:
        out["Instagram"] = f"{c['instagram'].get('caption', '')} {' '.join(c['instagram'].get('hashtags', []))}".strip()
    if "youtube" in c:
        out["YouTube"] = f"{c['youtube'].get('title', '')} – {c['youtube'].get('description', '')}".strip()
    return out


def _hashtag(t: str) -> str:
    t = re.sub(r"\s+", "", t.strip())
    if not t:
        return ""
    return t if t.startswith("#") else "#" + t


def normalize_captions(c: dict) -> dict:
    """Bereinigt Hashtags und stellt sicher, dass die drei Plattform-Texte nicht identisch sind."""
    tk = c.get("tiktok", {}) or {}
    ig = c.get("instagram", {}) or {}
    yt = c.get("youtube", {}) or {}
    tk_tags = [h for h in dict.fromkeys(_hashtag(x) for x in tk.get("hashtags", [])) if h][:6]
    ig_tags = [h for h in dict.fromkeys(_hashtag(x) for x in ig.get("hashtags", [])) if h][:10]
    yt_tags = [t.lstrip("#").strip() for t in yt.get("tags", []) if t.strip()][:10]
    tk_desc = (tk.get("description") or "").strip()[:2000]
    ig_cap = (ig.get("caption") or "").strip()[:2000]
    yt_title = (yt.get("title") or "").strip()[:100]
    yt_desc = (yt.get("description") or "").strip()
    if "#shorts" not in (yt_title + yt_desc).lower():
        yt_desc = (yt_desc + " #Shorts").strip()
    if ig_cap and ig_cap == tk_desc:
        ig_cap = ig_cap + " 👀"
    if ig_tags and tk_tags and ig_tags == tk_tags:
        ig_tags = ig_tags + ["#reels"]
    return {
        "tiktok": {"description": tk_desc, "hashtags": tk_tags},
        "instagram": {"caption": ig_cap, "hashtags": ig_tags},
        "youtube": {"title": yt_title, "description": yt_desc[:5000], "tags": yt_tags},
    }


def get_ai(*, stream_id: int | None = None, brand_voice: str = "", examples: str = "", channel_name: str = "") -> HighlightAI:
    from .. import settings_store
    from ..config import get_settings

    if get_settings().fake_ai or not settings_store.get("anthropic_api_key"):
        if not get_settings().fake_ai:
            log.warning("Kein Anthropic-API-Key: Heuristik-Modus (deutlich schwächere Auswahl)")
        return HeuristicAI()
    return ClaudeAI(ClaudeClient(), brand_voice=brand_voice, examples=examples, stream_id=stream_id,
                    channel_name=channel_name, vision=bool(settings_store.get("claude_vision")))


def estimate_cost_usd(*, duration: float, windows: int | None = None, clips: int = 15, model: str | None = None) -> dict:
    """Kostenschätzung vor dem Start. Ohne Fensterzahl: ~25 Kandidatenfenster pro Stunde."""
    from .. import settings_store
    from .client import price_for

    model = model or settings_store.get("claude_model")
    p = price_for(model)
    # wie in der Pipeline: ~25 Fenster pro Stunde, gedeckelt auf 3 × Quote + 10 (Kostenkontrolle)
    n_windows = windows if windows is not None else min(max(4, int(25 * duration / 3600)), max(12, clips * 3 + 10))
    sys_tok = estimate_tokens(P.SYSTEM_EDITOR + P.RUBRIC) + 600
    per_window_in = 900  # ~50 s Transkript + Signale
    propose_calls = max(1, (n_windows + 4) // 5)
    candidates = int(n_windows * 0.6)
    assess_calls = max(1, (candidates + 3) // 4)
    images = candidates * 2 * 220 if settings_store.get("claude_vision") else 0
    inp = propose_calls * sys_tok + n_windows * per_window_in + assess_calls * sys_tok + candidates * 700 + images
    inp += 400 + candidates * 90  # Ranking
    inp += ((clips + 4) // 5) * (sys_tok + 5 * 350)  # Texte
    out = n_windows * 130 + candidates * 220 + 60 * candidates + clips * 260
    usd = (inp * p["input"] + out * p["output"]) / 1_000_000
    return {"model": model, "windows": n_windows, "input_tokens": inp, "output_tokens": out, "usd": round(usd, 3)}
