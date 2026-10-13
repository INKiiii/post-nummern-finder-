import { describe, expect, it } from 'vitest';
import { schichtMin } from '../src/config';
import { Lagebild, zusammenfuehren } from '../src/core/lagebild';
import { behaelterFolge, bewertePlan, erstelleKontext } from '../src/core/modell';
import { optimiere } from '../src/core/optimierer';
import { punktBei, sBeiZeit } from '../src/core/route';
import { SimulierteScanner } from '../src/core/simulation';
import type { SimOptionen } from '../src/core/simulation';
import { demo } from './hilfen';

function tag(opt: SimOptionen = {}) {
  const d = demo();
  const sim = new SimulierteScanner(d.ctx, d.plan, opt);
  const lage = new Lagebild(d.ctx, d.plan);
  const bis = (t: number) => {
    for (const e of sim.vorspulen(t)) lage.anwenden(e);
  };
  return { ...d, sim, lage, bis };
}

describe('Lagebild aus dem Ereignisstrom', () => {
  it('vor der Schicht: alles in der Halle, Fahrzeuge an der Rampe, Pakete bekannt', () => {
    const { lage, bis, ctx } = tag();
    bis(6 * 60 + 50);
    for (const b of ctx.tag.behaelterIds) expect(lage.behaelter(b).status).toBe('halle');
    for (const t of ctx.tag.touren) expect(lage.fahrzeug(t.id).phase).toBe('rampe');
    expect(lage.bezirk('LI-S').pakete.gesamt).toBe(ctx.tag.behaelter['LI-S'].inhalt.pakete);
    expect(lage.pose('T1', 6 * 60 + 50).anRampe).toBe(true);
  });

  it('Beladen: Behälter im Fahrzeug, per Barcode oder abgeleitet aus den Paketscans', () => {
    for (const barcode of [true, false]) {
      const { lage, bis, ctx, plan } = tag({ behaelterBarcode: barcode });
      bis(7 * 60 + 15);
      expect(lage.fahrzeug('T1').phase).toBe('laedt');
      bis(8 * 60);
      for (const t of ctx.tag.touren) {
        for (const b of behaelterFolge(plan, t.id)) {
          const x = lage.behaelter(b);
          expect(x.fahrzeugId).toBe(t.fahrzeugId);
          expect(x.status === 'unterwegs' || x.status === 'zugestellt').toBe(true);
          expect(x.quelle).toBe(barcode ? 'barcode' : 'pakete');
        }
      }
    }
  });

  it('angezeigte Position folgt der Ist-Position (mit einer Minute Verzögerung)', () => {
    const { lage, bis, sim, ctx } = tag();
    const fehler: number[] = [];
    for (let t = 7 * 60 + 40; t <= 15 * 60; t += 7) {
      bis(t);
      for (const tour of ctx.tag.touren) {
        const ist = sim.wahrePosition(tour.id, t - 1);
        const f = lage.fahrzeug(tour.id);
        if (!ist || f.phase !== 'unterwegs') continue;
        const p = lage.pose(tour.id, t);
        fehler.push(Math.hypot(p.x - ist.x, p.y - ist.y));
      }
    }
    fehler.sort((a, b) => a - b);
    expect(fehler.length).toBeGreaterThan(100);
    expect(fehler[Math.floor(fehler.length * 0.9)]).toBeLessThan(0.35);
    expect(fehler[Math.floor(fehler.length * 0.5)]).toBeLessThan(0.08);
  });

  it('Briefe: geschätzter Fortschritt steigt monoton bis 100 %, Pakete exakt aus Scans', () => {
    const { lage, bis, ctx } = tag();
    let vorher = 0;
    let mitte = false;
    for (let t = 7 * 60; t <= 18 * 60; t += 5) {
      bis(t);
      const bz = lage.bezirk('LI-N');
      expect(bz.briefeAnteil).toBeGreaterThanOrEqual(vorher - 1e-9);
      if (bz.briefeAnteil > 0.2 && bz.briefeAnteil < 0.8) mitte = true;
      vorher = bz.briefeAnteil;
    }
    expect(mitte).toBe(true);
    const bz = lage.bezirk('LI-N');
    expect(bz.fertig).toBe(true);
    expect(bz.briefeAnteil).toBe(1);
    expect(bz.pakete.zugestellt + bz.pakete.nicht).toBe(ctx.tag.behaelter['LI-N'].inhalt.pakete);
    expect(lage.behaelter('LI-N').status).toBe('zugestellt');
  });

  it('Prognose der Rückkehr ist am Vormittag schon recht genau', () => {
    const { lage, bis, sim, ctx } = tag();
    bis(10 * 60);
    for (const t of ctx.tag.touren) {
      const p = lage.prognose(t.id, 10 * 60);
      expect(Math.abs(p.rueckkehr - sim.istAblauf(t.id)!.ende)).toBeLessThan(30);
      expect(p.fortschritt).toBeGreaterThan(0);
      expect(p.naechster).not.toBeNull();
    }
    bis(22 * 60);
    for (const t of ctx.tag.touren) {
      expect(lage.fahrzeug(t.id).phase).toBe('zurueck');
      expect(lage.prognose(t.id, 22 * 60).rueckkehr).toBeCloseTo(sim.istAblauf(t.id)!.ende, 6);
    }
  });

  it('Startzustände aus dem Lagebild: gültig für Rechenmodell und Optimierer', () => {
    const { lage, bis, sim, ctx, welt, a } = tag();
    for (const t of [7 * 60 + 10, 9 * 60, 11 * 60 + 30, 13 * 60 + 45, 20 * 60]) {
      bis(t);
      const start = lage.startZustaende(t);
      const ctxLive = erstelleKontext(welt, { ...ctx.tag, start }, a);
      const rest = lage.restplan(start);
      const aus = bewertePlan(ctxLive, rest);
      expect(aus.fehler).toEqual([]);
      for (const tour of ctx.tag.touren) {
        expect(Math.abs(aus.touren[tour.id].ende - sim.istAblauf(tour.id)!.ende)).toBeLessThan(35);
      }
      const opt = bewertePlan(ctxLive, optimiere(ctxLive, rest));
      expect(opt.fehler).toEqual([]);
      expect(opt.summe.kosten.summe).toBeLessThanOrEqual(aus.summe.kosten.summe + 1e-6);
      // Tagesplan = Erledigtes + Rest
      const tagesplan = zusammenfuehren(lage.plan, rest, start);
      for (const tour of ctx.tag.touren) expect(behaelterFolge(tagesplan, tour.id)).toEqual(behaelterFolge(lage.plan, tour.id));
      void schichtMin;
    }
  });

  it('Umplanung unterwegs: Leitstand und Fahrzeug nutzen denselben Umschaltpunkt', () => {
    const { lage, bis, sim, ctx, plan } = tag();
    bis(9 * 60);
    const neu = structuredClone(plan);
    const f = behaelterFolge(plan, 'T2');
    neu.touren.T2.schritte = [f[0], f[2], f[3], f[1]].map((b) => ({ art: 'bezirk' as const, behaelterId: b }));
    const commits = lage.planSetzen(ctx, neu, 9 * 60);
    sim.planAktualisieren(ctx, neu, 9 * 60, commits);
    let neben = 0;
    let gesamt = 0;
    for (let t = 9 * 60; t <= 18 * 60; t += 3) {
      bis(t);
      const ist = sim.wahrePosition('T2', t);
      if (!ist) continue;
      const r = lage.fahrzeug('T2').route;
      const s = sBeiZeit(sim.istAblauf('T2')!.zp, t);
      const p = punktBei(r, s);
      gesamt++;
      if (Math.hypot(p.x - ist.x, p.y - ist.y) > 0.05) neben++;
    }
    expect(gesamt).toBeGreaterThan(50);
    expect(neben / gesamt).toBeLessThan(0.05);
    bis(22 * 60);
    expect(lage.fahrzeug('T2').phase).toBe('zurueck');
    for (const b of f) expect(lage.behaelter(b).status).toBe('zugestellt');
  });
});
