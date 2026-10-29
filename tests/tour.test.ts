// Meine Tour: Reihenfolge A/B, nächste Straße, Bevorzugung im Straßenbezug, Nutzungszähler,
// Lückenanzeige.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { townPackages } from './town.mjs';
import { buildIndex, makeProjection, nearestStreets } from '../src/core';
import {
  _setState,
  activePart,
  activePartIds,
  addToTour,
  firstChoiceDue,
  hasBothParts,
  noteStreet,
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
import type { Index, Street } from '../src/types';

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

  it('Heute zuerst: Wahl einmal am Tag, gilt sofort für Reihenfolge und aktiven Teil', async () => {
    await addToTour(street('Elbuferstraße'), 'A');
    expect(hasBothParts()).toBe(false);
    expect(firstChoiceDue()).toBe(false); // nur ein Teil: nichts zu wählen
    await addToTour(street('Blumenstraße'), 'B');
    const day = new Date(2026, 9, 29, 7, 30);
    expect(firstChoiceDue(day)).toBe(true);
    await setFirst('B', day);
    expect(firstChoiceDue(day)).toBe(false);
    expect(firstChoiceDue(new Date(2026, 9, 30, 7, 30))).toBe(true); // am nächsten Tag wieder fragen
    expect(orderedTour()[0].name).toBe('Blumenstraße');
    expect(activePart()).toBe('B');
    expect([...activePartIds(index)]).toEqual([street('Blumenstraße').id]);
    // Fährt man in Teil A, folgt der Vorrang dorthin
    expect(noteStreet(street('Elbuferstraße'))).toBe(true);
    expect(activePart()).toBe('A');
    expect(noteStreet(street('Elbuferstraße'))).toBe(false);
    expect(noteStreet(null)).toBe(false);
    // Neue Wahl setzt wieder auf den gewählten Teil
    await setFirst('B', day);
    expect(activePart()).toBe('B');
  });

  it('Straßenbezug: an einer unklaren Stelle gewinnt die Straße des aktiven Teils', async () => {
    const proj = makeProjection(SYNTH_ORIGIN[0], SYNTH_ORIGIN[1]);
    // Eine Stelle suchen, an der zwei Straßen fast gleich weit weg sind (GPS kann beides meinen)
    let pt: { lat: number; lon: number; a: Street; b: Street } | null = null;
    for (let dx = -40; dx <= 40 && !pt; dx++)
      for (let dy = -40; dy <= 40 && !pt; dy++) {
        const [la, lo] = proj.toLatLon(205 + dx, 190 + dy);
        const n = nearestStreets(index, la, lo, 60, 2);
        if (n.length === 2 && n[0].dist < 20 && Math.abs(n[0].dist - n[1].dist) < 1.5) pt = { lat: la, lon: lo, a: n[0].street, b: n[1].street };
      }
    expect(pt).not.toBeNull();
    const { lat, lon, a, b } = pt!;
    await addToTour(a, 'A');
    await addToTour(b, 'B');
    const run = async (first: 'A' | 'B') => {
      await setFirst(first);
      const m = new StreetMatcher(() => index);
      m.preferred = tourStreetIds(index);
      m.activePart = activePartIds(index);
      return m.update({ lat, lon, accuracy: 8, course: null, speed: 0, time: 1 }).street?.name;
    };
    expect(await run('A')).toBe(a.name);
    expect(await run('B')).toBe(b.name);
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

describe('Zustellablauf: Schnelltasten und Sprache', () => {
  it('+2, −2 und gegenüber (geometrisch, andere Straßenseite)', async () => {
    const { quickSteps, oppositeNumber } = await import('../src/preview');
    const e = street('Elbuferstraße');
    expect(quickSteps(e, '42')).toEqual({ minus2: '40', plus2: '44', opposite: '41' });
    expect(oppositeNumber(e, '41')).toBe('42');
    expect(oppositeNumber(street('Blumenstraße'), '4')).toBe('3');
    expect(quickSteps(e, '1').minus2).toBeNull();
    // fehlende Nummer 17: gegenüber trotzdem aus der geschätzten Lage
    expect(oppositeNumber(e, '17')).toBe('18');
  });

  it('Spracheingabe: mit Tour nur Tour-Straßen, sonst alle', async () => {
    const { state } = await import('../src/data');
    const { matchSpokenStreet } = await import('../src/voice');
    state.index = index;
    expect(matchSpokenStreet('Blumenstraße')?.name).toBe('Blumenstraße');
    await addToTour(street('Elbuferstraße'), 'A');
    expect(matchSpokenStreet('Blumenstraße')).toBeNull();
    expect(matchSpokenStreet('Elbufer Straße')?.name).toBe('Elbuferstraße');
  });
});

describe('Lücken im Moment des Fundes schließen', () => {
  it('„Hier ist Nr.“ links/rechts: Punkt auf der richtigen Straßenseite im gewählten Abstand', () => {
    const proj = makeProjection(SYNTH_ORIGIN[0], SYNTH_ORIGIN[1]);
    const m = new StreetMatcher(() => index);
    let last = null as any;
    for (let x = -640; x <= -600; x += 4) {
      const [lat, lon] = proj.toLatLon(x, -2);
      last = m.update({ lat, lon, accuracy: 5, course: 90, speed: 4, time: x });
    }
    const left = proj.toXY(...m.besideStreet(last, 'left', 15)!);
    const right = proj.toXY(...m.besideStreet(last, 'right', 25)!);
    expect(left[1]).toBeCloseTo(15, 0); // nach Osten: links = Norden
    expect(right[1]).toBeCloseTo(-25, 0);
    expect(Math.abs(left[0] - -600)).toBeLessThan(3);
  });

  it('eigene Punkte haben Vorrang vor den Grunddaten und lassen sich rückgängig machen', async () => {
    const { state, rebuildIndex } = await import('../src/data');
    const { setUserPoint, undoUserPoint } = await import('../src/ui/points');
    const { findHouse } = await import('../src/core');
    state.packages = townPackages().pkgs.map((pkg: any) => ({ id: pkg.id, entry: {} as any, pkg, size: 0, downloadedAt: 0 }));
    state.points = [];
    rebuildIndex();
    const e = () => [...state.index.streets.values()].find((s) => s.name === 'Elbuferstraße')!;
    // fehlende Nummer 17 setzen
    expect(findHouse(e(), '17').estimated).toBe(true);
    const r1 = await setUserPoint('number', e(), '17', 53.3002, 10.1902);
    const f17 = findHouse(e(), '17');
    expect(f17.status).toBe('exact');
    expect(f17.match?.user).toBe(true);
    expect(f17.lat).toBeCloseTo(53.3002, 6);
    // vorhandene Nummer 42 überschreiben (Korrektur) und wieder zurück
    const orig = findHouse(e(), '42');
    const r2 = await setUserPoint('number', e(), '42', 53.3005, 10.1905);
    expect(findHouse(e(), '42').lat).toBeCloseTo(53.3005, 6);
    await undoUserPoint(r2);
    expect(findHouse(e(), '42').lat).toBeCloseTo(orig.lat, 6);
    // erneutes Setzen derselben Nummer ersetzt den eigenen Punkt; Rückgängig stellt ihn wieder her
    const r3 = await setUserPoint('number', e(), '17', 53.3003, 10.1903);
    expect(state.points.filter((p) => p.number === '17')).toHaveLength(1);
    await undoUserPoint(r3);
    expect(findHouse(e(), '17').lat).toBeCloseTo(53.3002, 6);
    await undoUserPoint(r1);
    expect(findHouse(e(), '17').estimated).toBe(true);
  });
});

describe('Export/Import der eigenen Daten', () => {
  it('Sicherung enthält Haus-Infos und Punkte, keine Fotos; Import verwirft Namen und Fotos', async () => {
    const { exportUserData, importUserData } = await import('../src/exportimport');
    const { saveHouseInfo, getHouseInfo } = await import('../src/houseinfo');
    const { countOldPhotos } = await import('../src/photos');
    const e = street('Elbuferstraße');
    await saveHouseInfo({ key: '00001|elbuferstrasse|42', street: e.name, number: '42', plz: '00001', place: e.place, access: 'Einfahrt links', entrances: [{ pos: 'hinten', boxes: 2 }], note: 'Hund', updated: 0 });
    const data = await exportUserData();
    expect(data.houseinfo.some((x) => x.note === 'Hund')).toBe(true);
    expect('photos' in data).toBe(false);
    const incoming = {
      ...data,
      houseinfo: [
        { ...data.houseinfo[0], note: 'Herr Meier wohnt hinten', updated: Date.now() + 1000 },
        { key: '00001|elbuferstrasse|44', street: e.name, number: '44', plz: '00001', place: e.place, access: null, entrances: [], note: 'Tor', updated: 5 },
      ],
      photos: [{ key: 'x', dataUrl: 'data:image/png;base64,AAAA', updated: 1 }],
    };
    const r = await importUserData(JSON.stringify(incoming));
    expect(r.namesRemoved).toBe(1);
    expect(getHouseInfo('00001|elbuferstrasse|42')?.note).toBe('');
    expect(getHouseInfo('00001|elbuferstrasse|44')?.note).toBe('Tor');
    expect(await countOldPhotos()).toBe(0);
  });
});
