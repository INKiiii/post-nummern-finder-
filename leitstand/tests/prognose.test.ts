import { describe, expect, it } from 'vitest';
import { standardAnnahmen } from '../src/config';
import { Lagebild } from '../src/core/lagebild';
import { bewertePlan, erstelleKontext, type Kontext } from '../src/core/modell';
import { SimulierteScanner } from '../src/core/simulation';
import { rechenwegTourZeit } from '../src/core/rechenweg';
import { demo } from './hilfen';

describe('Prognose: Lagebild und Rechenmodell rechnen mit demselben Tempo', () => {
  it('Rückkehr laut Tourliste und laut Vorschlägen liegen beieinander', () => {
    const d = demo();
    const ctx = erstelleKontext(d.welt, d.tag, standardAnnahmen());
    const sim = new SimulierteScanner(ctx, d.plan, {});
    const lage = new Lagebild(ctx, d.plan);
    const abweichung: number[] = [];
    let mitTempo = 0;
    for (const z of [9 * 60, 10 * 60, 12 * 60]) {
      for (const e of sim.vorspulen(z)) lage.anwenden(e);
      const start = lage.startZustaende(z);
      const c: Kontext = { ...ctx, tag: { ...ctx.tag, start } };
      const aus = bewertePlan(c, lage.restplan(start));
      for (const t of ctx.tag.touren) {
        const f = lage.fahrzeug(t.id);
        if (f.phase !== 'unterwegs') continue;
        abweichung.push(Math.abs(lage.prognose(t.id, z).rueckkehr - aus.touren[t.id].ende));
        if (Math.abs(aus.touren[t.id].min.tempo) > 0.5) {
          mitTempo++;
          // der Rechenweg nennt das Tempo als eigene Zeile
          expect(rechenwegTourZeit(c, aus.touren[t.id]).zeilen.some((x) => x.was === 'Tempo laut Scans')).toBe(true);
        }
      }
    }
    expect(abweichung.length).toBeGreaterThan(5);
    expect(mitTempo).toBeGreaterThan(0);
    expect(Math.max(...abweichung)).toBeLessThan(4);
  });
});
