import { describe, expect, it } from 'vitest';
import { Wegenetz } from '../src/core/graph';
import { erzeugeDemoWelt, punktSegment } from '../src/core/welt';
import type { Vec2 } from '../src/core/types';
import { demo, demoWelt } from './hilfen';

function schneiden(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): boolean {
  const kreuz = (a: Vec2, b: Vec2, c: Vec2) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = kreuz(q1, q2, p1);
  const d2 = kreuz(q1, q2, p2);
  const d3 = kreuz(p1, p2, q1);
  const d4 = kreuz(p1, p2, q2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

describe('Demo-Welt Musterhausen', () => {
  const welt = demoWelt();

  it('ist deterministisch (gleicher Seed → gleiche Welt)', () => {
    expect(JSON.stringify(erzeugeDemoWelt())).toBe(JSON.stringify(welt));
    expect(JSON.stringify(erzeugeDemoWelt(99))).not.toBe(JSON.stringify(welt));
  });

  it('hat 9 Ortsteile und 18–24 Zustellbezirke mit Stopps und Häusern', () => {
    expect(welt.name).toBe('Musterhausen');
    expect(welt.ortsteile).toHaveLength(9);
    expect(welt.bezirkIds.length).toBeGreaterThanOrEqual(18);
    expect(welt.bezirkIds.length).toBeLessThanOrEqual(24);
    for (const id of welt.bezirkIds) {
      const b = welt.bezirke[id];
      expect(b.id).toMatch(/^[A-Z]{2}-[NSWOM]$/);
      expect(b.stopps.length).toBeGreaterThanOrEqual(8);
      expect(b.innenKm).toBeGreaterThan(1);
      for (const s of b.stopps) expect(welt.stopps[s].bezirkId).toBe(id);
    }
    const mitHaus = welt.stopps.filter((s) => s.haeuser.length > 0).length;
    expect(mitHaus / welt.stopps.length).toBeGreaterThan(0.9);
    expect(welt.landschaft.felder.length).toBeGreaterThan(50);
    expect(welt.landschaft.baeume.length).toBeGreaterThan(100);
  });

  it('Straßennetz ist zusammenhängend', () => {
    const w = new Wegenetz(welt.netz);
    for (const k of welt.netz.knoten) expect(Number.isFinite(w.distanz(welt.basis.knoten, k.id))).toBe(true);
  });

  it('Gangfolge im Bezirk: Rundweg ab Anfahrpunkt über alle Stopps', () => {
    for (const id of welt.bezirkIds) {
      const b = welt.bezirke[id];
      expect(b.innenWeg[0]).toBe(b.anfahrpunkt);
      expect(b.innenWeg[b.innenWeg.length - 1]).toBe(b.anfahrpunkt);
      const aufWeg = new Set(b.innenWeg);
      for (const s of b.stopps) expect(aufWeg.has(welt.stopps[s].knoten)).toBe(true);
      // aufeinanderfolgende Knoten sind durch eine Kante verbunden
      const w = new Wegenetz(welt.netz);
      for (let i = 1; i < b.innenWeg.length; i++) expect(w.kanteZwischen(b.innenWeg[i - 1], b.innenWeg[i])).toBeDefined();
    }
  });

  it('der Fluss wird nur über Brücken gequert', () => {
    const fluss = welt.landschaft.fluss;
    let bruecken = 0;
    for (const k of welt.netz.kanten) {
      const a = welt.netz.knoten[k.a];
      const b = welt.netz.knoten[k.b];
      const quert = fluss.some((_, i) => i > 0 && schneiden(a, b, fluss[i - 1], fluss[i]));
      if (quert) {
        expect(k.typ).toBe('bruecke');
        bruecken++;
      }
    }
    expect(bruecken).toBe(3);
  });

  it('Häuser stehen neben und nicht auf den Straßen', () => {
    const segs = welt.netz.kanten.map((k) => [welt.netz.knoten[k.a], welt.netz.knoten[k.b]] as const);
    for (const h of welt.haeuser.filter((_, i) => i % 7 === 0)) {
      const d = Math.min(...segs.map(([a, b]) => punktSegment(h, a, b)));
      expect(d).toBeGreaterThan(0.02);
      expect(d).toBeLessThan(0.06);
    }
  });

  it('Treffpunkte und Basis liegen auf Knoten des Netzes; die Basis hat 8 Rampen', () => {
    for (const t of welt.treffpunkte) expect(welt.netz.knoten[t.knoten]).toBeDefined();
    expect(welt.treffpunkte.map((t) => t.name)).toContain('Deichweg');
    expect(welt.basis.rampen).toHaveLength(8);
  });

  it('Demo-Tag: 6 Touren mit Pseudonymen, 21 Behälter, alle fiktiv', () => {
    const { tag } = demo();
    expect(tag.touren).toHaveLength(6);
    expect(tag.touren.map((t) => t.pseudonym)).toEqual(['Zusteller A', 'Zusteller B', 'Zusteller C', 'Zusteller D', 'Zusteller E', 'Zusteller F']);
    expect(tag.behaelterIds).toHaveLength(21);
    for (const id of tag.behaelterIds) {
      const i = tag.behaelter[id].inhalt;
      expect(i.pakete).toBeGreaterThan(0);
      expect(i.briefe).toBeGreaterThan(i.pakete);
      expect(Number.isInteger(i.pakete) && Number.isInteger(i.briefe) && Number.isInteger(i.zeitungen)).toBe(true);
    }
  });

  it('Spitzentag: Mengen +40 %', () => {
    const normal = demo(1).tag;
    const spitze = demo(1.4).tag;
    const summe = (t: typeof normal) => t.behaelterIds.reduce((s, id) => s + t.behaelter[id].inhalt.briefe, 0);
    expect(summe(spitze) / summe(normal)).toBeCloseTo(1.4, 2);
    expect(spitze.mengenFaktor).toBe(1.4);
  });
});
