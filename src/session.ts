// Laufender Zustand der Zustellung: Straßenbezug (läuft immer mit, auch auf anderen
// Bildschirmen) und das optionale Ziel. Nichts davon wird als Verlauf gespeichert.

import { gps, type Fix } from './gps';
import { state } from './data';
import { StreetMatcher, type Match } from './matcher';
import { activePartIds, noteStreet, onTourChange, tourStreetIds } from './tour';
import type { Index, Street } from './types';

export const matcher = new StreetMatcher(() => state.index);

export interface Target {
  streetId: string;
  number: string;
}

const TARGET_KEY = 'hnf-target';
/** Ziel übersteht ein Neuladen (z. B. App-Update), aber nicht länger als 3 Stunden. */
function loadTarget(): Target | null {
  try {
    const t = JSON.parse(localStorage.getItem(TARGET_KEY) ?? 'null');
    if (t && typeof t.streetId === 'string' && typeof t.number === 'string' && Date.now() - (t.at ?? 0) < 3 * 3600e3) return { streetId: t.streetId, number: t.number };
  } catch {
    /* egal */
  }
  return null;
}
let target: Target | null = typeof localStorage !== 'undefined' ? loadTarget() : null;
let last: Match | null = null;
const listeners = new Set<(m: Match | null, fix: Fix | null) => void>();
let started = false;
let preferredFor: Index | null = null;

/** Tour-Straßen im Straßenbezug bevorzugen (nach Änderung der Tour oder der Daten). */
export function refreshPreferred() {
  matcher.preferred = tourStreetIds(state.index);
  matcher.activePart = activePartIds(state.index);
  preferredFor = state.index;
}

/** Straßenbezug an das GPS hängen (einmal beim Start). */
export function startSession() {
  if (started) return;
  started = true;
  refreshPreferred();
  onTourChange(refreshPreferred);
  gps.subscribe((fix) => {
    if (preferredFor !== state.index) refreshPreferred();
    if (fix) {
      last = matcher.update(fix);
      // Wechsel von Teil A nach B (oder umgekehrt): Vorrang folgt dem Teil, in dem man fährt
      if (noteStreet(last.street)) matcher.activePart = activePartIds(state.index);
    }
    for (const l of listeners) l(last, fix);
  });
}

/** Straße von Hand festlegen (falsch erkannt) und sofort anzeigen. */
export function forceStreet(street: Street) {
  matcher.force(street);
  last = matcher.current ?? last;
  for (const l of listeners) l(last, gps.fix);
}

export function currentMatch(): Match | null {
  return last;
}

/** Aktuell erkannte Straße (falls nah genug). */
export function currentStreet(): Street | null {
  return last?.street ?? null;
}

export function onMatch(fn: (m: Match | null, fix: Fix | null) => void): () => void {
  listeners.add(fn);
  if (last || gps.fix) queueMicrotask(() => fn(last, gps.fix));
  return () => listeners.delete(fn);
}

export function getTarget(): Target | null {
  return target;
}

export function setTarget(t: Target | null) {
  target = t;
  try {
    if (t) localStorage.setItem(TARGET_KEY, JSON.stringify({ ...t, at: Date.now() }));
    else localStorage.removeItem(TARGET_KEY);
  } catch {
    /* egal */
  }
}
