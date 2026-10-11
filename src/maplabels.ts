// Regeln für Ausschnitt und Beschriftung der Karte (ohne DOM, damit testbar).

/** Sicht voraus in Metern je Zoomstufe (Live-Karte). Standard: 80 m voraus, ~20 m zurück. */
export const AHEAD_LEVELS = [30, 45, 60, 80, 110, 150, 220, 320, 500];
export const DEFAULT_LEVEL = 3;
/** Anteil der Kartenhöhe über dem Fahrzeug (Fahrzeug im unteren Drittel bzw. Viertel). */
export const CAR_Y = 0.75;
/** Mindestschriftgröße der Hausnummern auf der Karte (px). */
export const NUMBER_FONT = 20;

export interface LabelCandidate<T> {
  item: T;
  x: number;
  y: number;
  target?: boolean;
}

/**
 * Reihenfolge, in der Hausnummern beschriftet werden (bei Platzmangel fallen die hinteren weg):
 * Zielnummer, dann Häuser voraus (über dem Fahrzeug, nächste zuerst), dann Häuser dahinter.
 * Ohne Fahrzeug: vom Kartenmittelpunkt aus, nächste zuerst.
 */
export function labelOrder<T>(cands: LabelCandidate<T>[], car: [number, number] | null, center: [number, number]): T[] {
  const ref = car ?? center;
  const key = (c: LabelCandidate<T>) => {
    if (c.target) return -1;
    const d = Math.hypot(c.x - ref[0], c.y - ref[1]);
    if (!car) return d;
    return c.y <= car[1] + 4 ? d : 1e6 + d;
  };
  return cands
    .map((c) => ({ c, k: key(c) }))
    .sort((a, b) => a.k - b.k)
    .map((e) => e.c.item);
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
