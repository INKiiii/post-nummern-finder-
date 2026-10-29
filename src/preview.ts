// Vorschauleiste und Ziel relativ zur Fahrtrichtung (ohne DOM, testbar).

import type { Match, StreetMatcher } from './matcher';
import type { HouseNumber, Street } from './types';
import { distanceM, findHouse, makeProjection, parseHouseNumber, projectOnLine } from './core';

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

/** Lage eines Hauses der aktuellen Straße relativ zum Fahrzeug (für die Karte) */
export interface HouseMark {
  side: Side;
  /** Meter voraus entlang der Straße (negativ: schon vorbei) */
  ahead: number;
  /** Nächstes Haus auf seiner Seite (steht oben groß) */
  next: boolean;
}

/**
 * Seite und Abstand aller Häuser der aktuellen Straße (Linie, auf der man fährt). Die beiden
 * Häuser, die oben als nächste stehen, sind markiert: Die Karte hebt sie farbig hervor.
 */
export function houseMarks(matcher: StreetMatcher, m: Match | null, p: Preview | null): Map<HouseNumber, HouseMark> | null {
  if (!m?.street || m.dir === 0) return null;
  const next = new Set<HouseNumber>();
  if (p?.left[0]) next.add(p.left[0].n);
  if (p?.right[0]) next.add(p.right[0].n);
  const out = new Map<HouseNumber, HouseMark>();
  for (const x of matcher.numbersOnLines(m.street)) {
    if (x.line !== m.line || x.dist > MAX_OFFSET) continue;
    out.set(x.n, { side: sideOf(x.cross, m.dir), ahead: (x.s - m.s) * m.dir, next: next.has(x.n) });
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

/** Hinweis oben im Kopf, bevor man an einem schwer erreichbaren Ziel vorbeifährt */
export interface AccessHint {
  /** groß: „EINFAHRT LINKS“, „ZUGANG ÜBER DEN HOF“, „ZWEITE REIHE RECHTS“ … */
  title: string;
  /** klein darunter: „Haus 70 m von der Straße · Haus-Info: lange Auffahrt“ */
  detail: string;
  side: Side | null;
  /** am Ziel bzw. an der Einfahrt (dann „JETZT“ statt Meter) */
  now: boolean;
  /** Meter bis zur Einfahrt bzw. zum Haus entlang der Straße */
  distance: number;
}

/** Ab diesem Abstand zur Straße (m) liegt ein Haus in zweiter Reihe. */
export const SECOND_ROW_M = 20;
/** Der Hinweis erscheint ab so vielen Metern vor dem Ziel. */
export const HINT_AHEAD_M = 300;

const ACCESS_TITLE: Record<string, string> = {
  'über den Hof': 'ZUGANG ÜBER DEN HOF',
  'Zugang von hinten': 'ZUGANG VON HINTEN',
  'Haus liegt hinten': 'HAUS LIEGT HINTEN',
  'lange Auffahrt': 'LANGE AUFFAHRT',
};

/**
 * Hinweis für Ziele, die man von der Straße aus leicht verpasst: bekannte Einfahrt, Haus in
 * zweiter Reihe oder ein Zugang laut Haus-Info. Nur solange das Ziel vor einem liegt
 * (höchstens 300 m) – danach übernimmt „Zurück … m“.
 */
export function accessHint(ti: TargetInfo | null, o: { offStreet: number | null; access: string | null }): AccessHint | null {
  if (!ti || (ti.kind !== 'ahead' && ti.kind !== 'here') || ti.distance > HINT_AHEAD_M) return null;
  const access = o.access && o.access !== 'direkt an der Straße' ? o.access : null;
  const secondRow = o.offStreet !== null && o.offStreet > SECOND_ROW_M;
  if (!ti.viaDriveway && !access && !secondRow) return null;
  const seite = ti.side === 'left' ? 'LINKS' : ti.side === 'right' ? 'RECHTS' : '';
  let title: string;
  let accessUsed = false;
  if (ti.viaDriveway) title = `EINFAHRT ${seite}`.trim();
  else if (access) {
    title = ACCESS_TITLE[access] ?? access.toUpperCase();
    accessUsed = true;
  } else title = `ZWEITE REIHE ${seite}`.trim();
  const detail: string[] = [];
  if (secondRow) detail.push(`Haus ${Math.round(o.offStreet!)} m von der Straße`);
  if (access && !accessUsed) detail.push(`Haus-Info: ${access}`);
  return { title, detail: detail.join(' · '), side: ti.side, now: ti.kind === 'here' || ti.distance <= 15, distance: ti.distance };
}

export interface Steps {
  minus2: string | null;
  plus2: string | null;
  opposite: string | null;
}

/**
 * Schnelltasten für den nächsten Brief auf derselben Straße: Nummer −2, +2 und die Nummer
 * gegenüber (geometrisch: nächstes Haus auf der anderen Straßenseite; sonst ±1).
 */
export function quickSteps(street: Street, label: string): Steps {
  const p = parseHouseNumber(label);
  if (p.num === null) return { minus2: null, plus2: null, opposite: null };
  const n = p.num;
  return {
    minus2: n - 2 >= 1 ? String(n - 2) : null,
    plus2: String(n + 2),
    opposite: oppositeNumber(street, label),
  };
}

export function oppositeNumber(street: Street, label: string): string | null {
  const p = parseHouseNumber(label);
  if (p.num === null) return null;
  const res = findHouse(street, label, null);
  if (Number.isFinite(res.lat) && street.lines.some((l) => l.length >= 2)) {
    const proj = makeProjection(res.lat, res.lon);
    // nächste Linie zum Ziel
    let best: { xy: number[][]; r: NonNullable<ReturnType<typeof projectOnLine>> } | null = null;
    for (const l of street.lines) {
      if (l.length < 2) continue;
      const xy = l.map(([la, lo]) => proj.toXY(la, lo));
      const r = projectOnLine([0, 0], xy);
      if (r && (!best || r.dist < best.r.dist)) best = { xy, r };
    }
    if (best && best.r.dist < 150) {
      const mySide = Math.sign(best.r.cross);
      let pick: { label: string; d: number } | null = null;
      for (const x of street.numbers) {
        if (x.num === null) continue;
        const q = projectOnLine(proj.toXY(x.lat, x.lon), best.xy);
        if (!q || q.dist > 150 || Math.sign(q.cross) === mySide || Math.sign(q.cross) === 0) continue;
        const d = Math.abs(q.s - best.r.s);
        if (d < 60 && (!pick || d < pick.d)) pick = { label: x.label, d };
      }
      if (pick) return pick.label;
    }
  }
  // Ohne Lage: andere Straßenseite = andere Parität, nächste Nummer
  const other = street.numbers.filter((x) => x.num !== null && x.num % 2 !== p.num! % 2);
  if (!other.length) return null;
  other.sort((a, b) => Math.abs(a.num! - p.num!) - Math.abs(b.num! - p.num!));
  return other[0].label;
}
