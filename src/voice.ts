// Freihand-Ablauf: zuhören, Adresse erkennen, direkt Ergebnis zeigen.

import { listenOnce, speechSupported, stopListening } from './speech';
import { parseSpokenAddress } from './speechparse';
import { editDistance, normStreet, preferNearby, searchStreets } from './core';
import { gps } from './gps';
import { state } from './data';
import { h, overlay, toast } from './ui/dom';
import type { Street } from './types';

export { speechSupported };

/** Findet die Straße zu einem gesprochenen Namen; null wenn zu unsicher. */
export function matchSpokenStreet(spoken: string): Street | null {
  const q = normStreet(spoken);
  if (q.length < 3) return null;
  // Gleichnamige Straßen: die dem Standort nächste zuerst
  const cands = preferNearby(searchStreets(state.index, spoken, 8), gps.fix ? [gps.fix.lat, gps.fix.lon] : null);
  for (const s of cands) {
    if (s.norm === q || s.norm.startsWith(q) || q.startsWith(s.norm)) return s;
    const d = editDistance(q, s.norm, 4);
    if (d <= Math.max(1, Math.floor(s.norm.length * 0.2))) return s;
  }
  return null;
}

export interface VoiceResult {
  street: Street | null;
  number: string | null;
  heard: string;
}

/** Hört zu und gibt Straße/Nummer zurück (oder null bei Abbruch/Fehler). */
export async function listenForAddress(hint = 'z. B. „Elbuferstraße zweiundvierzig“'): Promise<VoiceResult | null> {
  let closed = false;
  const close = overlay(
    h(
      'div',
      { class: 'listening' },
      h('div', { class: 'mic-pulse' }, '🎤'),
      h('p', { class: 'big-text' }, 'Ich höre zu …'),
      h('p', { class: 'muted' }, hint),
      h(
        'button',
        {
          class: 'btn big',
          onClick: () => {
            closed = true;
            stopListening();
            close();
          },
        },
        'Abbrechen',
      ),
    ),
  );
  try {
    const alts = await listenOnce();
    if (closed) return null;
    close();
    let fallback: VoiceResult | null = null;
    for (const alt of alts) {
      const p = parseSpokenAddress(alt);
      if (!p.street && p.number) {
        // Nur Nummer: gilt für die bereits gewählte Straße
        if (!fallback || !fallback.street) fallback = { street: null, number: p.number, heard: alt };
        continue;
      }
      const street = matchSpokenStreet(p.street);
      if (street && p.number) return { street, number: p.number, heard: alt };
      if (street && (!fallback || !fallback.street)) fallback = { street, number: null, heard: alt };
    }
    return fallback ?? { street: null, number: null, heard: alts[0] ?? '' };
  } catch (e) {
    if (!closed) {
      close();
      toast((e as Error).message + ' Bitte die Tastatur benutzen.');
    }
    return null;
  }
}
