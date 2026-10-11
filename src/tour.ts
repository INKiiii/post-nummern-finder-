// „Meine Tour“: die Straßen der eigenen Tour, in Teil A und B, in Fahrreihenfolge.
// Einmal einrichten, danach bevorzugt der Straßenbezug diese Straßen.
// Zusätzlich ein lokaler Zähler, wie oft (an wie vielen Tagen) eine Straße genutzt wurde –
// nur der Straßenname, nie ein Bewegungsverlauf.

import { kvGet, kvSet } from './db';
import { normStreet } from './core';
import type { Index, Street } from './types';

export type Part = 'A' | 'B';

export interface TourStreet {
  /** Straßen-ID beim Hinzufügen (kann sich nach Datenaktualisierung ändern) */
  streetId: string;
  name: string;
  place: string;
  plz: string;
  part: Part;
}

export interface Tour {
  streets: TourStreet[];
  first: Part;
}

export interface StreetUse {
  name: string;
  place: string;
  days: number;
  lastDay: string;
}

/** Ab so vielen Tagen Nutzung schlägt die App vor, eine Straße zur Tour hinzuzufügen. */
export const SUGGEST_DAYS = 3;

let tour: Tour = { streets: [], first: 'A' };
let usage: Record<string, StreetUse> = {};
const listeners = new Set<() => void>();

export async function loadTour() {
  tour = await kvGet<Tour>('tour', { streets: [], first: 'A' });
  usage = await kvGet<Record<string, StreetUse>>('streetUse', {});
}

export function getTour(): Tour {
  return tour;
}

export function onTourChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function save() {
  await kvSet('tour', tour);
  for (const l of listeners) l();
}

const keyOf = (s: { name: string; place: string }) => `${normStreet(s.name)}|${s.place}`;

/** Eine Tour-Straße im aktuellen Index finden (ID, sonst Name + Ort, sonst Name). */
export function resolveTourStreet(index: Index, t: TourStreet): Street | null {
  const byId = index.streets.get(t.streetId);
  if (byId) return byId;
  const same = index.byNorm.get(normStreet(t.name)) ?? [];
  return same.find((s) => s.place === t.place) ?? (same.length === 1 ? same[0] : null);
}

export function inTour(street: Street): TourStreet | null {
  return tour.streets.find((t) => t.streetId === street.id || keyOf(t) === keyOf(street)) ?? null;
}

/** Straßen in Fahrreihenfolge: der heute erste Teil zuerst. */
export function orderedTour(): TourStreet[] {
  const second: Part = tour.first === 'A' ? 'B' : 'A';
  return [...tour.streets.filter((t) => t.part === tour.first), ...tour.streets.filter((t) => t.part === second)];
}

/** IDs der Tour-Straßen im aktuellen Index (für den Straßenbezug). */
export function tourStreetIds(index: Index): Set<string> {
  const ids = new Set<string>();
  for (const t of tour.streets) {
    const s = resolveTourStreet(index, t);
    if (s) ids.add(s.id);
  }
  return ids;
}

/** Nächste Straße der Tour nach der angegebenen (in der heutigen Reihenfolge). */
export function nextTourStreet(index: Index, current: Street | null): { street: Street; t: TourStreet } | null {
  const list = orderedTour();
  if (!list.length) return null;
  const i = current ? list.findIndex((t) => resolveTourStreet(index, t)?.id === current.id) : -1;
  for (let k = i + 1; k < list.length; k++) {
    const s = resolveTourStreet(index, list[k]);
    if (s) return { street: s, t: list[k] };
  }
  return null;
}

export async function addToTour(street: Street, part: Part) {
  if (inTour(street)) return;
  tour.streets.push({ streetId: street.id, name: street.name, place: street.place, plz: street.plz, part });
  await save();
}

export async function removeFromTour(t: TourStreet) {
  tour.streets = tour.streets.filter((x) => x !== t);
  await save();
}

export async function setPart(t: TourStreet, part: Part) {
  t.part = part;
  // ans Ende des neuen Teils
  tour.streets = [...tour.streets.filter((x) => x !== t), t];
  await save();
}

/** Innerhalb des eigenen Teils nach oben (-1) oder unten (+1) verschieben. */
export async function move(t: TourStreet, delta: -1 | 1) {
  const same = tour.streets.filter((x) => x.part === t.part);
  const i = same.indexOf(t);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= same.length) return;
  const a = tour.streets.indexOf(same[i]);
  const b = tour.streets.indexOf(same[j]);
  [tour.streets[a], tour.streets[b]] = [tour.streets[b], tour.streets[a]];
  await save();
}

export async function setFirst(part: Part) {
  tour.first = part;
  await save();
}

/** Nutzung zählen (höchstens einmal pro Tag und Straße). Nur der Name wird gespeichert. */
export async function countUse(street: Street, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const k = keyOf(street);
  const u = usage[k] ?? { name: street.name, place: street.place, days: 0, lastDay: '' };
  if (u.lastDay === day) return;
  u.days++;
  u.lastDay = day;
  usage[k] = u;
  await kvSet('streetUse', usage);
}

/** Oft genutzte Straßen, die noch nicht in der Tour sind. */
export function tourSuggestions(index: Index): Street[] {
  const out: Street[] = [];
  for (const u of Object.values(usage)) {
    if (u.days < SUGGEST_DAYS) continue;
    const s = resolveTourStreet(index, { streetId: '', name: u.name, place: u.place, plz: '', part: 'A' });
    if (s && !inTour(s)) out.push(s);
  }
  return out;
}

/** Nur für Tests: Zustand setzen. */
export function _setState(t: Tour, u: Record<string, StreetUse> = {}) {
  tour = t;
  usage = u;
}
