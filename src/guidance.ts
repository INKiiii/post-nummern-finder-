// Entfernung und Straßenseite aus Position und Fahrtrichtung.

import { bearingDeg, distanceM, makeProjection, projectOnLine, wrap180 } from './core';
import type { Street } from './types';

export type Side = 'links' | 'rechts' | 'geradeaus' | null;

export interface Guidance {
  distance: number;
  side: Side;
  behind: boolean;
  method: 'street' | 'bearing' | 'none';
}

/**
 * Bestimmt, auf welcher Seite das Ziel liegt.
 * Fährt man auf der Zielstraße, zählt die Straßenseite (auch in Kurven richtig);
 * sonst die Richtung zum Ziel relativ zur Fahrtrichtung.
 */
export function computeGuidance(
  user: { lat: number; lon: number; heading: number | null },
  target: { lat: number; lon: number },
  street: Street | null,
): Guidance {
  const distance = distanceM(user.lat, user.lon, target.lat, target.lon);
  if (user.heading === null || !Number.isFinite(user.heading)) {
    return { distance, side: null, behind: false, method: 'none' };
  }
  const h = (user.heading * Math.PI) / 180;
  const headingVec = [Math.sin(h), Math.cos(h)];
  const proj = makeProjection(user.lat, user.lon);
  const u = [0, 0];
  const t = proj.toXY(target.lat, target.lon);

  if (street) {
    let best: { line: number[][]; pu: NonNullable<ReturnType<typeof projectOnLine>> } | null = null;
    for (const l of street.lines) {
      if (l.length < 2) continue;
      const xy = l.map(([la, lo]) => proj.toXY(la, lo));
      const pu = projectOnLine(u, xy);
      if (pu && (!best || pu.dist < best.pu.dist)) best = { line: xy, pu };
    }
    if (best && best.pu.dist < 60) {
      const along = best.pu.tangent[0] * headingVec[0] + best.pu.tangent[1] * headingVec[1];
      const pt = projectOnLine(t, best.line);
      if (Math.abs(along) > 0.35 && pt && pt.dist < 120) {
        const dir = Math.sign(along);
        // Seite relativ zur Fahrtrichtung: Querprodukt mit der Linienrichtung * Fahrsinn
        const side: Side = pt.cross * dir > 0 ? 'links' : 'rechts';
        const behind = (pt.s - best.pu.s) * dir < -8;
        return { distance, side, behind, method: 'street' };
      }
    }
  }
  const rel = wrap180(bearingDeg(user.lat, user.lon, target.lat, target.lon) - user.heading);
  if (distance < 8) return { distance, side: null, behind: false, method: 'bearing' };
  const behind = Math.abs(rel) > 120;
  const side: Side = Math.abs(rel) < 12 ? 'geradeaus' : rel < 0 ? 'links' : 'rechts';
  return { distance, side, behind, method: 'bearing' };
}

export function formatDistance(m: number): string {
  if (!Number.isFinite(m)) return '–';
  if (m < 1000) return `${Math.round(m / 5) * 5} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
}
