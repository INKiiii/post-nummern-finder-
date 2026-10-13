import { describe, expect, it } from 'vitest';
import { Lagebild, zustellungenIm } from '../src/core/lagebild';
import { SimulierteScanner } from '../src/core/simulation';
import { S } from '../src/szene/koord';
import { abfahrtPose, ankunftPose, hallenPlatz, rampenPose, rampenTuer, rollPosition } from '../src/szene/layout';
import { demo } from './hilfen';

const winkelDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

describe('Animationen (Bahnen und Fenster)', () => {
  const d = demo();
  const welt = d.ctx.welt;
  const k = welt.netz.knoten[welt.basis.knoten];
  const tor = { x: k.x * S, z: -k.y * S };

  it('Abfahrt: vorwärts von der Rampe zum Hoftor, ohne Sprünge', () => {
    for (const nr of [1, 4, 8]) {
      const r = rampenPose(welt, nr);
      const a = abfahrtPose(r, tor, 0);
      expect(Math.hypot(a.x - r.x, a.z - r.z)).toBeLessThan(1e-9);
      expect(winkelDiff(a.rot, r.rot)).toBeLessThan(1e-6);
      const e = abfahrtPose(r, tor, 1);
      expect(Math.hypot(e.x - tor.x, e.z - tor.z)).toBeLessThan(1e-9);
      let vorher = a;
      for (let i = 1; i <= 100; i++) {
        const p = abfahrtPose(r, tor, i / 100);
        expect(Math.hypot(p.x - vorher.x, p.z - vorher.z)).toBeLessThan(0.5);
        expect(winkelDiff(p.rot, vorher.rot)).toBeLessThan(0.3);
        vorher = p;
      }
    }
  });

  it('Ankunft: vom Hoftor rückwärts an die Rampe, Blickrichtung stetig', () => {
    for (const nr of [1, 5, 8]) {
      const r = rampenPose(welt, nr);
      const a = ankunftPose(r, tor, 0);
      expect(Math.hypot(a.x - tor.x, a.z - tor.z)).toBeLessThan(1e-9);
      const e = ankunftPose(r, tor, 1);
      expect(Math.hypot(e.x - r.x, e.z - r.z)).toBeLessThan(1e-9);
      // steht am Ende mit der Front zum Hof, wie an der Rampe
      expect(winkelDiff(e.rot, r.rot)).toBeLessThan(1e-6);
      // am Wendepunkt wechselt nur die Fahrtrichtung, nicht die Blickrichtung
      expect(winkelDiff(ankunftPose(r, tor, 0.4999).rot, ankunftPose(r, tor, 0.5001).rot)).toBeLessThan(0.05);
      let vorher = a;
      for (let i = 1; i <= 100; i++) {
        const p = ankunftPose(r, tor, i / 100);
        expect(Math.hypot(p.x - vorher.x, p.z - vorher.z)).toBeLessThan(0.6);
        vorher = p;
      }
    }
  });

  it('Rollbehälter rollen vom Platz durch die Tür in den Laderaum', () => {
    const t = d.ctx.tag.touren[0];
    const id = d.plan.touren[t.id].schritte.find((x) => x.art === 'bezirk')!.behaelterId;
    const platz = hallenPlatz(welt, d.ctx.tag, d.plan, id);
    const tuer = rampenTuer(welt, t.rampe);
    const fz = rampenPose(welt, t.rampe);
    const a = rollPosition(platz, tuer, fz, 0);
    expect(a).toEqual({ x: platz.x, z: platz.z });
    const e = rollPosition(platz, tuer, fz, 1);
    expect(Math.abs(e.x - fz.x)).toBeLessThan(1e-9);
    expect(Math.abs(e.z - (fz.z + 0.15))).toBeLessThan(1e-9);
    // immer Richtung Fahrzeug (Norden = −z)
    let z = a.z;
    for (let i = 1; i <= 50; i++) {
      const p = rollPosition(platz, tuer, fz, i / 50);
      expect(p.z).toBeLessThanOrEqual(z + 1e-9);
      z = p.z;
    }
  });

  it('Häuser leuchten: Zustellungen im Zeitfenster per Binärsuche', () => {
    const sim = new SimulierteScanner(d.ctx, d.plan, {});
    const lage = new Lagebild(d.ctx, d.plan);
    for (const e of sim.vorspulen(11 * 60)) lage.anwenden(e);
    const liste = lage.zustellungen;
    expect(liste.length).toBeGreaterThan(50);
    for (const [von, bis] of [
      [9 * 60, 9 * 60 + 2.5],
      [10 * 60 + 17.3, 10 * 60 + 19.8],
      [0, 6 * 60],
      [10 * 60 + 59, 12 * 60],
    ]) {
      const erwartet = liste.filter((z) => z.t > von && z.t <= bis);
      expect(zustellungenIm(liste, von, bis)).toEqual(erwartet);
    }
  });
});
