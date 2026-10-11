import { describe, it, expect } from 'vitest';
import { parseGermanNumber, parseSpokenAddress } from '../src/speechparse';
import { nameWarning } from '../src/namecheck';
import { computeGuidance, formatDistance } from '../src/guidance';
import { summarize } from '../src/houseinfo';
import { mergeRecords } from '../src/exportimport';
import { makeProjection } from '../src/core';
import type { HouseNumber, Street } from '../src/types';
import { edgePoint, followAhead, forcedLabels } from '../src/maplabels';

describe('Zahlwörter', () => {
  it.each([
    ['zwölf', 12],
    ['zweiundvierzig', 42],
    ['hundertfünfundneunzig', 195],
    ['einhundertfünfundneunzig', 195],
    ['dreißig', 30],
    ['dreissig', 30],
    ['siebenhundertelf', 711],
    ['zweitausendeins', 2001],
    ['eins', 1],
    ['hundert', 100],
  ])('%s = %i', (w, n) => expect(parseGermanNumber(w)).toBe(n));
  it('lehnt Nicht-Zahlen ab', () => {
    expect(parseGermanNumber('straße')).toBeNull();
    expect(parseGermanNumber('elbuferstraße')).toBeNull();
  });
});

describe('Gesprochene Adressen', () => {
  it.each([
    ['Elbuferstraße hundertfünfundneunzig', 'Elbuferstraße', '195'],
    ['Elbuferstraße 195', 'Elbuferstraße', '195'],
    ['Blumenstraße zwölf a', 'Blumenstraße', '12a'],
    ['Blumenstraße 12 a', 'Blumenstraße', '12a'],
    ['Blumenstraße 12a', 'Blumenstraße', '12a'],
    ['Elbuferstraße zweiundvierzig', 'Elbuferstraße', '42'],
    ['Am Deich Nummer drei', 'Am Deich', '3'],
    ['Elbuferstraße hundert fünfundneunzig', 'Elbuferstraße', '195'],
    ['An der Elbe 7 b', 'An der Elbe', '7b'],
  ])('%s', (text, street, number) => {
    expect(parseSpokenAddress(text)).toEqual({ street, number });
  });
  it('liefert ohne Nummer nur die Straße', () => {
    expect(parseSpokenAddress('Schilfring')).toEqual({ street: 'Schilfring', number: null });
  });
});

describe('Namenswarnung', () => {
  it('warnt bei Namen', () => {
    expect(nameWarning('Familie Meyer')).not.toBeNull();
    expect(nameWarning('Herr Schulz hinten')).not.toBeNull();
    expect(nameWarning('bei Müller')).not.toBeNull();
    expect(nameWarning('Peter Hansen')).not.toBeNull();
    expect(nameWarning('Jürgen links')).not.toBeNull();
  });
  it('erlaubt Zustellhinweise', () => {
    expect(nameWarning('Briefkasten am Tor')).toBeNull();
    expect(nameWarning('Hund, Auffahrt rein')).toBeNull();
    expect(nameWarning('Grüner Briefkasten links')).toBeNull();
    expect(nameWarning('Paketkasten im Keller')).toBeNull();
    expect(nameWarning('')).toBeNull();
  });
});

describe('Straßenseite und Entfernung', () => {
  const origin = [53.39, 10.42] as const;
  const proj = makeProjection(origin[0], origin[1]);
  const ll = (x: number, y: number) => proj.toLatLon(x, y);
  // Straße West -> Ost
  const street = { lines: [[ll(-500, 0), ll(500, 0)]] } as unknown as Street;
  const north = ll(100, 15);
  const south = ll(100, -15);
  const user = (x: number, y: number, heading: number | null) => {
    const [lat, lon] = ll(x, y);
    return { lat, lon, heading };
  };

  it('Fahrt nach Osten: Nordseite links, Südseite rechts', () => {
    expect(computeGuidance(user(0, 0, 90), { lat: north[0], lon: north[1] }, street).side).toBe('links');
    expect(computeGuidance(user(0, 0, 90), { lat: south[0], lon: south[1] }, street).side).toBe('rechts');
  });
  it('Fahrt nach Westen: umgekehrt, und Ziel hinter einem', () => {
    const g = computeGuidance(user(300, 0, 270), { lat: north[0], lon: north[1] }, street);
    expect(g.side).toBe('rechts');
    expect(g.behind).toBe(false);
    const g2 = computeGuidance(user(0, 0, 270), { lat: north[0], lon: north[1] }, street);
    expect(g2.behind).toBe(true);
  });
  it('Straßenseite stimmt auch, wenn das Ziel weit voraus liegt', () => {
    const far = ll(450, 12);
    // Peilung wäre fast geradeaus – trotzdem links
    expect(computeGuidance(user(-450, 0, 90), { lat: far[0], lon: far[1] }, street).side).toBe('links');
  });
  it('ohne Straße: Peilung relativ zur Fahrtrichtung', () => {
    const t = ll(100, 100);
    expect(computeGuidance(user(0, 0, 0), { lat: t[0], lon: t[1] }, null).side).toBe('rechts');
    expect(computeGuidance(user(0, 0, 90), { lat: t[0], lon: t[1] }, null).side).toBe('links');
  });
  it('ohne Fahrtrichtung keine Seite, aber Entfernung', () => {
    const g = computeGuidance(user(0, 0, null), { lat: north[0], lon: north[1] }, street);
    expect(g.side).toBeNull();
    expect(g.distance).toBeCloseTo(Math.hypot(100, 15), 0);
  });
  it('formatiert Entfernungen', () => {
    expect(formatDistance(123)).toBe('125 m');
    expect(formatDistance(1530)).toBe('1,5 km');
  });
});

describe('Haus-Infos', () => {
  it('fasst Eingänge zusammen', () => {
    const lines = summarize({
      key: 'k',
      street: 'Elbuferstraße',
      number: '42',
      plz: '21395',
      place: 'Tespe',
      access: null,
      entrances: [
        { pos: 'rechts', boxes: 3 },
        { pos: 'links hinten', boxes: 2 },
      ],
      note: '',
      updated: 1,
    });
    expect(lines.join(' ')).toBe('42: 2 Eingänge. Rechts: 3 Briefkästen. Links hinten: 2 Briefkästen.');
  });
  it('Import: neuerer Stand gewinnt', () => {
    const r = mergeRecords(
      [{ key: 'a', updated: 5 }, { key: 'b', updated: 5 }],
      [{ key: 'a', updated: 9 }, { key: 'b', updated: 1 }, { key: 'c', updated: 1 }],
      (x) => x.key,
    );
    expect(r.added).toBe(1);
    expect(r.updated).toBe(1);
    expect(r.result.find((x) => x.key === 'a')!.updated).toBe(9);
    expect(r.result.find((x) => x.key === 'b')!.updated).toBe(5);
  });
});

describe('Kartenbeschriftung und Zoom', () => {
  const num = (label: string): HouseNumber => {
    const m = /^(\d+)([a-z]?)$/.exec(label)!;
    return { label, norm: label, num: +m[1], suffix: m[2], to: null, lat: 0, lon: 0, source: 'osm', plz: '' };
  };
  const all = Array.from({ length: 80 }, (_, i) => num(String(i + 1)));

  it('beschriftet Ziel und je 3 Nachbarn derselben Straßenseite', () => {
    const f = [...forcedLabels(all, '42')].map((n) => n.label).sort((a, b) => +a - +b);
    expect(f).toEqual(['36', '38', '40', '42', '44', '46', '48']);
  });
  it('fehlende Zielnummer: trotzdem die Nachbarn', () => {
    const list = all.filter((n) => n.label !== '17');
    const f = [...forcedLabels(list, '17')].map((n) => n.label).sort((a, b) => +a - +b);
    expect(f).toEqual(['11', '13', '15', '19', '21', '23']);
  });
  it('Zusatz 12a zählt mit 12 als eine Position', () => {
    const list = [...all, num('12a')];
    const f = [...forcedLabels(list, '14')].map((n) => n.label);
    expect(f).toContain('12');
    expect(f).toContain('12a');
    expect(f).toContain('8');
    expect(f).not.toContain('6');
  });
  it('zoomt bei Annäherung heran, höchstens 120 m voraus', () => {
    expect(followAhead(5000)).toBe(120);
    expect(followAhead(Infinity)).toBe(120);
    expect(followAhead(60)).toBeCloseTo(85);
    expect(followAhead(5)).toBe(35);
  });
  it('setzt den Randpfeil auf den Kartenrand', () => {
    expect(edgePoint([200, 300], 0, 400, 400, 30)).toEqual([200, 30]);
    const [x, y] = edgePoint([200, 300], 90, 400, 400, 30);
    expect(x).toBeCloseTo(370);
    expect(y).toBeCloseTo(300);
  });
});
