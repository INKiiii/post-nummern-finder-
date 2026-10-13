/**
 * Geometrien aus den Weltdaten: alles zu wenigen Meshes zusammengefasst
 * (Straßen, Markierungen, Fluss, Felder) bzw. als Grundformen für Instancing.
 */
import { BoxGeometry, BufferAttribute, BufferGeometry, Color } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { StrassenTyp, Vec2, Welt } from '../core/types';
import { zufall } from '../core/rng';
import { THEME } from '../theme';
import { EBENE, S } from './koord';

export const STRASSEN_BREITE: Record<StrassenTyp, number> = {
  haupt: 0.95,
  bruecke: 0.95,
  land: 0.8,
  deich: 0.62,
  gewerbe: 0.75,
  zufahrt: 0.6,
  ort: 0.55,
};

const RANG: Record<StrassenTyp, number> = { haupt: 6, bruecke: 6, land: 5, gewerbe: 4, deich: 3, zufahrt: 2, ort: 1 };

function strassenFarbe(typ: StrassenTyp): Color {
  if (typ === 'haupt' || typ === 'bruecke' || typ === 'land') return new Color(THEME.szene.strasseHaupt);
  if (typ === 'deich') return new Color('#a09a8e');
  return new Color(THEME.szene.strasseOrt);
}

class Puffer {
  pos: number[] = [];
  farbe: number[] = [];
  index: number[] = [];
  punkt(x: number, y: number, z: number, c: Color): number {
    this.pos.push(x, y, z);
    this.farbe.push(c.r, c.g, c.b);
    return this.pos.length / 3 - 1;
  }
  dreieck(a: number, b: number, c: number) {
    this.index.push(a, b, c);
  }
  geometrie(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.farbe), 3));
    const n = new Float32Array(this.pos.length);
    for (let i = 1; i < n.length; i += 3) n[i] = 1;
    g.setAttribute('normal', new BufferAttribute(n, 3));
    g.setIndex(this.index);
    g.computeBoundingSphere();
    return g;
  }
}

/** Band (Rechteck) von a nach b mit Breite w in Höhe h (Szene-Einheiten) */
function band(p: Puffer, ax: number, az: number, bx: number, bz: number, w: number, h: number, c: Color) {
  const dx = bx - ax;
  const dz = bz - az;
  const l = Math.hypot(dx, dz) || 1;
  const nx = (-dz / l) * (w / 2);
  const nz = (dx / l) * (w / 2);
  const i0 = p.punkt(ax + nx, h, az + nz, c);
  const i1 = p.punkt(ax - nx, h, az - nz, c);
  const i2 = p.punkt(bx - nx, h, bz - nz, c);
  const i3 = p.punkt(bx + nx, h, bz + nz, c);
  p.dreieck(i0, i2, i1);
  p.dreieck(i0, i3, i2);
}

function scheibe(p: Puffer, x: number, z: number, r: number, h: number, c: Color, segmente = 10) {
  const m = p.punkt(x, h, z, c);
  const rand: number[] = [];
  for (let i = 0; i < segmente; i++) {
    const a = (i / segmente) * Math.PI * 2;
    rand.push(p.punkt(x + Math.cos(a) * r, h, z + Math.sin(a) * r, c));
  }
  for (let i = 0; i < segmente; i++) p.dreieck(m, rand[(i + 1) % segmente], rand[i]);
}

/** Alle Straßen als ein Mesh (Bänder je Kante + runde Knoten) */
export function strassenGeometrie(welt: Welt): BufferGeometry {
  const p = new Puffer();
  const k = welt.netz.knoten;
  const hoehe = (typ: StrassenTyp) => EBENE.strasse + RANG[typ] * 0.002;
  const besterTyp = new Map<number, StrassenTyp>();
  for (const e of welt.netz.kanten) {
    for (const id of [e.a, e.b]) {
      const t = besterTyp.get(id);
      if (!t || RANG[e.typ] > RANG[t]) besterTyp.set(id, e.typ);
    }
    const c = strassenFarbe(e.typ);
    band(p, k[e.a].x * S, -k[e.a].y * S, k[e.b].x * S, -k[e.b].y * S, STRASSEN_BREITE[e.typ], hoehe(e.typ), c);
  }
  for (const [id, typ] of besterTyp) scheibe(p, k[id].x * S, -k[id].y * S, STRASSEN_BREITE[typ] / 2, hoehe(typ) - 0.001, strassenFarbe(typ), 8);
  return p.geometrie();
}

/** Mittellinien (gestrichelt) auf Haupt- und Landstraßen */
export function markierungGeometrie(welt: Welt): BufferGeometry {
  const p = new Puffer();
  const c = new Color(THEME.szene.strasseRand);
  const k = welt.netz.knoten;
  for (const e of welt.netz.kanten) {
    if (e.typ !== 'haupt' && e.typ !== 'land' && e.typ !== 'bruecke') continue;
    const ax = k[e.a].x * S;
    const az = -k[e.a].y * S;
    const bx = k[e.b].x * S;
    const bz = -k[e.b].y * S;
    const l = Math.hypot(bx - ax, bz - az);
    const strich = 1.2;
    for (let s = 0.4; s + strich < l - 0.4; s += strich * 2.2) {
      const t0 = s / l;
      const t1 = (s + strich) / l;
      band(p, ax + (bx - ax) * t0, az + (bz - az) * t0, ax + (bx - ax) * t1, az + (bz - az) * t1, 0.07, EBENE.markierung + 0.02, c);
    }
  }
  return p.geometrie();
}

/** Chaikin-Glättung für weichere Linien */
export function glaette(punkte: Vec2[], runden = 2): Vec2[] {
  let p = punkte;
  for (let r = 0; r < runden; r++) {
    const q: Vec2[] = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i];
      const b = p[i + 1];
      q.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 }, { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}

/** Band entlang einer Linie (Gehrung an den Ecken) */
export function linienBand(punkte: Vec2[], breite: number, hoehe: number, farbe: string): BufferGeometry {
  const p = new Puffer();
  const c = new Color(farbe);
  const pts = punkte.map((q) => ({ x: q.x * S, z: -q.y * S }));
  const links: number[] = [];
  const rechts: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    const nx = (-dz / l) * (breite / 2);
    const nz = (dx / l) * (breite / 2);
    links.push(p.punkt(pts[i].x + nx, hoehe, pts[i].z + nz, c));
    rechts.push(p.punkt(pts[i].x - nx, hoehe, pts[i].z - nz, c));
  }
  for (let i = 0; i < pts.length - 1; i++) {
    p.dreieck(links[i], rechts[i + 1], rechts[i]);
    p.dreieck(links[i], links[i + 1], rechts[i + 1]);
  }
  return p.geometrie();
}

/** Felder als ein Mesh mit leicht variierenden Farben */
export function felderGeometrie(welt: Welt): BufferGeometry {
  const p = new Puffer();
  const rng = zufall(welt.seed + 7);
  const farben: Record<string, string> = {
    wiese: THEME.szene.wiese,
    acker: THEME.szene.acker,
    raps: THEME.szene.raps,
    weizen: THEME.szene.weizen,
  };
  for (const f of welt.landschaft.felder) {
    const c = new Color(farben[f.art]).multiplyScalar(rng.zwischen(0.93, 1.05));
    const ids = f.ecken.map((e) => p.punkt(e.x * S, EBENE.feld, -e.y * S, c));
    p.dreieck(ids[0], ids[1], ids[2]);
    p.dreieck(ids[0], ids[2], ids[3]);
  }
  return p.geometrie();
}

/** Satteldach als Prisma: Grundfläche 1 × 1 bei y = 0, First entlang x in y = 1 */
export function dachGeometrie(): BufferGeometry {
  const v = [
    // Dachfläche Süd (+z)
    -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0, -0.5, 0, 0.5, 0.5, 1, 0, -0.5, 1, 0,
    // Dachfläche Nord (−z)
    0.5, 0, -0.5, -0.5, 0, -0.5, -0.5, 1, 0, 0.5, 0, -0.5, -0.5, 1, 0, 0.5, 1, 0,
    // Giebel West und Ost
    -0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0, 0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 1, 0,
  ];
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(v), 3));
  g.computeVertexNormals();
  return g;
}

/** Hauskörper: Würfel mit Boden bei y = 0 */
export function hausGeometrie(): BufferGeometry {
  return new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
}

function gefaerbt(g: BufferGeometry, hell: number): BufferGeometry {
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3).fill(hell);
  g.setAttribute('color', new BufferAttribute(c, 3));
  return g;
}

/** Rollbehälter (Szene-Einheiten, 1 = 10 m; leicht überhöht): Bodenplatte, Gitterkorb, Rahmen */
export const BEHAELTER_MASS = { breite: 0.2, hoehe: 0.46, tiefe: 0.18 };

export function behaelterGeometrie(): BufferGeometry {
  const { breite: b, hoehe: h, tiefe: t } = BEHAELTER_MASS;
  const teile = [
    gefaerbt(new BoxGeometry(b, 0.03, t).translate(0, 0.035, 0), 0.25),
    gefaerbt(new BoxGeometry(b * 0.94, h - 0.07, t * 0.92).translate(0, 0.05 + (h - 0.07) / 2, 0), 1),
    gefaerbt(new BoxGeometry(b, 0.02, t).translate(0, h - 0.01, 0), 0.55),
  ];
  for (const [x, z] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    teile.push(gefaerbt(new BoxGeometry(0.03, 0.03, 0.03).translate((x * b) / 2.6, 0.015, (z * t) / 2.6), 0.15));
  }
  const g = mergeGeometries(teile.map((x) => x.toNonIndexed()));
  g.computeBoundingSphere();
  return g;
}
