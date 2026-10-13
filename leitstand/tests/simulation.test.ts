import { describe, expect, it } from 'vitest';
import { behaelterFolge, bewertePlan } from '../src/core/modell';
import type { ScanEreignis } from '../src/core/scan';
import { SimulierteScanner, abstandZurRoute } from '../src/core/simulation';
import { demo } from './hilfen';

function ganzerTag(opt = {}) {
  const d = demo();
  const sim = new SimulierteScanner(d.ctx, d.plan, opt);
  const alle = sim.vorspulen(22 * 60);
  return { ...d, sim, alle };
}

describe('SimulierteScanner', () => {
  const { ctx, plan, sim, alle } = ganzerTag();
  const art = (a: ScanEreignis['art']) => alle.filter((e) => e.art === a);

  it('liefert alle Ereignisarten in zeitlicher Reihenfolge mit laufender Nummer', () => {
    for (let i = 1; i < alle.length; i++) {
      expect(alle[i].zeit).toBeGreaterThanOrEqual(alle[i - 1].zeit);
      expect(alle[i].nr).toBe(alle[i - 1].nr + 1);
    }
    const arten = new Set(alle.map((e) => e.art));
    for (const a of ['PAKET_EINGANG_BASIS', 'BEHAELTER_VERLADEN', 'PAKET_IN_FAHRZEUG', 'TOUR_START', 'POSITION', 'ZUSTELLUNG', 'NICHT_ZUGESTELLT', 'TOUR_ENDE'] as const) {
      expect(arten.has(a)).toBe(true);
    }
  });

  it('jedes Paket: Eingang, im Fahrzeug, zugestellt oder nicht zugestellt', () => {
    const anzahl = ctx.tag.behaelterIds.reduce((s, b) => s + ctx.tag.behaelter[b].inhalt.pakete, 0);
    expect(art('PAKET_EINGANG_BASIS')).toHaveLength(anzahl);
    expect(art('PAKET_IN_FAHRZEUG')).toHaveLength(anzahl);
    expect(art('ZUSTELLUNG').length + art('NICHT_ZUGESTELLT').length).toBe(anzahl);
    expect(art('NICHT_ZUGESTELLT').length).toBeGreaterThan(0);
    expect(art('NICHT_ZUGESTELLT').length).toBeLessThan(anzahl * 0.08);
  });

  it('je Tour ein Start und ein Ende, je Behälter genau ein Verladescan', () => {
    expect(art('TOUR_START')).toHaveLength(6);
    expect(art('TOUR_ENDE')).toHaveLength(6);
    expect(art('BEHAELTER_VERLADEN').map((e) => (e as { behaelter: string }).behaelter).sort()).toEqual([...ctx.tag.behaelterIds].sort());
  });

  it('Positionen nur während der Tour, im Minutentakt, nah an der Ist-Route', () => {
    for (const t of ctx.tag.touren) {
      const start = art('TOUR_START').find((e) => (e as { tour: string }).tour === t.id)!;
      const ende = art('TOUR_ENDE').find((e) => (e as { tour: string }).tour === t.id)!;
      const pos = art('POSITION').filter((e) => (e as { fahrzeug: string }).fahrzeug === t.fahrzeugId);
      expect(pos.length).toBeGreaterThan((ende.zeit - start.zeit) * 0.95);
      for (const p of pos) {
        expect(p.zeit).toBeGreaterThanOrEqual(start.zeit - 1e-9);
        expect(p.zeit).toBeLessThanOrEqual(ende.zeit + 1e-9);
      }
      const ist = sim.istAblauf(t.id)!;
      for (const p of pos.filter((_, i) => i % 10 === 0)) expect(abstandZurRoute(ist.route, p as { x: number; y: number })).toBeLessThan(0.025);
    }
  });

  it('der Ist-Ablauf weicht leicht vom Plan ab (Streuung), ohne Streuung entspricht er dem Rechenmodell', () => {
    const aus = bewertePlan(ctx, plan);
    const abweichung = ctx.tag.touren.map((t) => Math.abs(sim.istAblauf(t.id)!.ende - aus.touren[t.id].ende));
    expect(Math.max(...abweichung)).toBeGreaterThan(1);
    expect(Math.max(...abweichung)).toBeLessThan(60);
    const ohne = ganzerTag({ streuung: false });
    for (const t of ctx.tag.touren) expect(ohne.sim.istAblauf(t.id)!.ende).toBeCloseTo(aus.touren[t.id].ende, 6);
  });

  it('ohne Barcode-Etikett gibt es keine Verladescans der Behälter', () => {
    const { alle: ohne } = ganzerTag({ behaelterBarcode: false });
    expect(ohne.some((e) => e.art === 'BEHAELTER_VERLADEN')).toBe(false);
    expect(ohne.some((e) => e.art === 'PAKET_IN_FAHRZEUG')).toBe(true);
  });

  it('ist deterministisch', () => {
    const b = ganzerTag().alle;
    expect(JSON.stringify(b.slice(0, 2000))).toBe(JSON.stringify(alle.slice(0, 2000)));
    expect(b.length).toBe(alle.length);
  });

  it('Umplanung unterwegs: neue Reihenfolge gilt nach dem laufenden Bezirk', () => {
    const d = demo();
    const sim2 = new SimulierteScanner(d.ctx, d.plan);
    sim2.vorspulen(9 * 60);
    const neu = structuredClone(d.plan);
    const folge = behaelterFolge(d.plan, 'T2');
    neu.touren.T2.schritte = [folge[0], folge[2], folge[3], folge[1]].map((b) => ({ art: 'bezirk' as const, behaelterId: b }));
    sim2.planAktualisieren(d.ctx, neu, 9 * 60);
    const rest = sim2.vorspulen(22 * 60);
    const ende = rest.filter((e) => e.art === 'TOUR_ENDE' && e.tour === 'T2');
    expect(ende).toHaveLength(1);
    // Pakete von T2 werden trotzdem alle gescannt
    const t2 = d.tag.touren.find((t) => t.id === 'T2')!;
    const zugestellt = rest.filter((e) => (e.art === 'ZUSTELLUNG' || e.art === 'NICHT_ZUGESTELLT') && e.fahrzeug === t2.fahrzeugId).length;
    expect(zugestellt).toBeGreaterThan(0);
  });
});
