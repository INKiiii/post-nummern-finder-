// Regeln für Ausschnitt und Beschriftung der Karte (ohne DOM, damit testbar).

/** Sicht voraus in Metern je Zoomstufe (Live-Karte). Standard: 80 m voraus, ~20 m zurück. */
export const AHEAD_LEVELS = [30, 45, 60, 80, 110, 150, 220, 320, 500];
export const DEFAULT_LEVEL = 3;
/** Anteil der Kartenhöhe über dem Fahrzeug (Fahrzeug im unteren Drittel bzw. Viertel). */
export const CAR_Y = 0.75;
/** Schriftgröße der Hausnummern auf der Karte (px); bei Platzmangel etwas kleiner statt gar nicht. */
export const NUMBER_FONT = 20;
export const NUMBER_FONT_SMALL = 16;
/** Nummern, die näher als so viele Meter beieinander liegen (gleiches Haus), stehen in einer Beschriftung. */
export const SAME_HOUSE_M = 5;

export interface LabelCandidate<T> {
  item: T;
  x: number;
  y: number;
  target?: boolean;
  /** Haus an der Straße, auf der man gerade ist (bzw. Zielstraße) */
  primary?: boolean;
}

/**
 * Reihenfolge, in der Hausnummern beschriftet werden (bei Platzmangel fallen die hinteren weg):
 * Zielnummer, dann Häuser voraus (über dem Fahrzeug, nächste zuerst), dann Häuser dahinter.
 * Jeweils zuerst die eigene Straße, dann Eckhäuser und Nebenstraßen.
 * Ohne Fahrzeug: vom Kartenmittelpunkt aus, nächste zuerst.
 */
export function labelOrder<T>(cands: LabelCandidate<T>[], car: [number, number] | null, center: [number, number]): T[] {
  const ref = car ?? center;
  const key = (c: LabelCandidate<T>) => {
    if (c.target) return -1;
    const d = Math.hypot(c.x - ref[0], c.y - ref[1]) + (c.primary ? 0 : 5e5);
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

/** Natürliche Reihenfolge von Hausnummern: 2 < 5 < 5a < 5b < 12 */
export function compareHouseLabels(a: string, b: string): number {
  const na = Number.parseInt(a, 10);
  const nb = Number.parseInt(b, 10);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.localeCompare(b, 'de', { numeric: true });
}

/** Mehrere Nummern an einem Haus als eine Beschriftung: „5, 5a“ bzw. „5–5c“ */
export function joinHouseLabels(labels: string[]): string {
  const l = [...new Set(labels)].sort(compareHouseLabels);
  if (l.length <= 2) return l.join(', ');
  return `${l[0]}–${l[l.length - 1]}`;
}

/**
 * Fasst Nummern derselben Straße zusammen, die fast am selben Punkt liegen (Mehrfamilienhaus,
 * 5/5a/5b in einem Gebäude). Positionen in Metern; Reihenfolge der Gruppen wie die Eingabe.
 */
export function groupSameHouse<T>(items: Array<{ item: T; street: string; x: number; y: number }>, maxM = SAME_HOUSE_M): T[][] {
  type Group = { street: string; x: number; y: number; items: T[] };
  const groups: Group[] = [];
  // Raster mit Zellen von maxM: nur Nachbarzellen prüfen (schnell auch bei vielen Häusern)
  const cells = new Map<string, Group[]>();
  const cell = (street: string, cx: number, cy: number) => `${street}|${cx}|${cy}`;
  for (const it of items) {
    const cx = Math.floor(it.x / maxM);
    const cy = Math.floor(it.y / maxM);
    let found: Group | null = null;
    for (let dx = -1; dx <= 1 && !found; dx++)
      for (let dy = -1; dy <= 1 && !found; dy++)
        for (const q of cells.get(cell(it.street, cx + dx, cy + dy)) ?? [])
          if (Math.hypot(q.x - it.x, q.y - it.y) <= maxM) {
            found = q;
            break;
          }
    if (found) found.items.push(it.item);
    else {
      const g = { street: it.street, x: it.x, y: it.y, items: [it.item] };
      groups.push(g);
      const k = cell(it.street, cx, cy);
      const l = cells.get(k);
      if (l) l.push(g);
      else cells.set(k, [g]);
    }
  }
  return groups.map((g) => g.items);
}
