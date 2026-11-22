"""Unit-Tests: Zeitberechnung, Parsing, Verpacken, Dedupe, Scoring, Signale."""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac

import numpy as np
import pytest

from clipfabrik.analysis.audio import AudioAnalysis, zscores
from clipfabrik.analysis.chat import ChatEvent, LiveSpikeDetector, build_series, message_features
from clipfabrik.analysis.signals import Signal, audio_signals, build_windows, chat_signals, marker_signals, transcript_signals
from clipfabrik.analysis.timeline import Timeline
from clipfabrik.analysis.transcribe import Transcript, TSegment, TWord
from clipfabrik.highlights.dedupe import DedupeItem, dedupe, diversify, overlap_ratio, text_similarity
from clipfabrik.highlights.packaging import build_cuts, map_words_to_output, package
from clipfabrik.highlights.scoring import is_hard_excluded, weighted_total
from clipfabrik.llm.ai import local_safety_scan, normalize_captions
from clipfabrik.llm.client import LLMError, cost_usd, parse_json, Usage
from clipfabrik.media.subtitles import chunk_words, fmt_ass_time, fmt_srt_time, px_to_libass_units, Word
from clipfabrik.twitch.eventsub import timestamp_fresh, verify_signature
from clipfabrik.twitch.irc import is_clip_command, parse_irc, to_event


# ------------------------------------------------------------------ Zeitberechnung
def test_timeline_maps_wall_to_offset_with_gap():
    t0 = 1_700_000_000.0
    segs = [(t0, 120.0, "a.ts", 0), (t0 + 120.4, 120.0, "b.ts", 0), (t0 + 300, 60.0, "c.ts", 1)]  # 60 s Lücke vor c
    tl = Timeline.from_segments(segs)
    assert tl.duration == pytest.approx(300.0)
    assert len(tl.gaps) == 1 and tl.gaps[0].seconds == pytest.approx(60.0) and tl.gaps[0].at == pytest.approx(240.0)
    assert tl.wall_to_offset(t0 + 10) == pytest.approx(10)
    assert tl.wall_to_offset(t0 + 130) == pytest.approx(130)  # Jitter von 0,4 s wird angeschlossen
    assert tl.wall_to_offset(t0 + 270, clamp=False) is None  # in der Lücke
    assert tl.wall_to_offset(t0 + 270) == pytest.approx(240)  # geklemmt auf Lückenende
    assert tl.wall_to_offset(t0 + 310) == pytest.approx(250)
    assert tl.offset_to_wall(250) == pytest.approx(t0 + 310)


def test_timeline_ranges_across_segments():
    t0 = 1000.0
    tl = Timeline.from_segments([(t0, 10.0, "a", 0), (t0 + 10, 10.0, "b", 0), (t0 + 20, 10.0, "c", 0)])
    assert tl.ranges_for(8, 22) == [("a", 8, 10), ("b", 0, 10), ("c", 0, 2)]


def test_timeline_keeps_durations_on_overlap():
    tl = Timeline.from_segments([(0.0, 10.0, "a", 0), (8.0, 10.0, "b", 0)])
    assert tl.duration == pytest.approx(20.0), "Dauer muss der Summe der Segmente entsprechen (concat)"


def test_time_formats():
    assert fmt_ass_time(3661.239) == "1:01:01.24"
    assert fmt_srt_time(62.5) == "00:01:02,500"
    assert px_to_libass_units(73, 1920) == 11
    assert px_to_libass_units(300, 1920) == 45


# ------------------------------------------------------------------ Verpacken
def _words(text: str, start: float, step: float = 0.4) -> list[TWord]:
    return [TWord(w, start + i * step, start + i * step + step * 0.8) for i, w in enumerate(text.split())]


def test_package_snaps_to_sentence_and_drops_fillers():
    words = (_words("Das ist ein langer Satz über nichts.", 0.0)
             + _words("Äh also ich springe jetzt da rüber und dann", 4.0)
             + _words("passiert es endlich wirklich!", 8.0)
             + _words("Danach redet er weiter über anderes.", 12.0))
    r = package(5.0, 9.0, words, target_min=3, target_max=35, hard_min=2)
    texts = [w.text for w in r.words]
    assert texts[0] == "ich", "Füllwörter am Anfang müssen weg"
    assert texts[-1] == "wirklich!", "Ende direkt nach der Pointe, nicht mitten im Satz"
    assert r.end <= 12.0


def test_package_never_ends_mid_sentence():
    words = _words("Ich sage dir jetzt was und das ist wichtig.", 0.0, step=0.5)
    r = package(0.0, 2.2, words, target_min=1, hard_min=1)
    assert r.words[-1].text == "wichtig."


def test_package_limits_length_and_keeps_punchline():
    words = []
    t = 0.0
    for i in range(20):
        words += _words(f"Satz Nummer {i} ist hier.", t)
        t += 3.0
    r = package(0.0, 60.0, words, punchline_at=58.0, target_max=35, hard_max=45)
    assert r.duration <= 35.5
    assert r.end >= 57.5, "Pointe am Ende muss erhalten bleiben"


def test_package_extends_short_clip():
    words = _words("Vorher passiert was.", 0.0) + _words("Kurzer Spruch!", 6.0)
    r = package(6.0, 7.0, words, target_min=8, target_max=35, hard_min=3)
    assert r.start <= 0.2 and r.duration >= 6


def test_package_keeps_silent_gameplay_moment():
    """Markierter Moment fast ohne Sprache darf nicht auf die paar Wörter schrumpfen."""
    words = [TWord("los", 0.0, 0.6), TWord("geht's!", 0.7, 1.2), TWord("weiter", 20.0, 20.6)]
    r = package(0.0, 16.0, words, target_min=10, media_duration=23)
    assert r.start == 0.0 and r.end == pytest.approx(16.0)


def test_map_words_with_context_cut():
    words = [TWord("vorher", 10.0, 10.5), TWord("jetzt", 50.0, 50.5), TWord("knall", 51.0, 51.4)]
    cuts = build_cuts((49.5, 52.0), (9.5, 11.0))
    assert cuts == [(9.5, 11.0), (49.5, 52.0)]
    out = map_words_to_output(words, cuts)
    assert [w["text"] for w in out] == ["vorher", "jetzt", "knall"]
    assert out[0]["start"] == pytest.approx(0.5)
    assert out[1]["start"] == pytest.approx(1.5 + 0.5)


def test_context_cut_rejected_if_overlapping():
    assert build_cuts((10.0, 20.0), (9.0, 12.0)) == [(10.0, 20.0)]


# ------------------------------------------------------------------ Dedupe / Vielfalt
def test_overlap_and_text_similarity():
    assert overlap_ratio(0, 10, 5, 20) == pytest.approx(0.5)
    assert overlap_ratio(0, 10, 20, 30) == 0
    assert text_similarity("Nein nein nein, das gibt es nicht", "nein nein nein das gibts nicht") > 0.7
    assert text_similarity("Er springt in den Abgrund", "Wir machen eine Pause für Essen") < 0.3


def test_dedupe_keeps_best_and_drops_same_moment_and_same_joke():
    items = [
        DedupeItem(1, 100, 120, "Der Sprung geht komplett daneben und er fällt runter", 8.0, "Fail"),
        DedupeItem(2, 105, 125, "Sprung geht daneben er fällt", 7.0, "Fail"),  # gleicher Moment
        DedupeItem(3, 900, 920, "Der Sprung geht komplett daneben und er fällt wieder runter", 7.5, "Fail"),  # gleicher Witz
        DedupeItem(4, 2000, 2020, "Raid kommt rein und alle schreien", 6.0, "Reaktion"),
    ]
    kept, dropped = dedupe(items)
    assert [k.id for k in kept] == [1, 4]
    assert dropped == {2: 1, 3: 1}


def test_diversify_avoids_same_category_back_to_back():
    texts = ["Er fällt vom Dach", "Auto explodiert plötzlich", "Spruch über Mathe", "Boss besiegt ihn sofort", "Raid mit Konfetti"]
    cats = ["Fail", "Fail", "Spruch", "Fail", "Reaktion"]
    items = [DedupeItem(i, i * 100, i * 100 + 10, texts[i], 9 - i, cats[i]) for i in range(5)]
    out = diversify(items)
    assert [i.id for i in out] == [0, 2, 1, 4, 3]
    assert out[0].id == 0, "Bester bleibt vorne"


# ------------------------------------------------------------------ Scoring / Ausschlüsse
def test_weighted_total_inverts_risk():
    w = {"hook": 1, "payoff": 1, "clarity": 1, "emotion": 1, "meme": 1, "risk": 1}
    safe = weighted_total({"hook": 8, "payoff": 8, "clarity": 8, "emotion": 8, "meme": 8, "risk": 1}, w)
    risky = weighted_total({"hook": 8, "payoff": 8, "clarity": 8, "emotion": 8, "meme": 8, "risk": 10}, w)
    assert safe > risky
    assert safe == pytest.approx((8 * 5 + 10) / 6, abs=0.01)


def test_hard_exclusions():
    assert is_hard_excluded({"risk": 8}, [])
    assert is_hard_excluded({"risk": 2}, ["private_daten"])
    assert not is_hard_excluded({"risk": 3}, [])


def test_local_safety_scan():
    assert "private_daten" in local_safety_scan("ruf mich an 0151 2345678")
    assert "private_daten" in local_safety_scan("ich wohne in der Hauptstraße 12")
    assert "urheberrecht_musik" in local_safety_scan("♪ la la la ♪")
    assert local_safety_scan("Alter, was war das denn?!") == []


def test_normalize_captions_never_identical():
    c = normalize_captions({"tiktok": {"description": "Wow", "hashtags": ["twitch", "#fyp"]},
                            "instagram": {"caption": "Wow", "hashtags": ["#twitch", "#fyp"]},
                            "youtube": {"title": "Wow", "description": "Krass", "tags": ["#twitch"]}})
    assert c["tiktok"]["hashtags"] == ["#twitch", "#fyp"]
    assert c["instagram"]["caption"] != c["tiktok"]["description"]
    assert c["instagram"]["hashtags"] != c["tiktok"]["hashtags"]
    assert "#Shorts" in c["youtube"]["description"]
    assert c["youtube"]["tags"] == ["twitch"]


# ------------------------------------------------------------------ Parsing
def test_parse_json_robust():
    assert parse_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_json('Hier: {"a": [1,2]} fertig') == {"a": [1, 2]}
    with pytest.raises(LLMError):
        parse_json("kein json")


def test_cost_calculation():
    u = Usage(input_tokens=1_000_000, cache_read=0, cache_write=0, output_tokens=100_000)
    assert cost_usd("claude-sonnet-5-5", u) == pytest.approx(2.0 + 1.0)


def test_irc_privmsg_with_tags():
    line = ("@badge-info=;badges=moderator/1,subscriber/12;display-name=ModMaus;emotes=25:0-4,6-10;mod=1;"
            "room-id=123;tmi-sent-ts=1700000000123 :modmaus!modmaus@modmaus.tmi.twitch.tv PRIVMSG #streamer :Kappa Kappa !clip")
    msg = parse_irc(line)
    assert msg.command == "PRIVMSG" and msg.params[0] == "#streamer"
    ev = to_event(msg)
    assert ev.user == "ModMaus" and ev.is_mod and ev.emotes == 2 and ev.t == pytest.approx(1700000000.123)
    assert not is_clip_command(ev)  # nicht am Anfang
    ev.text = "!clip"
    assert is_clip_command(ev)
    ev.is_mod = False
    assert not is_clip_command(ev), "!clip nur für Mods"
    assert is_clip_command(ev, my_login="modmaus"), "ich selbst darf immer"


def test_irc_usernotice_and_clearchat():
    raid = parse_irc("@msg-id=raid;msg-param-viewerCount=250;display-name=Raider;tmi-sent-ts=1700000000000 :tmi.twitch.tv USERNOTICE #streamer")
    ev = to_event(raid)
    assert ev.kind == "raid" and ev.viewers == 250
    to = to_event(parse_irc("@ban-duration=600;room-id=1;tmi-sent-ts=1700000000000 :tmi.twitch.tv CLEARCHAT #streamer :spammer"))
    assert to.kind == "timeout" and to.user == "spammer"
    ban = to_event(parse_irc("@room-id=1;tmi-sent-ts=1700000000000 :tmi.twitch.tv CLEARCHAT #streamer :troll"))
    assert ban.kind == "ban"
    shared = to_event(parse_irc("@room-id=1;source-room-id=2;display-name=x :x!x@x PRIVMSG #streamer :hallo"))
    assert shared.shared


def test_irc_tag_unescape():
    msg = parse_irc(r"@system-msg=Hallo\sWelt\:\sTest :tmi.twitch.tv NOTICE #c :x")
    assert msg.tags["system-msg"] == "Hallo Welt; Test"


def test_eventsub_signature():
    secret, mid, ts, body = "geheim123", "msg-1", "2026-11-22T10:00:00Z", b'{"x":1}'
    sig = "sha256=" + hmac.new(secret.encode(), (mid + ts).encode() + body, hashlib.sha256).hexdigest()
    assert verify_signature(secret, mid, ts, body, sig)
    assert not verify_signature(secret, mid, ts, body + b" ", sig)
    assert timestamp_fresh(ts, now=dt.datetime(2026, 11, 22, 10, 5))
    assert not timestamp_fresh(ts, now=dt.datetime(2026, 11, 22, 10, 20))


def test_transcript_roundtrip_and_shift():
    tr = Transcript("de", 10.0, [TSegment(1.0, 2.0, "Hallo Welt", [TWord("Hallo", 1.0, 1.4), TWord("Welt", 1.5, 2.0)])])
    tr2 = Transcript.from_dict(tr.to_dict()).shifted(100)
    assert tr2.words()[1].start == pytest.approx(101.5)
    assert tr2.text_between(100, 101.45) == "Hallo"


def test_chunk_words_breaks_on_punctuation():
    ws = [Word("Ja", 0, 0.2), Word("genau.", 0.2, 0.5), Word("Und", 0.6, 0.8), Word("dann", 0.8, 1.0), Word("kam", 1.0, 1.2), Word("es", 1.2, 1.4)]
    chunks = chunk_words(ws)
    assert [len(c) for c in chunks] == [2, 3, 1]


# ------------------------------------------------------------------ Signale
def test_chat_message_features():
    emote, caps = message_features("KEKW KEKW was", 0, {"KEKW"})
    assert emote == pytest.approx(2 / 3)
    assert message_features("ALTER WAS", 0, set())[1] == 1.0


def test_chat_spike_offline_series():
    start = 1000.0
    events = [ChatEvent(start + i, "msg", text="hi") for i in range(0, 300, 5)]
    events += [ChatEvent(start + 200 + k * 0.1, "msg", text="KEKW KEKW") for k in range(40)]
    series = build_series(events, start, 300, {"KEKW"})
    sigs = chat_signals(series, lambda w: w - start, lag=6)
    assert sigs, "Chat-Spitze nicht erkannt"
    best = max(sigs, key=lambda s: s.strength)
    assert 190 <= best.t <= 202
    assert "Emote-Spam" in best.detail


def test_live_spike_detector_with_cooldown():
    det = LiveSpikeDetector({"KEKW"}, window=6, min_msgs=8, cooldown=45)
    t = 0.0
    for i in range(60):
        det.feed(ChatEvent(t + i * 5, "msg", text="hallo"))
    assert det.check(300) is None
    for k in range(25):
        det.feed(ChatEvent(300 + k * 0.2, "msg", text="KEKW KEKW"))
    spike = det.check(305.5)
    assert spike is not None and spike.emote_ratio > 0.9
    assert det.check(310) is None, "Sperrzeit nach Spitze"


def test_live_spike_detector_raid():
    det = LiveSpikeDetector(set())
    det.feed(ChatEvent(0, "msg", text="x"))
    det.feed(ChatEvent(100, "raid", viewers=300))
    spike = det.check(102)
    assert spike is not None and "Raid" in spike.reason


def test_transcript_signals():
    words = _words("nein nein nein was ist das denn alter oh mein gott haha", 10.0)
    sigs = transcript_signals(words)
    types = {s.type for s in sigs}
    assert {"wiederholung", "reaktion", "gelächter"} <= types


def test_audio_signals_loudness_and_silence_after_punchline():
    loud = [-38.0] * 300
    for t in range(146, 150):
        loud[t] = -22.0  # Sprechen vor der Pointe
    loud[150] = -8.0
    for t in range(151, 154):
        loud[t] = -60.0
    aa = AudioAnalysis(loudness_db=loud, laughter=[0.0] * 300, silences=[(151.0, 153.5)])
    words = [TWord("krass", 149.0, 150.9)]
    sigs = audio_signals(aa, words)
    assert any(s.type == "lautstärke" and s.t == 150 for s in sigs)
    assert any(s.type == "stille_nach_pointe" for s in sigs)


def test_zscores_local():
    x = [0.0] * 500
    x[250] = 10.0
    z = zscores(x, window=120)
    assert z[250] > 3 and abs(z[100]) < 0.5


def test_build_windows_merges_and_caps():
    sigs = [Signal("chat", 100, 3.0), Signal("lautstärke", 108, 2.5), Signal("reaktion", 400, 2.0), Signal("chat", 401, 1.0)]
    ws = build_windows(sigs, 600, min_strength=1.5)
    assert len(ws) == 2
    assert {s.type for s in ws[0].signals} == {"chat", "lautstärke"}
    assert ws[0].strength > 3.0, "Bonus für mehrere Signalarten"
    many = [Signal("chat", float(t), 2.0 + (t % 7) / 10) for t in range(0, 36000, 60)]
    capped = build_windows(many, 36000, max_per_hour=10)
    assert len(capped) <= 100


def test_marker_windows_are_never_dropped():
    many = [Signal("chat", float(t), 4.0) for t in range(0, 3600, 60)]
    sigs = many + marker_signals([(1830.0, 40.0, "manual")])
    ws = build_windows(sigs, 3600, max_per_hour=5)
    assert any(any(s.type == "marker" for s in w.signals) for w in ws)
    mw = next(w for w in ws if any(s.type == "marker" for s in w.signals))
    assert mw.start <= 1830 - 40 and mw.end >= 1830


def test_laughter_heuristic_on_synthetic_audio(tmp_path):
    import wave

    from clipfabrik.analysis.audio import analyze_wav

    rate = 16000
    t = np.arange(rate * 6) / rate
    sig = 0.01 * np.random.default_rng(1).standard_normal(len(t))
    # 2 s „ha-ha-ha“: 5-Hz-Hüllkurve auf Rauschen
    seg = (t >= 2) & (t < 4)
    env = (np.sin(2 * np.pi * 5 * t[seg]) > 0).astype(float)
    sig[seg] += 0.35 * env * np.random.default_rng(2).standard_normal(seg.sum())
    p = tmp_path / "l.wav"
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((np.clip(sig, -1, 1) * 32767).astype(np.int16).tobytes())
    aa = analyze_wav(p)
    assert max(aa.laughter[2:4]) > 0.5
    assert max(aa.laughter[0:2]) < 0.2
