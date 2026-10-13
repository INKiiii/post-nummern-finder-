/**
 * Leichte Beschriftungen ohne eigene React-Bäume: Szene-Objekte setzen Ankerpunkte,
 * die Beschriftungsebene (DOM) registriert ihre Elemente, und ein Projektor im
 * Render-Loop schiebt die Elemente jedes Bild an die richtige Bildschirmposition.
 */
import { Vector3 } from 'three';

export const anker = new Map<string, Vector3>();
export const elemente = new Map<string, HTMLElement>();

export function setzeAnker(id: string, x: number, y: number, z: number): void {
  let v = anker.get(id);
  if (!v) anker.set(id, (v = new Vector3()));
  v.set(x, y, z);
}

export function entferneAnker(id: string): void {
  anker.delete(id);
}

/** ref-Callback für ein Beschriftungselement */
export function labelRef(id: string) {
  return (el: HTMLElement | null) => {
    if (el) elemente.set(id, el);
    else elemente.delete(id);
  };
}
