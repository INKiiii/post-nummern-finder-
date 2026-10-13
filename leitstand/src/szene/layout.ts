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
