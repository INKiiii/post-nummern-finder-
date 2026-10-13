import { describe, expect, it } from 'vitest';
import { schichtMin } from '../src/config';
import { behaelterFolge, bewertePlan, erstelleKontext, planAusFolgen } from '../src/core/modell';
import { Problem, optimiere } from '../src/core/optimierer';
import { zufall } from '../src/core/rng';
import { demo } from './hilfen';

function permutationen<T>(liste: T[]): T[][] {
  if (liste.length <= 1) return [liste];
  return liste.flatMap((x, i) => permutationen([...liste.slice(0, i), ...liste.slice(i + 1)]).map((r) => [x, ...r]));
}

describe('Reihenfolge je Tour', () => {
  const { ctx, plan } = demo();
  const p = new Problem(ctx, plan);

  it('Brute Force (bis 7 Gebiete) findet die kürzeste Reihenfolge', () => {
    const folge = ['LI-N', 'EI-S', 'SE-O', 'LI-S', 'WI-W', 'LI-M'];
    const best = p.ordne('T2', folge);
    const minimum = Math.min(...permutationen(folge).map((f) => p.kmZwischen('T2', f)));
    expect(p.kmZwischen('T2', best)).toBeCloseTo(minimum, 9);
    expect([...best].sort()).toEqual([...folge].sort());
  });

  it('2-opt (ab 8 Gebieten) liefert eine gültige, nicht schlechtere Reihenfolge', () => {
    const folge = ['SE-W', 'AL-N', 'LI-M', 'MB-O', 'EI-N', 'BI-W', 'WI-O', 'RO-W', 'KI-S'];
    const r = p.ordne('T1', folge);
    expect([...r].sort()).toEqual([...folge].sort());
    expect(p.kmZwischen('T1', r)).toBeLessThan(p.kmZwischen('T1', folge));
  });

  it('Schnellbewertung stimmt mit dem vollständigen Rechenmodell überein', () => {
    const rng = zufall(7);
    for (let n = 0; n < 20; n++) {
      const folgen: Record<string, string[]> = { T1: [], T2: [], T3: [], T4: [], T5: [], T6: [] };
      for (const b of ctx.tag.behaelterIds) folgen[`T${rng.ganz(1, 6)}`].push(b);
      const aus = bewertePlan(ctx, planAusFolgen(folgen));
      for (const id of Object.keys(folgen)) {
        const schnell = p.tour(id, folgen[id]);
        expect(schnell.dauer).toBeCloseTo(aus.touren[id].dauer, 6);
        expect(schnell.kosten).toBeCloseTo(aus.touren[id].kosten.summe, 6);
        expect(schnell.km).toBeCloseTo(aus.touren[id].km.gesamt, 6);
      }
    }
  });
});

describe('Optimierer', () => {
  it('Startplan: alle Behälter zugestellt, keine Tour über Schicht, eine Tour weniger, billiger', () => {
    const { ctx, plan, a } = demo();
    const alt = bewertePlan(ctx, plan);
    const neu = bewertePlan(ctx, optimiere(ctx, plan));
    expect(neu.fehler).toEqual([]);
    expect(neu.liegen.behaelter).toEqual([]);
    for (const id of neu.tourIds) expect(neu.touren[id].dauer).toBeLessThanOrEqual(schichtMin(a) + 1e-6);
    expect(neu.summe.aktiveTouren).toBe(5);
    expect(neu.summe.kosten.summe).toBeLessThan(alt.summe.kosten.summe - 200);
  });

  it('ist deterministisch', () => {
    const { ctx, plan } = demo();
    expect(JSON.stringify(optimiere(ctx, plan))).toBe(JSON.stringify(optimiere(ctx, plan)));
  });

  it('nur Reihenfolge: gleiche Zuordnung, weniger km', () => {
    const { ctx, plan } = demo();
    const neu = optimiere(ctx, plan, { nurReihenfolge: true });
    for (const id of Object.keys(plan.touren)) expect([...behaelterFolge(neu, id)].sort()).toEqual([...behaelterFolge(plan, id)].sort());
    expect(bewertePlan(ctx, neu).summe.km).toBeLessThan(bewertePlan(ctx, plan).summe.km);
  });

  it('Zufallspläne: Ergebnis gültig, nie teurer, keine neuen Überstunden', () => {
    const { ctx, a } = demo();
    const rng = zufall(42);
    for (let n = 0; n < 8; n++) {
      const folgen: Record<string, string[]> = { T1: [], T2: [], T3: [], T4: [], T5: [], T6: [] };
      for (const b of ctx.tag.behaelterIds) folgen[`T${rng.ganz(1, 6)}`].push(b);
      const plan = planAusFolgen(folgen);
      const alt = bewertePlan(ctx, plan);
      const neu = bewertePlan(ctx, optimiere(ctx, plan));
      expect(neu.gueltig).toBe(true);
      expect(neu.liegen.behaelter).toHaveLength(0);
      expect(neu.summe.kosten.summe).toBeLessThanOrEqual(alt.summe.kosten.summe + 1e-6);
      expect(neu.summe.ueberstundenMin).toBeLessThanOrEqual(alt.summe.ueberstundenMin + 1e-6);
      for (const id of neu.tourIds) expect(neu.touren[id].dauer).toBeLessThanOrEqual(schichtMin(a) + 1e-6);
    }
  });

  it('gesperrte Tour bekommt keine Behälter', () => {
    const { ctx, plan } = demo();
    const neu = optimiere(ctx, plan, { gesperrteTouren: ['T2', 'T6'] });
    expect(behaelterFolge(neu, 'T2')).toEqual([]);
    expect(behaelterFolge(neu, 'T6')).toEqual([]);
    expect(bewertePlan(ctx, neu).gueltig).toBe(true);
  });

  it('Spitzentag (+40 %): Überstunden werden minimiert, aber nicht versteckt', () => {
    const { ctx, plan } = demo(1.4);
    const alt = bewertePlan(ctx, plan);
    const neu = bewertePlan(ctx, optimiere(ctx, plan));
    expect(neu.gueltig).toBe(true);
    expect(neu.liegen.behaelter).toHaveLength(0);
    expect(neu.summe.ueberstundenMin).toBeGreaterThan(0);
    expect(neu.summe.ueberstundenMin).toBeLessThan(alt.summe.ueberstundenMin / 3);
  });

  it('Ausfall: unbesetzte Tour wird umverteilt; Liegenlassen nur, wenn sonst die Schicht reißt', () => {
    const { welt, tag, plan, a } = demo();
    tag.start.T3 = { ...tag.start.T3, besetzt: false };
    const ctx = erstelleKontext(welt, tag, a);
    expect(bewertePlan(ctx, plan).gueltig).toBe(false);
    const neu = bewertePlan(ctx, optimiere(ctx, plan, { liegenLassenErlaubt: true }));
    expect(neu.fehler).toEqual([]);
    expect(neu.touren.T3.aktiv).toBe(false);
    for (const id of neu.tourIds) expect(neu.touren[id].dauer).toBeLessThanOrEqual(schichtMin(a) + 1e-6);
    // an einem normalen Tag reicht die Kapazität der übrigen 5 Touren
    expect(neu.liegen.behaelter).toEqual([]);

    // am Spitzentag mit zwei Ausfällen bleibt etwas liegen, aber niemand muss über die Schicht
    const s = demo(1.4);
    s.tag.start.T3 = { ...s.tag.start.T3, besetzt: false };
    s.tag.start.T5 = { ...s.tag.start.T5, besetzt: false };
    const ctx2 = erstelleKontext(s.welt, s.tag, s.a);
    const neu2 = bewertePlan(ctx2, optimiere(ctx2, s.plan, { liegenLassenErlaubt: true }));
    expect(neu2.fehler).toEqual([]);
    expect(neu2.liegen.behaelter.length).toBeGreaterThan(0);
    for (const id of neu2.tourIds) expect(neu2.touren[id].dauer).toBeLessThanOrEqual(schichtMin(s.a) + 1e-6);
  });

  it('abgefahrene Fahrzeuge: Behälter an Bord bleiben, nur die Reihenfolge darf sich ändern', () => {
    const { welt, tag, plan, a } = demo();
    // Tour 2 ist schon unterwegs und hat ihre Behälter an Bord
    tag.start.T2 = { ...tag.start.T2, mussLaden: false, geladen: behaelterFolge(plan, 'T2'), zeit: 460, bisher: { ...tag.start.T2.bisher, min: { ...tag.start.T2.bisher.min, laden: 30, fahrtZwischen: 10 }, kmZwischen: 7.5 } };
    const ctx = erstelleKontext(welt, tag, a);
    const neu = optimiere(ctx, plan);
    expect([...behaelterFolge(neu, 'T2')].sort()).toEqual([...behaelterFolge(plan, 'T2')].sort());
    const aus = bewertePlan(ctx, neu);
    expect(aus.fehler).toEqual([]);
    expect(aus.touren.T2.ladung).toEqual([]);
  });
});
