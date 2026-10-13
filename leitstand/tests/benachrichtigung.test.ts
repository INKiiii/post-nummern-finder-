import { describe, expect, it } from 'vitest';
import { umplanungsNachrichten } from '../src/core/benachrichtigung';
import { Lagebild } from '../src/core/lagebild';
import { bewertePlan, type Kontext } from '../src/core/modell';
import { SimulierteScanner } from '../src/core/simulation';
import type { Plan } from '../src/core/types';
import { uebergabeZiele } from '../src/core/uebergabe';
import { erzeugeVorschlaege, optionenFuerBehaelter } from '../src/core/vorschlaege';
import { demo } from './hilfen';

const nur = (liste: ReturnType<typeof umplanungsNachrichten>, tourId: string) => liste.find((n) => n.tourId === tourId);

describe('Nachrichten an die Fahrer bei Umplanung', () => {
  it('vor der Abfahrt: anderer Behälter – „Entfällt“ bei der einen, „Neu … laden“ bei der anderen Tour', () => {
    const { ctx, plan } = demo();
    const o = optionenFuerBehaelter(ctx, plan, 'AL-S').find((x) => x.tourId === 'T2')!;
    const liste = umplanungsNachrichten(ctx, plan, o.plan, o.auswertung);
    expect(liste.map((n) => n.tourId).sort()).toEqual(['T1', 'T2']);
    expect(nur(liste, 'T1')!.text).toBe('Entfällt: Behälter AL-S (übernimmt Tour 2)');
    expect(nur(liste, 'T2')!.text).toBe('Neu: Behälter AL-S (Altdorf Süd), an Rampe 2 laden');
    expect(nur(liste, 'T2')!.titel).toBe('Umplanung');
  });

  it('Tour einsparen: die Tour erfährt, dass sie heute entfällt', () => {
    const { ctx, plan } = demo();
    const v = erzeugeVorschlaege(ctx, plan).find((x) => x.art === 'tourEinsparen')!;
    const weg = v.aenderungen[0].von!;
    const n = nur(umplanungsNachrichten(ctx, plan, v.plan, v.neu), weg)!;
    expect(n.punkte[0].art).toBe('tourEntfaellt');
    expect(n.punkte.filter((p) => p.art === 'entfaellt')).toHaveLength(v.aenderungen.length);
  });

  it('nur andere Reihenfolge: „Neue Reihenfolge“', () => {
    const { ctx, plan } = demo();
    const neu: Plan = structuredClone(plan);
    neu.touren.T2.schritte.reverse();
    const n = nur(umplanungsNachrichten(ctx, plan, neu, bewertePlan(ctx, neu)), 'T2')!;
    expect(n.punkte).toHaveLength(1);
    expect(n.text).toMatch(/^Neue Reihenfolge: /);
  });

  it('unterwegs: Übergabe mit Uhrzeit und Treffpunkt für beide Seiten, Rückgängig nimmt sie zurück', () => {
    const d = demo();
    const sim = new SimulierteScanner(d.ctx, d.plan, {});
    const lage = new Lagebild(d.ctx, d.plan);
    for (const e of sim.vorspulen(10 * 60)) lage.anwenden(e);
    const start = lage.startZustaende(10 * 60);
    const ctx: Kontext = { ...d.ctx, tag: { ...d.ctx.tag, start } };
    const rest = lage.restplan(start);
    const alt = bewertePlan(ctx, rest);
    const x = start.T1.geladen[0];
    const u = uebergabeZiele(ctx, rest, x, alt).sort((a, b) => b.delta.euroTag - a.delta.euroTag)[0];
    const zeit = `${String(Math.floor(Math.round(u.info.zeit) / 60)).padStart(2, '0')}:${String(Math.round(u.info.zeit) % 60).padStart(2, '0')}`;
    const tp = u.info.treffpunkt.name;
    const nach = u.info.nach;

    const hin = umplanungsNachrichten(ctx, rest, u.plan, u.auswertung);
    expect(hin.map((n) => n.tourId).sort()).toEqual(['T1', nach].sort());
    expect(nur(hin, 'T1')!.text).toContain(`Abgeben: Behälter ${x}, Übergabe ${zeit} am Treffpunkt ${tp} (an Tour ${nach.slice(1)})`);
    expect(nur(hin, nach)!.text).toContain(`Neu: Behälter ${x}, Übergabe ${zeit} am Treffpunkt ${tp} (von Tour 1)`);
    expect(nur(hin, nach)!.punkte.find((p) => p.art === 'neu')!.zeit).toBeCloseTo(u.info.zeit, 6);

    const zurueck = umplanungsNachrichten(ctx, u.plan, rest, alt, { altAus: u.auswertung, rueckgaengig: true });
    const t1 = nur(zurueck, 'T1')!;
    expect(t1.titel).toBe('Umplanung zurückgenommen');
    expect(t1.punkte.map((p) => p.art).sort()).toEqual(['bleibt', 'uebergabeEntfaellt']);
    expect(nur(zurueck, nach)!.text).toContain(`Entfällt: Behälter ${x} (übernimmt Tour 1)`);
    expect(nur(zurueck, nach)!.text).toContain(`Übergabe ${zeit} am Treffpunkt ${tp} entfällt.`);
  });
});
