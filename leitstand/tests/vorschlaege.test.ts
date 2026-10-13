import { describe, expect, it } from 'vitest';
import { schichtMin } from '../src/config';
import { behaelterFolge, bewertePlan, vergleiche } from '../src/core/modell';
import { erzeugeVorschlaege, optionenFuerBehaelter, planSignatur } from '../src/core/vorschlaege';
import { demo } from './hilfen';

describe('Vorschläge zum Startplan', () => {
  const { ctx, plan, a } = demo();
  const alt = bewertePlan(ctx, plan);
  const liste = erzeugeVorschlaege(ctx, plan);
  const art = (x: string) => liste.find((v) => v.art === x);

  it('enthält Tour einsparen, Überlastung abbauen, Reihenfolge ändern und den Gesamtplan', () => {
    expect(art('tourEinsparen')).toBeDefined();
    expect(art('ueberlastung')).toBeDefined();
    expect(art('reihenfolge')).toBeDefined();
    expect(art('gesamt')).toBeDefined();
    expect(liste.at(-1)!.art).toBe('gesamt');
  });

  it('jeder Vorschlag: gültiger Plan, Deltas stimmen mit Neuberechnung, keine Dubletten', () => {
    const signaturen = new Set<string>();
    for (const v of liste) {
      const neu = bewertePlan(ctx, v.plan);
      expect(neu.fehler).toEqual([]);
      const d = vergleiche(alt, neu, a);
      expect(v.delta.euroTag).toBeCloseTo(d.euroTag, 6);
      expect(v.delta.euroJahr).toBeCloseTo(d.euroTag * a.zustelltageProJahr, 6);
      expect(v.delta.km).toBeCloseTo(d.km, 6);
      expect(v.delta.betroffen.length).toBeGreaterThan(0);
      expect(v.delta.euroTag).toBeGreaterThan(0);
      signaturen.add(planSignatur(v.plan));
    }
    expect(signaturen.size).toBe(liste.length);
  });

  it('Tour einsparen: kleinste Änderung, Tour 6 entfällt, keine neuen Überstunden', () => {
    const v = art('tourEinsparen')!;
    expect(v.titel).toBe('Tour 6 einsparen');
    expect(v.delta.aktiveTouren).toBe(-1);
    expect(v.aenderungen.every((x) => x.von === 'T6')).toBe(true);
    expect(v.delta.euroTag).toBeGreaterThan(200);
    for (const id of v.neu.tourIds) expect(v.neu.touren[id].ueberstundenMin).toBeLessThanOrEqual(alt.touren[id].ueberstundenMin + 0.5);
    expect(v.text).toMatch(/Tour 6 entfällt/);
  });

  it('Überlastung abbauen: Tour 1 ohne Überstunden', () => {
    const v = art('ueberlastung')!;
    expect(v.neu.touren.T1.ueberstundenMin).toBe(0);
    expect(v.delta.ueberstundenMin).toBeLessThan(0);
    expect(v.delta.betroffen).toContain('T1');
  });

  it('Reihenfolge ändern: Tour 2 behält ihre Behälter, fährt aber kürzer', () => {
    const v = liste.find((x) => x.art === 'reihenfolge' && x.reihenfolge.includes('T2'))!;
    expect(v.aenderungen).toEqual([]);
    expect(v.delta.km).toBeLessThan(-1);
    expect(v.delta.betroffen).toEqual(['T2']);
  });

  it('Gesamtplan: keine Tour über der Schicht', () => {
    const v = art('gesamt')!;
    for (const id of v.neu.tourIds) expect(v.neu.touren[id].dauer).toBeLessThanOrEqual(schichtMin(a) + 1e-6);
  });
});

describe('Vorschläge am Spitzentag und bei Ausfall', () => {
  it('Spitzentag: Vorschläge nennen, wo Überstunden drohen', () => {
    const { ctx, plan } = demo(1.4);
    const liste = erzeugeVorschlaege(ctx, plan);
    expect(liste.some((v) => v.art === 'tourEinsparen')).toBe(false);
    const ue = liste.find((v) => v.art === 'ueberlastung')!;
    expect(ue).toBeDefined();
    expect(liste.some((v) => /Überstunden drohen bei Tour \d/.test(v.warnung ?? ''))).toBe(true);
  });

  it('Ausfall: Vorschlag „Ausfall auffangen“ steht oben und verteilt alle Behälter', () => {
    const d = demo();
    d.tag.start.T4 = { ...d.tag.start.T4, besetzt: false };
    const liste = erzeugeVorschlaege({ ...d.ctx, tag: d.tag }, d.plan, { wiederkehrend: false });
    expect(liste[0].art).toBe('ausfall');
    expect(liste[0].wiederkehrend).toBe(false);
    expect(behaelterFolge(liste[0].plan, 'T4')).toEqual([]);
    expect(liste[0].neu.fehler).toEqual([]);
  });
});

describe('„Andere Tour“ für einen Behälter', () => {
  const { ctx, plan, a } = demo();

  it('listet alle Touren mit Dauer danach, Δ km, Δ €/Jahr und genau einer besten Wahl', () => {
    const o = optionenFuerBehaelter(ctx, plan, 'WI-O');
    expect(o).toHaveLength(6);
    expect(o.filter((x) => x.aktuell).map((x) => x.tourId)).toEqual(['T6']);
    expect(o.filter((x) => x.beste)).toHaveLength(1);
    for (const x of o) {
      expect(x.delta.euroJahr).toBeCloseTo(x.delta.euroTag * a.zustelltageProJahr, 6);
      expect(x.auswertung.fehler).toEqual([]);
      if (!x.aktuell) expect(behaelterFolge(x.plan, x.tourId)).toContain('WI-O');
    }
    // Wechsel in die schon überlastete Tour 1 ist nicht machbar
    expect(o.find((x) => x.tourId === 'T1')!.machbar).toBe(false);
  });

  it('Behälter an Bord eines abgefahrenen Fahrzeugs: keine einfachen Optionen (Übergabe nötig)', () => {
    const d = demo();
    d.tag.start.T6 = { ...d.tag.start.T6, mussLaden: false, geladen: ['KI-N', 'WI-O'] };
    expect(optionenFuerBehaelter({ ...d.ctx, tag: d.tag }, d.plan, 'WI-O')).toEqual([]);
  });
});
