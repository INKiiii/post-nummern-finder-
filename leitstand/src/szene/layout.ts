/**
 * Anordnung in der Basis: Fahrzeuge an den Rampen, Behälter auf der Bereitstellfläche.
 * Lokale Koordinaten der Halle in Szene-Einheiten: lx nach Osten, lz nach Süden (−lz = Norden).
 */
import { behaelterFolge } from '../core/modell';
import type { Plan, Tag, Welt } from '../core/types';
import { S } from './koord';

export interface Pose {
  x: number;
  z: number;
  /** rotation.y; Fahrzeuge sind entlang lokal +x modelliert */
  rot: number;
}

export function halleMitte(welt: Welt): { x: number; z: number } {
  return { x: welt.basis.pos.x * S, z: -welt.basis.pos.y * S };
}

/** Rampen-Nummer → Position der Tür (Szene) */
export function rampenTuer(welt: Welt, nr: number): { x: number; z: number } {
  const r = welt.basis.rampen[nr - 1];
  const m = halleMitte(welt);
  return { x: r.pos.x * S, z: m.z - (welt.basis.halle.tiefeKm * S) / 2 };
}

/** Fahrzeug steht rückwärts an der Rampe, Front nach Norden zum Hof */
export function rampenPose(welt: Welt, nr: number): Pose {
  const r = welt.basis.rampen[nr - 1];
  return { x: r.pos.x * S, z: -r.pos.y * S, rot: Math.PI / 2 };
}

export const BEHAELTER_ABSTAND = 0.3;

/**
 * Platz eines Behälters auf der Bereitstellfläche: je Tour eine Reihe hinter ihrer Rampentür,
 * der zuletzt zuzustellende Behälter steht vorn (wird zuerst geladen).
 */
export function hallenPlatz(welt: Welt, tag: Tag, plan: Plan, behaelterId: string): Pose {
  const tuer = (nr: number) => rampenTuer(welt, nr);
  for (const t of tag.touren) {
    const folge = behaelterFolge(plan, t.id);
    const i = folge.indexOf(behaelterId);
    if (i < 0) continue;
    const p = tuer(t.rampe);
    const reihe = folge.length - 1 - i;
    return { x: p.x, z: p.z + 0.45 + reihe * BEHAELTER_ABSTAND, rot: 0 };
  }
  // ohne Tour: Sammelplatz im Süden der Halle
  const m = halleMitte(welt);
  const ohne = tag.behaelterIds.filter((b) => !tag.touren.some((t) => behaelterFolge(plan, t.id).includes(b)));
  const j = Math.max(0, ohne.indexOf(behaelterId));
  return { x: m.x + 3.5 + (j % 6) * 0.3, z: m.z + 1.6 + Math.floor(j / 6) * 0.3, rot: 0 };
}

type Punkt = { x: number; z: number };

function bezier(a: Punkt, b: Punkt, c: Punkt, t: number): { p: Punkt; d: Punkt } {
  const s = 1 - t;
  return {
    p: { x: s * s * a.x + 2 * s * t * b.x + t * t * c.x, z: s * s * a.z + 2 * s * t * b.z + t * t * c.z },
    d: { x: 2 * s * (b.x - a.x) + 2 * t * (c.x - b.x), z: 2 * s * (b.z - a.z) + 2 * t * (c.z - b.z) },
  };
}

const glatt = (u: number) => {
  const v = Math.max(0, Math.min(1, u));
  return v * v * (3 - 2 * v);
};
/** Szene-Richtung (dx, dz) → rotation.y */
const winkelVon = (d: Punkt) => Math.atan2(-d.z, d.x);

/** Abfahrt: vorwärts von der Rampe über den Hof bis zum Hoftor (u = 0…1) */
export function abfahrtPose(rampe: Pose, tor: Punkt, u: number): Pose {
  const { p, d } = bezier({ x: rampe.x, z: rampe.z }, { x: rampe.x, z: rampe.z - 4 }, tor, glatt(u));
  return { x: p.x, z: p.z, rot: winkelVon(d) };
}

/** Ankunft: vom Hoftor in den Hof, dann rückwärts an die Rampe (u = 0…1) */
export function ankunftPose(rampe: Pose, tor: Punkt, u: number): Pose {
  const seite = rampe.x >= tor.x ? 1 : -1;
  const wende = { x: rampe.x + 2.6 * seite, z: rampe.z - 3.6 };
  const vor = { x: rampe.x, z: rampe.z - 2.4 };
  if (u < 0.5) {
    // vorwärts zur Wendestelle, Blick schon in Richtung Rückwärtsfahrt
    const r = { x: wende.x - vor.x, z: wende.z - vor.z };
    const l = Math.hypot(r.x, r.z) || 1;
    const k = { x: wende.x - (r.x / l) * 2.5, z: wende.z - (r.z / l) * 2.5 };
    const { p, d } = bezier(tor, k, wende, glatt(u / 0.5));
    return { x: p.x, z: p.z, rot: winkelVon(d) };
  }
  const { p, d } = bezier(wende, vor, { x: rampe.x, z: rampe.z }, glatt((u - 0.5) / 0.5));
  // rückwärts: Front zeigt entgegen der Bewegung
  return { x: p.x, z: p.z, rot: winkelVon({ x: -d.x, z: -d.z }) };
}

/** Rollweg: Platz → Tür → in den Laderaum des Fahrzeugs (u = 0…1, sanft beschleunigt) */
export function rollPosition(platz: Pose, tuer: { x: number; z: number }, fahrzeug: Pose, u: number): { x: number; z: number } {
  const a = { x: platz.x, z: platz.z };
  const b = { x: tuer.x, z: tuer.z + 0.12 };
  const c = { x: fahrzeug.x, z: fahrzeug.z + 0.15 };
  const l1 = Math.hypot(b.x - a.x, b.z - a.z);
  const l2 = Math.hypot(c.x - b.x, c.z - b.z);
  const e = u * u * (3 - 2 * u);
  const s = e * (l1 + l2);
  if (s <= l1 || l2 === 0) {
    const k = l1 > 0 ? s / l1 : 1;
    return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
  }
  const k = Math.min(1, (s - l1) / l2);
  return { x: b.x + (c.x - b.x) * k, z: b.z + (c.z - b.z) * k };
}

/** Position auf einem Streckenzug (u = 0…1, sanft beschleunigt und gebremst) */
export function wegPosition(punkte: ReadonlyArray<{ x: number; z: number }>, u: number): { x: number; z: number } {
  const e = glatt(u);
  const laengen = punkte.slice(1).map((p, i) => Math.hypot(p.x - punkte[i].x, p.z - punkte[i].z));
  const gesamt = laengen.reduce((a, b) => a + b, 0);
  if (gesamt === 0) return { ...punkte[punkte.length - 1] };
  let rest = e * gesamt;
  for (let i = 0; i < laengen.length; i++) {
    if (rest <= laengen[i] || i === laengen.length - 1) {
      const k = laengen[i] > 0 ? Math.min(1, rest / laengen[i]) : 1;
      return { x: punkte[i].x + (punkte[i + 1].x - punkte[i].x) * k, z: punkte[i].z + (punkte[i + 1].z - punkte[i].z) * k };
    }
    rest -= laengen[i];
  }
  return { ...punkte[punkte.length - 1] };
}

/** Umladen an der Rampe: aus dem einen Laderaum durch die Halle in den anderen */
export function umladeWeg(welt: Welt, rampeVon: number, rampeNach: number): Array<{ x: number; z: number }> {
  const a = rampenPose(welt, rampeVon);
  const b = rampenPose(welt, rampeNach);
  const ta = rampenTuer(welt, rampeVon);
  const tb = rampenTuer(welt, rampeNach);
  return [
    { x: a.x, z: a.z + 0.15 },
    { x: ta.x, z: ta.z + 0.12 },
    { x: ta.x, z: ta.z + 0.6 },
    { x: tb.x, z: tb.z + 0.6 },
    { x: tb.x, z: tb.z + 0.12 },
    { x: b.x, z: b.z + 0.15 },
  ];
}

/** Platzwechsel in der Halle über den Gang hinter den Reihen */
export function hallenWeg(von: { x: number; z: number }, nach: { x: number; z: number }): Array<{ x: number; z: number }> {
  const gang = Math.max(von.z, nach.z) + 0.35;
  return [von, { x: von.x, z: gang }, { x: nach.x, z: gang }, nach];
}
