"""Deutsche Prompts und JSON-Schemas für die Claude-Durchläufe.

Schemas enthalten bewusst keine Zahlengrenzen (minimum/maximum): Werte werden nach dem
Parsen geklemmt. Alle Felder sind ``required`` und ``additionalProperties: false``.
"""

from __future__ import annotations

CATEGORIES = ["Ausraster", "Fail", "Spruch", "Reaktion", "Skill", "Wholesome", "Chaos", "Story"]

SAFETY_FLAGS = [
    "hassrede", "beleidigung", "diskriminierung", "sexuell", "gewalt", "selbstverletzung",
    "private_daten", "urheberrecht_musik", "fremdinhalt", "plattform_richtlinie", "sonstiges",
]

SAFETY_LABELS = {
    "hassrede": "Hassrede",
    "beleidigung": "Beleidigung",
    "diskriminierung": "Diskriminierung",
    "sexuell": "sexuelle Inhalte",
    "gewalt": "Gewalt",
    "selbstverletzung": "Selbstverletzung",
    "private_daten": "private Daten (Adresse, Klarname, Telefon, fremde Chat-Namen)",
    "urheberrecht_musik": "Urheberrecht: laufende Musik",
    "fremdinhalt": "Urheberrecht: fremdes Video / Reaktion auf fremde Inhalte",
    "plattform_richtlinie": "Verstoß gegen TikTok-/Instagram-/YouTube-Richtlinien",
    "sonstiges": "sonstiges Risiko",
}


def _obj(props: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props, "required": required or list(props), "additionalProperties": False}


PROPOSE_SCHEMA = _obj({
    "clips": {"type": "array", "items": _obj({
        "window_id": {"type": "integer"},
        "start": {"type": "number", "description": "Startzeit in Sekunden (absolut, wie im Transkript)"},
        "end": {"type": "number", "description": "Endzeit in Sekunden, direkt nach der Pointe"},
        "punchline_at": {"type": "number"},
        "category": {"type": "string", "enum": CATEGORIES},
        "idea": {"type": "string", "description": "Worum geht es, in einem Satz"},
        "hook_text": {"type": "string", "description": "Hook-Untertitel für die ersten 2 Sekunden, max. 7 Wörter"},
        "context_start": {"type": "number", "description": "Start eines kurzen Rückblick-Cuts oder -1"},
        "context_end": {"type": "number", "description": "Ende des Rückblick-Cuts oder -1"},
        "context_line": {"type": "string", "description": "Kontext-Zeile oben im Bild oder leer"},
    })},
})

ASSESS_SCHEMA = _obj({
    "assessments": {"type": "array", "items": _obj({
        "id": {"type": "integer"},
        "hook": {"type": "integer", "description": "1-10: packt der Clip in den ersten 2 Sekunden?"},
        "payoff": {"type": "integer", "description": "1-10: Pointe/Auflösung"},
        "clarity": {"type": "integer", "description": "1-10: verständlich ohne Vorwissen"},
        "emotion": {"type": "integer", "description": "1-10: emotionale Intensität"},
        "meme": {"type": "integer", "description": "1-10: Wiederverwendbarkeit als Meme/Sound"},
        "risk": {"type": "integer", "description": "1-10: Risiko (10 = sehr riskant)"},
        "reason": {"type": "string", "description": "Begründung in genau einem Satz"},
        "title": {"type": "string", "description": "Arbeitstitel, max. 60 Zeichen"},
        "hook_text": {"type": "string", "description": "Hook-Untertitel, max. 7 Wörter"},
        "safety_flags": {"type": "array", "items": {"type": "string", "enum": SAFETY_FLAGS}},
        "safety_note": {"type": "string"},
        "trim_start": {"type": "number", "description": "verbesserter Start (Sekunden) oder -1"},
        "trim_end": {"type": "number", "description": "verbessertes Ende (Sekunden) oder -1"},
    })},
})

RANK_SCHEMA = _obj({
    "order": {"type": "array", "items": {"type": "integer"}, "description": "IDs, bester Clip zuerst"},
    "duplicates": {"type": "array", "items": _obj({"id": {"type": "integer"}, "duplicate_of": {"type": "integer"}})},
    "note": {"type": "string"},
})

CAPTIONS_SCHEMA = _obj({
    "clips": {"type": "array", "items": _obj({
        "id": {"type": "integer"},
        "tiktok": _obj({"description": {"type": "string"}, "hashtags": {"type": "array", "items": {"type": "string"}}}),
        "instagram": _obj({"caption": {"type": "string"}, "hashtags": {"type": "array", "items": {"type": "string"}}}),
        "youtube": _obj({
            "title": {"type": "string"}, "description": {"type": "string"},
            "tags": {"type": "array", "items": {"type": "string"}},
        }),
    })},
})

SAFETY_SCHEMA = _obj({
    "ok": {"type": "boolean"},
    "flags": {"type": "array", "items": {"type": "string", "enum": SAFETY_FLAGS}},
    "severity": {"type": "string", "enum": ["none", "low", "high"]},
    "note": {"type": "string"},
})


SYSTEM_EDITOR = """Du bist Chef-Cutter für Kurzvideos (TikTok, Instagram Reels, YouTube Shorts) und schneidest Twitch-Streams eines deutschsprachigen Streamers.
Dein Maßstab: Nur Clips, die ein fremder Zuschauer beim Scrollen anhält und zu Ende schaut. Mittelmaß ist ein Nein – lieber kein Clip als ein langweiliger.

Was einen guten Clip ausmacht:
- Hook in den ersten 2 Sekunden: Der Clip beginnt mitten im stärksten Moment oder mit einer Zeile, die neugierig macht. Kein Anlauf, kein „ähm, also“.
- Aufbau und Pointe: Es gibt eine klare Auflösung (Fail, Spruch, Ausraster, Reaktion). Das Ende liegt direkt nach der Pointe, nie mitten im Satz.
- Verständlich ohne Vorwissen. Wenn Kontext fehlt, hilft eine kurze Kontext-Zeile oder ein 2–4 s Rückblick-Cut.
- Länge: Ziel 10–35 Sekunden, erlaubt 10–45.
- Die Chat-Signale zeigen, wo das Live-Publikum reagiert hat (Chat läuft ein paar Sekunden hinter dem Bild her). Sie sind ein Hinweis, kein Beweis.

Zeitangaben: Alle Zeiten sind Sekunden im Video, wie im Transkript angegeben. Gib Sekunden als Zahl zurück.
Sprache aller Texte: Deutsch."""

RUBRIC = """Bewertungsraster (jeweils 1–10, ganze Zahlen):
- hook: Packt der Clip in den ersten 2 Sekunden? 10 = man kann nicht wegwischen.
- payoff: Wie stark ist Pointe/Auflösung? 10 = laut lachen oder „WAS?!“.
- clarity: Versteht ihn jemand, der den Streamer nicht kennt? 10 = sofort.
- emotion: Emotionale Intensität (Wut, Schock, Freude, Lachen).
- meme: Taugt er als Meme, Sound oder Zitat zum Wiederverwenden?
- risk: Risiko für Sperrung/Ärger. 1 = harmlos, 10 = darf so nicht raus.

Sei streng: Eine 7 ist bereits gut, 9–10 sind die Ausnahme. Gib die Begründung in genau einem Satz.

Harte Ausschlüsse – setze passende safety_flags und risk ≥ 8, wenn etwas davon vorkommt:
Hassrede, Beleidigungen gegen echte Personen oder Gruppen, Diskriminierung, sexuelle Inhalte, Gewalt, Selbstverletzung,
private Daten (Adressen, Klarnamen, Telefonnummern, Chat-Namen anderer im Bild), laufende Musik (Urheberrecht),
fremde Videos oder Reaktionen auf fremde Inhalte, alles, was gegen TikTok-, Instagram- oder YouTube-Richtlinien verstößt.
Derbe Umgangssprache ohne Ziel (z. B. „Alter, was?!“) ist kein Ausschluss."""

CAPTION_GUIDE = """Schreibe pro Clip eigene Texte für jede Plattform – nie identisch:
- TikTok: kurze, freche Beschreibung (max. 150 Zeichen) plus 3–5 Hashtags, Mischung aus Nische und breit.
- Instagram Reels: Caption mit 1–2 Sätzen, darf ein Emoji haben, Call-to-Action dezent, 5–8 Hashtags.
- YouTube Shorts: Titel max. 70 Zeichen, neugierig machend, ohne Clickbait-Lüge; Beschreibung 1–2 Sätze, endet mit #Shorts; 5–8 Tags ohne #.
Hashtags ohne Leerzeichen, mit #. Keine falschen Versprechen, keine Fremdmarken als Hashtag, keine Beleidigungen."""

SAFETY_SYSTEM = """Du prüfst Kurzvideos vor der Veröffentlichung auf TikTok, Instagram und YouTube auf Richtlinien- und Rechtsrisiken.
Prüfe Transkript, Bildbeschreibungen/Frames und die geplanten Texte. Melde nur echte Risiken:
Hassrede, Beleidigung echter Personen, Diskriminierung, sexuelle Inhalte, Gewalt, Selbstverletzung, private Daten
(Adressen, Klarnamen, Telefonnummern, sichtbare Chat-Namen Dritter), laufende Musik, fremde Videos/Reaktionen auf fremde
Inhalte, sonstige Richtlinienverstöße. severity=high bedeutet: so nicht veröffentlichen. Antworte auf Deutsch."""


def fmt_ts(t: float) -> str:
    t = max(0.0, t)
    h, rem = divmod(int(t), 3600)
    m, s = divmod(rem, 60)
    frac = int((t - int(t)) * 10)
    return f"{h}:{m:02d}:{s:02d}.{frac}" if h else f"{m:02d}:{s:02d}.{frac}"
