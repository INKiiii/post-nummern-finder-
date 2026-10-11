// Regeln für Zoom und Beschriftung der Karte (ohne DOM, damit testbar).

import { parseHouseNumber } from './core';
import type { HouseNumber } from './types';

/** Maximale Sicht voraus (m) und Abstand, ab dem alle Nummern beschriftet werden. */
export const AHEAD_MAX = 120;
export const AHEAD_MIN = 35;
export const LABEL_NEAR_CAR = 40;

/**
 * Wie weit die Karte vor dem Auto zeigt: höchstens 120 m, beim Annähern enger.
 * Bei 30 m Restweg etwa 50 m Sicht, bei 10 m etwa 35 m.
 */
export function followAhead(distanceToTarget: number): number {
  if (!Number.isFinite(distanceToTarget)) return AHEAD_MAX;
  return Math.max(AHEAD_MIN, Math.min(AHEAD_MAX, distanceToTarget * 1.25 + 10));
}

/**
 * Hausnummern, die immer beschriftet werden: die Zielnummer und je 3 Nachbarn davor und
 * dahinter auf derselben Straßenseite (gerade/ungerade). Gibt es auf dieser Seite keine,
 * werden die nächsten Nummern beider Seiten genommen.
 */
export function forcedLabels(numbers: HouseNumber[], targetLabel: string, perSide = 3): Set<HouseNumber> {
  const out = new Set<HouseNumber>();
  const t = parseHouseNumber(targetLabel);
  if (t.num === null) return out;
  for (const n of numbers) if (n.norm === t.norm) out.add(n);
  const numeric = numbers.filter((n) => n.num !== null && n.norm !== t.norm);
  const same = numeric.filter((n) => n.num! % 2 === t.num! % 2);
  const pool = same.length ? same : numeric;
  // Je Hausnummer nur einen Eintrag zählen (12 und 12a gelten als eine Position)
  const pick = (list: HouseNumber[]) => {
    const seen = new Set<number>();
    for (const n of list) {
      if (!seen.has(n.num!) && seen.size >= perSide) break;
      seen.add(n.num!);
      out.add(n);
    }
  };
  pick(pool.filter((n) => n.num! < t.num! || (n.num === t.num && n.suffix < t.suffix)).sort((a, b) => b.num! - a.num!));
  pick(pool.filter((n) => n.num! > t.num! || (n.num === t.num && n.suffix > t.suffix)).sort((a, b) => a.num! - b.num!));
  return out;
}

/**
 * Punkt am Kartenrand für einen Pfeil zu einem Ziel außerhalb der Ansicht.
 * @param from Startpunkt auf dem Bildschirm (Auto oder Mitte)
 * @param angleDeg Richtung zum Ziel auf dem Bildschirm (0 = oben, im Uhrzeigersinn)
 */
export function edgePoint(from: [number, number], angleDeg: number, w: number, h: number, inset: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const x0 = Math.min(w - inset, Math.max(inset, from[0]));
  const y0 = Math.min(h - inset, Math.max(inset, from[1]));
  let t = Infinity;
  if (dx > 1e-9) t = Math.min(t, (w - inset - x0) / dx);
  if (dx < -1e-9) t = Math.min(t, (inset - x0) / dx);
  if (dy > 1e-9) t = Math.min(t, (h - inset - y0) / dy);
  if (dy < -1e-9) t = Math.min(t, (inset - y0) / dy);
  if (!Number.isFinite(t)) t = 0;
  return [x0 + dx * t, y0 + dy * t];
}
