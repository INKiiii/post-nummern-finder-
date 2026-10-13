import { describe, expect, it } from 'vitest';
import { lichtZurZeit, mische } from '../src/szene/licht';

describe('Licht nach Uhrzeit', () => {
  it('mittags hoch im Süden, morgens tief im Osten, abends im Westen', () => {
    const mittag = lichtZurZeit(13 * 60);
    const morgen = lichtZurZeit(6 * 60 + 15);
    const abend = lichtZurZeit(18 * 60 + 45);
    expect(mittag.hoeheGrad).toBeGreaterThan(45);
    expect(mittag.sonne[2]).toBeGreaterThan(0.3); // Süden = +z
    expect(morgen.hoeheGrad).toBeLessThan(15);
    expect(morgen.sonne[0]).toBeGreaterThan(0.5); // Osten = +x
    expect(abend.sonne[0]).toBeLessThan(-0.5);
    expect(mittag.sonnenStaerke).toBeGreaterThan(morgen.sonnenStaerke);
    expect(lichtZurZeit(23 * 60).nacht).toBeGreaterThan(0.9);
    const n = Math.hypot(...mittag.sonne);
    expect(n).toBeCloseTo(1, 6);
  });

  it('mischt Farben', () => {
    expect(mische('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mische('#102030', '#102030', 0.3)).toBe('#102030');
  });
});
