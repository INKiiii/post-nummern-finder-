import { describe, it, expect } from 'vitest';
import { parseHouseNumber, completeness, formatRanges, splitHouseNumbers } from '../src/shared/housenumber.js';
import { normStreet } from '../src/shared/normalize.js';
import { utmToLatLon, splitCsvLine } from '../scripts/lib/sources/csv-addresses.mjs';
import { mergeAddresses } from '../scripts/lib/regions.mjs';

describe('Hausnummern', () => {
  it('parst Zusätze und Bereiche', () => {
    expect(parseHouseNumber('12a')).toMatchObject({ num: 12, suffix: 'a', norm: '12a' });
    expect(parseHouseNumber('12 A')).toMatchObject({ num: 12, suffix: 'a', norm: '12a' });
    expect(parseHouseNumber('14-16')).toMatchObject({ num: 14, to: 16 });
    expect(parseHouseNumber('7/1')).toMatchObject({ num: 7, suffix: '/1' });
    expect(parseHouseNumber('Hof')).toMatchObject({ num: null });
    expect(splitHouseNumbers('18;20')).toEqual(['18', '20']);
  });
  it('berechnet Vollständigkeit', () => {
    const q = completeness(['1', '2', '3', '5', '8', '8a']);
    expect(q).toMatchObject({ min: 1, max: 8, missing: [4, 6, 7], gap: false });
    expect(completeness([]).gap).toBe(true);
    expect(formatRanges([17, 23, 24, 25])).toBe('17, 23–25');
  });
});

describe('Straßennamen', () => {
  it('normalisiert Schreibweisen', () => {
    const n = normStreet('Elbuferstraße');
    expect(normStreet('Elbuferstr.')).toBe(n);
    expect(normStreet('Elbufer-Straße')).toBe(n);
    expect(normStreet('elbuferstrasse')).toBe(n);
    expect(normStreet('Elbufer Str')).toBe(n);
    expect(normStreet('Schilfring')).toBe('schilfring');
  });
});

describe('Amtliche Daten (CSV)', () => {
  it('rechnet UTM32 in Grad um', () => {
    // Referenzpunkt: 9° Ost (Mittelmeridian Zone 32), Äquator-Nord-Wert für ~53.39° N
    const [lat, lon] = utmToLatLon(500000, 5916000, 32);
    expect(lon).toBeCloseTo(9, 6);
    expect(lat).toBeGreaterThan(53.3);
    expect(lat).toBeLessThan(53.5);
    // Tespe liegt ca. bei E 594000 / N 5917000 (Zone 32)
    const [lat2, lon2] = utmToLatLon(594000, 5917000, 32);
    expect(lat2).toBeCloseTo(53.39, 1);
    expect(lon2).toBeCloseTo(10.41, 1);
  });
  it('zerlegt CSV mit Anführungszeichen', () => {
    expect(splitCsvLine('a;"b;c";"d""e"', ';')).toEqual(['a', 'b;c', 'd"e']);
  });
  it('führt amtliche Daten und OSM zusammen (amtlich bevorzugt)', () => {
    const osm = { meta: { id: 'osm' }, addresses: [{ street: 'Elbuferstr.', housenumber: '5', lat: 53.4, lon: 10.4, source: 'osm', postcode: '21395', city: 'Tespe' }] };
    const off = {
      meta: { id: 'amtlich' },
      addresses: [
        { street: 'Elbuferstraße', housenumber: '5', lat: 53.40005, lon: 10.40005, source: 'amtlich', postcode: '', city: '' },
        { street: 'Elbuferstraße', housenumber: '7', lat: 53.4001, lon: 10.4001, source: 'amtlich', postcode: '21395', city: 'Tespe' },
      ],
    };
    const { addresses, merged } = mergeAddresses([osm, off], ['amtlich', 'osm']);
    expect(merged).toBe(1);
    expect(addresses.length).toBe(2);
    const a5 = addresses.find((a) => a.housenumber === '5');
    expect(a5.source).toBe('amtlich');
    expect(a5.lat).toBe(53.40005);
    expect(a5.postcode).toBe('21395');
  });
});
