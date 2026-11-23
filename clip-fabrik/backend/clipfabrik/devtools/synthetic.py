"""Synthetisches Stream-Material für Tests und Demo (ffmpeg testsrc + Sprache + Chat)."""

from __future__ import annotations

import subprocess
from pathlib import Path

def has_flite() -> bool:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True)
    return " flite " in r.stdout


SCRIPT = [
    {"start": 4.0, "end": 11.0, "text": "Okay Leute, heute versuchen wir den schwersten Sprung im ganzen Spiel."},
    {"start": 13.0, "end": 20.0, "text": "Ich hab das schon zwanzig Mal probiert und es klappt einfach nicht."},
    {"start": 22.0, "end": 30.0, "text": "Jetzt aber wirklich, ich konzentriere mich, gleich passiert es."},
    {"start": 32.0, "end": 38.5, "text": "Nein nein nein, was ist das denn, alter, das gibt's nicht!"},
    {"start": 42.0, "end": 49.0, "text": "Ich kann nicht mehr, ich sterbe, das war der krasseste Fail des Tages."},
    {"start": 51.0, "end": 57.0, "text": "Okay, wir machen weiter, nächster Versuch nach der Pause."},
]


def make_test_video(path: Path, duration: float = 60.0, *, size: str = "1280x720", loud_at: float = 38.6) -> Path:
    """Synthetisches Stream-Video: testsrc2-Bild, leises Rauschen, Sprache (flite) an den Skriptzeiten,
    lauter Ausraster bei ``loud_at`` und danach Stille (Pointe)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    inputs = ["-f", "lavfi", "-i", f"testsrc2=s={size}:r=30:d={duration}",
              "-f", "lavfi", "-i", f"anoisesrc=d={duration}:c=pink:a=0.004:r=48000"]
    filters = []
    labels = ["[1:a]"]
    idx = 2
    if has_flite():
        for item in SCRIPT:
            text = "".join(ch for ch in item["text"] if ch.isalnum() or ch == " ")
            inputs += ["-f", "lavfi", "-i", f"flite=text='{text}':voice=kal16"]
            ms = int(item["start"] * 1000)
            filters.append(f"[{idx}:a]aresample=48000,volume=2.0,adelay={ms}|{ms}[s{idx}]")
            labels.append(f"[s{idx}]")
            idx += 1
    else:
        for item in SCRIPT:
            inputs += ["-f", "lavfi", "-i", f"sine=f=220:d={item['end'] - item['start']}:r=48000"]
            ms = int(item["start"] * 1000)
            filters.append(f"[{idx}:a]volume=0.3,adelay={ms}|{ms}[s{idx}]")
            labels.append(f"[s{idx}]")
            idx += 1
    inputs += ["-f", "lavfi", "-i", "sine=f=660:d=2.4:r=48000"]
    ms = int(loud_at * 1000)
    filters.append(f"[{idx}:a]volume=6,adelay={ms}|{ms}[loud]")
    labels.append("[loud]")
    filters.append("".join(labels) + f"amix=inputs={len(labels)}:duration=first:normalize=0,atrim=0:{duration}[aout]")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs, "-filter_complex", ";".join(filters),
           "-map", "0:v", "-map", "[aout]", "-c:v", "libx264", "-preset", "ultrafast", "-g", "60", "-c:a", "aac", "-shortest", str(path)]
    subprocess.run(cmd, check=True)
    return path


def chat_burst(start_wall: float, at: float, n: int = 40, text: str = "KEKW KEKW KEKW") -> list[dict]:
    """Chat-Ereignisse: ruhiger Grundchat + Spitze bei ``at`` Sekunden nach Start."""
    events = []
    for i in range(0, 60, 4):
        events.append({"t": start_wall + i, "kind": "msg", "user": f"viewer{i}", "text": "hallo zusammen"})
    for k in range(n):
        events.append({"t": start_wall + at + k * 0.12, "kind": "msg", "user": f"user{k}", "text": text if k % 3 else "OMEGALUL WAS"})
    return events


