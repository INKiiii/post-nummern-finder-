// Meine Tour: Reihenfolge A/B, nächste Straße, Bevorzugung im Straßenbezug, Nutzungszähler,
// Lückenanzeige.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { townPackages } from './town.mjs';
import { buildIndex, makeProjection } from '../src/core';
import {
  _setState,
  addToTour,
  countUse,
  getTour,
  move,
  nextTourStreet,
  orderedTour,
  resolveTourStreet,
  setFirst,
  setPart,
  tourStreetIds,
  tourSuggestions,
  SUGGEST_DAYS,
} from '../src/tour';
import { StreetMatcher } from '../src/matcher';
import { streetGaps } from '../src/gaps';
import { SYNTH_ORIGIN } from '../scripts/lib/synthetic.mjs';
import type { Index } from '../src/types';

let index: Index;
const street = (name: string) => [...index.streets.values()].find((s) => s.name === name)!;

beforeAll(() => {
  index = buildIndex(townPackages().pkgs as any);
});
beforeEach(() => _setState({ streets: [], first: 'A' }));

describe('Meine Tour', () => {
  it('Reihenfolge: heute zuerst A oder B, innerhalb eines Teils verschiebbar', async () => {
    await addToTour(street('Elbuferstraße'), 'A');
    await addToTour(street('Blumenstraße'), 'A');
    await addToTour(street('Reetweg'), 'B');
    await addToTour(street('Interpolweg'), 'B');
    expect(orderedTour().map((t) => t.name)).toEqual(['Elbuferstraße', 'Blumenstraße', 'Reetweg', 'Interpolweg']);
    await setFirst('B');
    expect(orderedTour().map((t) => t.name)).toEqual(['Reetweg', 'Interpolweg', 'Elbuferstraße', 'Blumenstraße']);
    await move(getTour().streets.find((t) => t.name === 'Interpolweg')!, -1);
    expect(orderedTour().map((t) => t.name)).toEqual(['Interpolweg', 'Reetweg', 'Elbuferstraße', 'Blumenstraße']);
    await setPart(getTour().streets.find((t) => t.name === 'Reetweg')!, 'A');
    expect(orderedTour().map((t) => t.name)).toEqual(['Interpolweg', 'Elbuferstraße', 'Blumenstraße', 'Reetweg']);
  });

  it('nächste Straße folgt der heutigen Reihenfolge', async () => {
    await addToTour(street('Elbuferstraße'), 'A');
    await addToTour(street('Blumenstraße'), 'B');
    expect(nextTourStreet(index, street('Elbuferstraße'))?.street.name).toBe('Blumenstraße');
    await setFirst('B');
    expect(nextTourStreet(index, street('Blumenstraße'))?.street.name).toBe('Elbuferstraße');
    expect(nextTourStreet(index, street('Elbuferstraße'))).toBeNull();
  });

  it('findet Tour-Straßen auch nach geänderter ID (Datenaktualisierung) über Name + Ort', () => {
    const e = street('Blumenstraße');
    expect(resolveTourStreet(index, { streetId: 'alt123', name: e.name, place: e.place, plz: e.plz, part: 'A' })?.id).toBe(e.id);
  });

  it('Straßenbezug bevorzugt Tour-Straßen', async () => {
    const proj = makeProjection(SYNTH_ORIGIN[0], SYNTH_ORIGIN[1]);
    const [lat, lon] = proj.toLatLon(205, 190);
    await addToTour(street('Schilfring'), 'A');
    const m = new StreetMatcher(() => index);
    m.preferred = tourStreetIds(index);
    expect(m.update({ lat, lon, accuracy: 8, course: null, speed: 0, time: 1 }).street?.name).toBe('Schilfring');
  });

  it('schlägt oft genutzte Straßen vor (nur Name, ab 3 Tagen, einmal pro Tag)', async () => {
    const b = street('Blumenstraße');
    for (let d = 1; d < SUGGEST_DAYS; d++) {
      await countUse(b, new Date(Date.UTC(2026, 9, d, 8)));
      await countUse(b, new Date(Date.UTC(2026, 9, d, 15))); // gleicher Tag zählt nicht doppelt
    }
    expect(tourSuggestions(index).map((s) => s.name)).not.toContain('Blumenstraße');
    await countUse(b, new Date(Date.UTC(2026, 9, SUGGEST_DAYS, 8)));
    expect(tourSuggestions(index).map((s) => s.name)).toContain('Blumenstraße');
    await addToTour(b, 'A');
    expect(tourSuggestions(index).map((s) => s.name)).not.toContain('Blumenstraße');
  });
});

describe('Lückenanzeige', () => {
  it('nennt Bereich und fehlende Nummern', () => {
    const g = streetGaps(street('Elbuferstraße'));
    expect(g.min).toBe(1);
    expect(g.max).toBe(195);
    expect(g.missing).toEqual([17, 23, 24, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110]);
    expect(g.text).toBe('Nummern 1 bis 195, es fehlen 17, 23–24, 100–110 (14)');
  });
  it('einseitige Straße: nur Lücken der vorhandenen Seite', () => {
    const s = street('Interpolweg'); // 1, 3, … 15 (ungerade)
    const g = streetGaps(s);
    expect(g.text).toContain('nur ungerade');
    expect(g.missing).toEqual([]);
  });
  it('zwei Lücken im Wortlaut', () => {
    const fake = { ...street('Blumenstraße'), numbers: [1, 2, 3, 5, 6, 8].map((n) => ({ ...street('Blumenstraße').numbers[0], num: n, to: null, label: String(n), norm: String(n) })) };
    expect(streetGaps(fake as any).text).toBe('Nummern 1 bis 8, es fehlen 4 und 7');
  });
});
