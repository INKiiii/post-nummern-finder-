// Laufender Zustand der Zustellung: Straßenbezug (läuft immer mit, auch auf anderen
// Bildschirmen) und das optionale Ziel. Nichts davon wird als Verlauf gespeichert.

import { gps, type Fix } from './gps';
import { state } from './data';
import { StreetMatcher, type Match } from './matcher';
import type { Street } from './types';

export const matcher = new StreetMatcher(() => state.index);

export interface Target {
  streetId: string;
  number: string;
}

let target: Target | null = null;
let last: Match | null = null;
const listeners = new Set<(m: Match | null, fix: Fix | null) => void>();
let started = false;

/** Straßenbezug an das GPS hängen (einmal beim Start). */
export function startSession() {
  if (started) return;
  started = true;
  gps.subscribe((fix) => {
    if (fix) last = matcher.update(fix);
    for (const l of listeners) l(last, fix);
  });
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
}
