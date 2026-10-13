/** Hilfen rund um die Auswahl: betroffene Bezirke, Mittelpunkte, Flugziele */
import type { Lagebild } from '../core/lagebild';
import { behaelterFolge } from '../core/modell';
import type { Plan, Tag, Welt } from '../core/types';
import type { Auswahl } from '../state/ansicht';
import { S } from './koord';
import { hallenPlatz, halleMitte, rampenPose } from './layout';

/** Bezirke, die zur Auswahl gehören (null = keine Hervorhebung) */
export function aktiveBezirke(a: Auswahl, tag: Tag, plan: Plan): Set<string> | null {
  if (!a) return null;
  if (a.art === 'bezirk') return new Set([a.id]);
  if (a.art === 'behaelter') return new Set([tag.behaelter[a.id].zielbezirk]);
  if (a.art === 'fahrzeug') return new Set(behaelterFolge(plan, a.id).map((b) => tag.behaelter[b].zielbezirk));
  return null;
}

const mittenCache = new WeakMap<Welt, Map<string, { x: number; z: number }>>();

/** Mittelpunkt eines Bezirks (Durchschnitt der Häuser) in Szene-Koordinaten */
export function bezirkMitte(welt: Welt, id: string): { x: number; z: number } {
  let m = mittenCache.get(welt);
  if (!m) mittenCache.set(welt, (m = new Map()));
  const vorhanden = m.get(id);
  if (vorhanden) return vorhanden;
  let x = 0;
  let z = 0;
  let n = 0;
  for (const s of welt.bezirke[id].stopps) {
    const k = welt.netz.knoten[welt.stopps[s].knoten];
    x += k.x;
    z += k.y;
    n++;
  }
  const p = { x: (x / n) * S, z: (-z / n) * S };
  m.set(id, p);
  return p;
}

/** Angezeigte Position eines Fahrzeugs (aus dem Lagebild, sonst an der Rampe) */
export function fahrzeugPosition(welt: Welt, tag: Tag, tourId: string, lage: Lagebild | null, zeit: number): { x: number; z: number; unterwegs: boolean } {
  const t = tag.touren.find((x) => x.id === tourId)!;
  const p = lage?.pose(tourId, zeit);
  if (p && !p.anRampe) return { x: p.x * S, z: -p.y * S, unterwegs: true };
  const r = rampenPose(welt, t.rampe);
  return { x: r.x, z: r.z, unterwegs: false };
}

export function behaelterPosition(welt: Welt, tag: Tag, plan: Plan, id: string): { x: number; z: number } {
  const p = hallenPlatz(welt, tag, plan, id);
  return { x: p.x, z: p.z };
}

export function basisPosition(welt: Welt): { x: number; z: number } {
  return halleMitte(welt);
}
