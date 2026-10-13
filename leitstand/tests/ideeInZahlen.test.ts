import { describe, expect, it } from 'vitest';
import { standardAnnahmen } from '../src/config';
import { berechneIdeeInZahlen, ersparnisAnteile } from '../src/core/ideeInZahlen';
import { demoWelt } from './hilfen';

describe('Idee in Zahlen', () => {
  const a = standardAnnahmen();
  const z = berechneIdeeInZahlen(demoWelt(), a);

  it('Alltag: der Leitstand spart jeden Tag, ohne dass etwas liegen bleibt', () => {
    const { alltag } = z;
    expect(alltag.wiederkehrend).toBe(true);
    expect(alltag.delta.euroTag).toBeGreaterThan(100);
    expect(alltag.delta.euroJahr).toBeCloseTo(alltag.delta.euroTag * a.zustelltageProJahr, 6);
    expect(alltag.delta.ueberstundenMin).toBeLessThan(0);
    expect(alltag.delta.km).toBeLessThan(0);
    expect(alltag.mit.aus.liegen.behaelter).toHaveLength(0);
    // Anteile ergeben zusammen die Ersparnis
    const t = ersparnisAnteile(alltag.ohne.aus, alltag.mit.aus);
    expect(t.schicht + t.ueberstunden + t.km + t.fahrzeug).toBeCloseTo(alltag.delta.euroTag, 6);
    expect(z.vorschlaege.some((v) => v.art === 'tourEinsparen')).toBe(true);
  });

  it('Szenarien: Ausfall und Panne retten Behälter, der Spitzentag baut Überstunden ab', () => {
    const art = (x: string) => z.szenarien.find((s) => s.art === x)!;
    expect(z.szenarien.map((s) => s.art)).toEqual(['ausfall', 'defekt', 'stau', 'spitzentag']);
    const ausfall = art('ausfall');
    expect(ausfall.gerettet.behaelter.length).toBe(ausfall.ohne.aus.liegen.behaelter.length);
    expect(ausfall.gerettet.menge.pakete).toBeGreaterThan(0);
    expect(ausfall.alternative!.delta.euroTag).toBeGreaterThan(0); // günstiger als ein Springer
    const panne = art('defekt');
    expect(panne.ohne.aus.liegen.behaelter.length).toBeGreaterThan(0);
    expect(panne.gerettet.behaelter.length).toBeGreaterThan(0);
    const stau = art('stau');
    expect(stau.mit.aus.summe.km).toBeGreaterThan(stau.ohne.aus.summe.km);
    const spitze = art('spitzentag');
    expect(spitze.ohne.aus.summe.ueberstundenMin).toBeGreaterThan(60);
    expect(spitze.delta.ueberstundenMin).toBeLessThan(-60);
  });

  it('rechnet mit den Annahmen: höherer Stundensatz → höhere Ersparnis', () => {
    const teurer = berechneIdeeInZahlen(demoWelt(), { ...a, stundensatz: a.stundensatz + 10 });
    expect(teurer.alltag.delta.euroTag).toBeGreaterThan(z.alltag.delta.euroTag);
  });
});
