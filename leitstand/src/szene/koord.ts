/**
 * Umrechnung Welt (km, x Ost / y Nord) → Szene (three.js, y oben).
 * 1 Szene-Einheit = 10 m. Norden zeigt nach −z.
 */
import { Vector3 } from 'three';
import type { Vec2 } from '../core/types';

export const S = 100;

export const sx = (x: number) => x * S;
export const sz = (y: number) => -y * S;

export function zuSzene(p: Vec2, h = 0): Vector3 {
  return new Vector3(p.x * S, h, -p.y * S);
}

/** Höhen der Ebenen, damit sich nichts überlagert */
export const EBENE = {
  boden: 0,
  feld: 0.02,
  ufer: 0.03,
  wasser: 0.04,
  strasse: 0.07,
  markierung: 0.08,
  hof: 0.06,
};

/** Zeichenreihenfolge der flachen Ebenen (ohne Tiefenpuffer) */
export const REIHENFOLGE = {
  boden: -10,
  felder: -9,
  ufer: -8,
  wasser: -7,
  hof: -6,
  strassen: -5,
  markierung: -4,
  uebersicht: -3,
};

/** Welt-Winkel (Radiant, von Ost gegen den Uhrzeigersinn) → rotation.y */
export function rotY(winkel: number): number {
  return winkel;
}
