// Navi-Ansicht (ohne DOM, testbar): Die flach gezeichnete Karte wird nach hinten gekippt, wie
// der Blick von hinter dem Fahrzeug in Fahrtrichtung. Mathematisch eine Projektion der Ebene
// (Homographie): Am unteren Rand des freien Bereichs bleibt alles 1:1, nach oben wird es
// kleiner und flacher bis zum Horizont kurz über dem Kopf. Der Browser rechnet das als eine
// CSS-Matrix (matrix3d) auf dem fertigen Bild – das Gleiten bleibt so billig wie flach.
// Beschriftungen werden an ihrer Stelle „entzerrt“ gezeichnet, damit sie aufrecht und lesbar
// bleiben (wie Schilder, die zum Betrachter gedreht sind).

export interface Persp {
  /** Bezugslinie (px): hier ist der Maßstab 1:1 (unterer Rand des freien Bereichs) */
  y0: number;
  /** Stärke der Neigung: Horizont liegt 1/k px über der Bezugslinie */
  k: number;
  /** Fluchtpunkt waagerecht (Mitte des freien Bereichs) */
  cx: number;
}

/** Horizont so viele freie Höhen über der Bezugslinie (kleiner = stärker geneigt) */
export const HORIZON = 1.8;

/** Neigung für einen freien Bereich (oben, unten, links) auf einer Fläche der Breite w */
export function perspFor(top: number, bottom: number, left: number, w: number, horizon = HORIZON): Persp {
  const vh = Math.max(80, bottom - top);
  return { y0: bottom, k: 1 / (horizon * vh), cx: left + (w - left) / 2 };
}

/** Verkleinerung an einer flachen Stelle (1 an der Bezugslinie, nach oben größer) */
export function factorFlat(p: Persp, y: number): number {
  return 1 + p.k * (p.y0 - y);
}

/** Verkleinerung an einer Bildschirmstelle */
export function factorScreen(p: Persp, Y: number): number {
  return 1 / Math.max(0.02, 1 - p.k * (p.y0 - Y));
}

/** flach → Bildschirm */
export function project(p: Persp, x: number, y: number): [number, number] {
  const q = p.y0 - y;
  const f = 1 + p.k * q;
  return [p.cx + (x - p.cx) / f, p.y0 - q / f];
}

/** Bildschirm → flach (Punkte über dem Horizont: knapp darunter) */
export function unproject(p: Persp, X: number, Y: number): [number, number] {
  const Q = Math.min(p.y0 - Y, 0.98 / p.k);
  const q = Q / (1 - p.k * Q);
  const f = 1 + p.k * q;
  return [p.cx + (X - p.cx) * f, p.y0 - q];
}

/**
 * Entzerrung an einer flachen Stelle als CSS-Matrix (a, b, c, d): So gezeichnet, erscheint eine
 * Beschriftung nach dem Kippen unverzerrt (Umkehrung der örtlichen Ableitung).
 */
export function unskew(p: Persp, x: number, y: number): [number, number, number, number] {
  const f = factorFlat(p, y);
  return [f, 0, -(x - p.cx) * p.k * f, f * f];
}

export type H3 = [number, number, number, number, number, number, number, number, number];

/** Homographie der Neigung (zeilenweise 3×3) */
export function homography(p: Persp): H3 {
  const { y0, k, cx } = p;
  return [1, -cx * k, cx * k * y0, 0, 1 - k * y0, k * y0 * y0, 0, -k, 1 + k * y0];
}

/** CSS-2D-Matrix (a, b, c, d, e, f) als 3×3 */
export function affine(m: [number, number, number, number, number, number]): H3 {
  const [a, b, c, d, e, f] = m;
  return [a, c, e, b, d, f, 0, 0, 1];
}

export function mul3(A: H3, B: H3): H3 {
  const r = new Array(9).fill(0) as H3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let t = 0; t < 3; t++) r[i * 3 + j] += A[i * 3 + t] * B[t * 3 + j];
  return r;
}

export function applyH(H: H3, x: number, y: number): [number, number] {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** 3×3 als CSS matrix3d (Punkte der Ebene z = 0) */
export function matrix3d(H: H3): string {
  const v = [H[0], H[3], 0, H[6], H[1], H[4], 0, H[7], 0, 0, 1, 0, H[2], H[5], 0, H[8]];
  return `matrix3d(${v.map((n) => +n.toPrecision(8)).join(',')})`;
}
