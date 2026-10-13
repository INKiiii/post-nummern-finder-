import { describe, expect, it } from 'vitest';
import { bewertePlan } from '../src/core/modell';
import { behaelterSicht, fahrzeugSicht, ladeZeiten } from '../src/core/sicht';
import { demo } from './hilfen';

describe('Sicht zu einer Uhrzeit', () => {
  const { ctx, plan } = demo();
  const aus = bewertePlan(ctx, plan);
  const t1 = aus.touren.T1;

  it('vor Schichtbeginn: alle Behälter in der Halle, mit Tour und Gangfolge-Position', () => {
    const s = behaelterSicht(ctx, plan, aus, 6 * 60 + 45);
    expect(Object.values(s).every((b) => b.status === 'halle')).toBe(true);
    expect(s['AL-N']).toMatchObject({ tourId: 'T1', gangfolgePos: 2 });
    expect(s['WI-O']).toMatchObject({ tourId: 'T6', gangfolgePos: 2 });
  });

  it('beim Beladen: letzter Bezirk zuerst ins Fahrzeug, bei Abfahrt alles verladen', () => {
    const lz = ladeZeiten(aus, 'T1');
    expect(lz.get('BI-O')!).toBeLessThan(lz.get('AL-S')!);
    const mitte = behaelterSicht(ctx, plan, aus, (t1.start + t1.abfahrt!) / 2);
    const status = ['AL-S', 'AL-N', 'BI-W', 'BI-M', 'BI-O'].map((b) => mitte[b].status);
    expect(status.filter((x) => x === 'verladen').length).toBeGreaterThan(0);
    expect(status.filter((x) => x === 'halle').length).toBeGreaterThan(0);
    const ab = behaelterSicht(ctx, plan, aus, t1.abfahrt! + 1);
    expect(['AL-S', 'AL-N', 'BI-W', 'BI-M', 'BI-O'].every((b) => ab[b].status === 'unterwegs')).toBe(true);
  });

  it('nach dem ersten Bezirk ist dessen Behälter zugestellt', () => {
    const s = behaelterSicht(ctx, plan, aus, t1.schritte[0].ende + 0.1);
    expect(s['AL-S'].status).toBe('zugestellt');
    expect(s['AL-N'].status).toBe('unterwegs');
  });

  it('Fahrzeug: Status, nächster Stopp mit Restzeit, Fortschritt, Auslastung', () => {
    const vor = fahrzeugSicht(ctx, plan, aus, 'T1', 6 * 60 + 45);
    expect(vor.status).toBe('bereit');
    expect(vor.naechster!.name).toBe('Altdorf Süd');
    expect(vor.auslastung).toBeGreaterThan(1);

    const beladen = fahrzeugSicht(ctx, plan, aus, 'T1', t1.start + 10);
    expect(beladen.status).toBe('beladen');

    const unterwegs = fahrzeugSicht(ctx, plan, aus, 'T1', t1.abfahrt! + 2);
    expect(unterwegs.status).toBe('unterwegs');
    expect(unterwegs.naechster!.restMin).toBeCloseTo(t1.schritte[0].ankunft - (t1.abfahrt! + 2), 6);
    expect(unterwegs.ladung).toHaveLength(5);

    const imBezirk = fahrzeugSicht(ctx, plan, aus, 'T1', t1.schritte[1].ankunft + 1);
    expect(imBezirk.naechster!.vorOrt).toBe(true);
    expect(imBezirk.statusText).toMatch(/Stellt zu in Altdorf Nord/);

    const rueck = fahrzeugSicht(ctx, plan, aus, 'T1', t1.rueckfahrt!.abfahrt + 1);
    expect(rueck.status).toBe('rueckfahrt');
    expect(rueck.naechster!.art).toBe('basis');

    const zurueck = fahrzeugSicht(ctx, plan, aus, 'T1', t1.ende + 1);
    expect(zurueck.status).toBe('zurueck');
    expect(zurueck.fortschritt).toBe(1);
  });
});
