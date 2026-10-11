// Vorschauleiste und Ziel relativ zur Fahrtrichtung (ohne DOM, testbar).

import type { Match, StreetMatcher } from './matcher';
import type { HouseNumber, Street } from './types';
import { distanceM } from './core';

export type Side = 'left' | 'right';

export interface Upcoming {
  n: HouseNumber;
  /** Meter voraus entlang der Straße */
  ahead: number;
}

export interface Preview {
  left: Upcoming[];
  right: Upcoming[];
}

/** Bis zu diesem Abstand zur Straße (m) zählt ein Haus zur Straße (zweite Reihe inklusive). */
const MAX_OFFSET = 120;
/** Ein Haus gilt bis so viele Meter hinter dem Fahrzeug noch als „hier“ (nicht vorbei). */
const BESIDE = 3;

/** Seite einer Hausnummer relativ zur Fahrtrichtung. */
export function sideOf(cross: number, dir: 1 | -1): Side {
  return cross * dir > 0 ? 'left' : 'right';
}

/**
 * Die nächsten Hausnummern voraus, getrennt nach linker und rechter Straßenseite.
 * Kehrt man um (dir wechselt), drehen sich Seiten und Reihenfolge automatisch mit.
 */
export function upcomingNumbers(matcher: StreetMatcher, m: Match | null, count = 3): Preview | null {
  if (!m?.street || m.dir === 0) return null;
  const dir = m.dir;
  const out: Preview = { left: [], right: [] };
  const items = matcher
    .numbersOnLines(m.street)
    .filter((x) => x.line === m.line && x.dist <= MAX_OFFSET)
    .map((x) => ({ x, ahead: (x.s - m.s) * dir }))
    .filter((e) => e.ahead >= -BESIDE)
    .sort((a, b) => a.ahead - b.ahead);
  const seen = { left: new Set<string>(), right: new Set<string>() };
  for (const { x, ahead } of items) {
    const side = sideOf(x.cross, dir);
    const list = out[side];
    if (list.length >= count || seen[side].has(x.n.norm)) continue;
    seen[side].add(x.n.norm);
    list.push({ n: x.n, ahead: Math.max(0, ahead) });
  }
  return out;
}

export interface TargetInfo {
  /** ahead: noch vor einem; passed: vorbeigefahren; here: daneben; other: andere Straße; unknown: Richtung unklar */
  kind: 'ahead' | 'passed' | 'here' | 'other' | 'unknown';
  /** Meter entlang der Straße (ahead/passed) bzw. Luftlinie */
  distance: number;
  side: Side | null;
  /** Führung zur Einfahrt (Haus in zweiter Reihe) statt zum Haus */
  viaDriveway: boolean;
}

/** Ab so vielen Metern hinter dem Fahrzeug gilt das Ziel als vorbeigefahren. */
export const PASSED_M = 8;

/**
 * Lage des Ziels relativ zum Fahrzeug. Gibt es eine Einfahrt, wird zu ihrer Abzweigung
 * geführt; die Seite ergibt sich dann aus der Richtung der Einfahrt.
 */
export function targetInfo(
  matcher: StreetMatcher,
  m: Match | null,
  target: { lat: number; lon: number; street: Street },
  driveway: { junction: [number, number]; away: [number, number] } | null = null,
): TargetInfo | null {
  if (!m) return null;
  const straight = distanceM(m.pos[0], m.pos[1], target.lat, target.lon);
  if (!m.street || m.street.id !== target.street.id) {
    return { kind: 'other', distance: straight, side: null, viaDriveway: false };
  }
  const ref = driveway ? driveway.junction : ([target.lat, target.lon] as [number, number]);
  const pr = matcher.projectOn(m.street, m.line, ref[0], ref[1]);
  if (!pr || pr.dist > MAX_OFFSET) return { kind: 'other', distance: straight, side: null, viaDriveway: false };
  if (m.dir === 0) return { kind: 'unknown', distance: straight, side: null, viaDriveway: !!driveway };
  // Seite: beim Haus aus seiner Lage, bei einer Einfahrt aus der Richtung, in die sie abzweigt
  let cross = pr.cross;
  if (driveway) {
    const pa = matcher.projectOn(m.street, m.line, driveway.away[0], driveway.away[1]);
    if (pa) cross = pa.cross;
  }
  const side = sideOf(cross, m.dir);
  const along = (pr.s - m.s) * m.dir;
  const refDist = distanceM(m.pos[0], m.pos[1], ref[0], ref[1]);
  if (along < -PASSED_M) return { kind: 'passed', distance: -along, side, viaDriveway: !!driveway };
  if (along <= PASSED_M && refDist < 40) return { kind: 'here', distance: Math.max(0, along), side, viaDriveway: !!driveway };
  return { kind: 'ahead', distance: Math.max(0, along), side, viaDriveway: !!driveway };
}
