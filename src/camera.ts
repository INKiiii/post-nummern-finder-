// Kamera der Karte (ohne DOM, testbar). Ein Weltpunkt (Meter, x Ost, y Nord) erscheint an einem
// Bildschirmpunkt (px, y nach unten); dazu Drehung (Grad, Fahrtrichtung oben) und Maßstab
// (Pixel pro Meter). Zwischen zwei Kameras gleitet die Karte; das fertig gezeichnete Bild wird
// dabei nur verschoben und gedreht (eine CSS-Matrix), statt jedes Mal neu zu zeichnen.

export interface Cam {
  /** Weltpunkt (m), der am Bildschirmpunkt (sx, sy) liegt – live: das Fahrzeug */
  ax: number;
  ay: number;
  sx: number;
  sy: number;
  /** Drehung in Grad: diese Kompassrichtung zeigt nach oben */
  rot: number;
  /** Pixel pro Meter */
  scale: number;
}

const RAD = Math.PI / 180;

export function toScreen(c: Cam, x: number, y: number): [number, number] {
  const co = Math.cos(c.rot * RAD);
  const si = Math.sin(c.rot * RAD);
  const dx = x - c.ax;
  const dy = y - c.ay;
  return [c.sx + (dx * co - dy * si) * c.scale, c.sy - (dx * si + dy * co) * c.scale];
}

export function toWorld(c: Cam, px: number, py: number): [number, number] {
  const co = Math.cos(c.rot * RAD);
  const si = Math.sin(c.rot * RAD);
  const u = (px - c.sx) / c.scale;
  const v = (c.sy - py) / c.scale;
  return [c.ax + u * co + v * si, c.ay - u * si + v * co];
}

/** Kürzeste Drehung von a nach b in Grad (−180 … 180) */
export function angleDiff(a: number, b: number): number {
  return ((((b - a + 540) % 360) + 360) % 360) - 180;
}

/** Dieselbe Ansicht, aber mit anderem Bezugspunkt auf dem Bildschirm */
export function reanchor(c: Cam, sx: number, sy: number): Cam {
  const [ax, ay] = toWorld(c, sx, sy);
  return { ...c, ax, ay, sx, sy };
}

/**
 * Zwischenstellung (t = 0 … 1). a sollte denselben Bildschirm-Bezugspunkt haben wie b (reanchor):
 * Dann wandert der Bezugspunkt (das Fahrzeug) geradlinig, und die Karte dreht sich um ihn.
 */
export function lerpCam(a: Cam, b: Cam, t: number, tRot = t): Cam {
  return {
    ax: a.ax + (b.ax - a.ax) * t,
    ay: a.ay + (b.ay - a.ay) * t,
    sx: a.sx + (b.sx - a.sx) * t,
    sy: a.sy + (b.sy - a.sy) * t,
    rot: a.rot + angleDiff(a.rot, b.rot) * tRot,
    scale: a.scale * Math.pow(b.scale / a.scale, t),
  };
}

/** Bildschirm unter Kamera `from` → Bildschirm unter Kamera `to`, als CSS-Matrix (a, b, c, d, e, f) */
export function screenMatrix(from: Cam, to: Cam): [number, number, number, number, number, number] {
  const P = (x: number, y: number) => {
    const [wx, wy] = toWorld(from, x, y);
    return toScreen(to, wx, wy);
  };
  const [e, f] = P(0, 0);
  const [x1, y1] = P(100, 0);
  const [x2, y2] = P(0, 100);
  return [(x1 - e) / 100, (y1 - f) / 100, (x2 - e) / 100, (y2 - f) / 100, e, f];
}

const corners = (w: number, h: number) => [
  [0, 0],
  [w, 0],
  [0, h],
  [w, h],
];

/** Größte Verschiebung (px) einer Bildschirmecke zwischen zwei Kameras */
export function cornerShift(a: Cam, b: Cam, w: number, h: number): number {
  let m = 0;
  for (const [x, y] of corners(w, h)) {
    const [wx, wy] = toWorld(b, x, y);
    const [px, py] = toScreen(a, wx, wy);
    m = Math.max(m, Math.hypot(px - x, py - y));
  }
  return m;
}

/** Praktisch dieselbe Ansicht (unter einem halben Pixel) */
export function sameCam(a: Cam, b: Cam, w: number, h: number): boolean {
  return cornerShift(a, b, w, h) < 0.5;
}

/** Ab dieser Drehung (Grad) wird neu gezeichnet: Nummern neben ihrem Haus bleiben aufrecht und rucken kaum */
export const MAX_TILT = 5;

/**
 * Deckt das unter `drawn` gezeichnete Bild (mit `ov` px Rand ringsum) den Bildschirm unter `view`
 * noch ab? Zusätzlich: nicht zu schräg (Schrift soll aufrecht bleiben) und nicht zu sehr
 * vergrößert (sonst unscharf). Sonst muss neu gezeichnet werden.
 */
export function covers(drawn: Cam, view: Cam, w: number, h: number, ov: number): boolean {
  if (ov <= 0) return sameCam(drawn, view, w, h);
  if (Math.abs(angleDiff(drawn.rot, view.rot)) > MAX_TILT) return false;
  const k = view.scale / drawn.scale;
  if (k < 0.8 || k > 1.25) return false;
  for (const [x, y] of corners(w, h)) {
    const [wx, wy] = toWorld(view, x, y);
    const [px, py] = toScreen(drawn, wx, wy);
    if (px < -ov || px > w + ov || py < -ov || py > h + ov) return false;
  }
  return true;
}
