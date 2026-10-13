import { describe, expect, it } from 'vitest';
import { Wegenetz, wegLaenge } from '../src/core/graph';
import { demoWelt, miniWelt } from './hilfen';

describe('Wegenetz (Dijkstra)', () => {
  it('findet kürzeste Wege und Pfade', () => {
    const w = new Wegenetz(miniWelt().netz);
    expect(w.distanz(0, 2)).toBe(12);
    expect(w.distanz(2, 3)).toBe(9);
    expect(w.pfad(0, 3)).toEqual([0, 1, 3]);
    expect(w.pfad(2, 2)).toEqual([2]);
    expect(w.distanz(3, 3)).toBe(0);
  });

  it('umfährt gesperrte Kanten oder meldet „nicht erreichbar“', () => {
    const w = new Wegenetz(miniWelt().netz, [2]);
    expect(w.distanz(0, 3)).toBe(Infinity);
    expect(w.pfad(0, 3)).toEqual([]);
  });

  it('Sperrung der Mittelbrücke verlängert den Weg von der Basis nach Lindenau', () => {
    const welt = demoWelt();
    const ziel = welt.bezirke['LI-S'].anfahrpunkt;
    const frei = new Wegenetz(welt.netz).distanz(welt.basis.knoten, ziel);
    const bruecke = welt.hauptstrassen.find((h) => h.name === 'Mittelbrücke')!;
    const gesperrt = new Wegenetz(welt.netz, bruecke.kanten);
    const umweg = gesperrt.distanz(welt.basis.knoten, ziel);
    expect(umweg).toBeGreaterThan(frei + 1);
    expect(Number.isFinite(umweg)).toBe(true);
    const pfad = gesperrt.pfad(welt.basis.knoten, ziel);
    expect(wegLaenge(welt.netz, pfad)).toBeCloseTo(umweg, 6);
    for (let i = 1; i < pfad.length; i++) expect(bruecke.kanten).not.toContain(gesperrt.kanteZwischen(pfad[i - 1], pfad[i]));
  });
});
