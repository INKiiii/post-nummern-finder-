import { describe, it, expect } from 'vitest';
import { parseGermanNumber, parseSpokenAddress } from '../src/speechparse';
import { nameWarning } from '../src/namecheck';
import { formatDistance } from '../src/guidance';
import { summarize } from '../src/houseinfo';
import { mergeRecords, backupDue } from '../src/exportimport';
import { edgePoint, labelOrder, AHEAD_LEVELS, AHEAD_LEVELS_NAVI, DEFAULT_LEVEL, NUMBER_FONT, NUMBER_FONT_SMALL, groupSameHouse, joinHouseLabels } from '../src/maplabels';

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
  it('nur eine Nummer gesagt: Straße bleibt leer', () => {
    expect(parseSpokenAddress('zweiundvierzig')).toEqual({ street: '', number: '42' });
    expect(parseSpokenAddress('Nummer zwölf a')).toEqual({ street: '', number: '12a' });
    expect(parseSpokenAddress('195')).toEqual({ street: '', number: '195' });
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

describe('Entfernung', () => {
  it('formatiert Meter und Kilometer', () => {
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
  it('Vorrang beim Beschriften: Ziel, dann voraus (nächste zuerst), dann dahinter', () => {
    const car: [number, number] = [200, 400];
    const cands = [
      { item: 'hinten-nah', x: 210, y: 430 },
      { item: 'voraus-fern', x: 200, y: 100 },
      { item: 'voraus-nah', x: 220, y: 350 },
      { item: 'ziel', x: 50, y: 50, target: true },
      { item: 'hinten-fern', x: 200, y: 600 },
    ];
    expect(labelOrder(cands, car, [200, 300])).toEqual(['ziel', 'voraus-nah', 'voraus-fern', 'hinten-nah', 'hinten-fern']);
  });
  it('Vorrang: eigene Straße vor Eckhäusern anderer Straßen (voraus und dahinter jeweils)', () => {
    const car: [number, number] = [200, 400];
    const cands = [
      { item: 'eck-nah', x: 205, y: 380 },
      { item: 'eigen-fern', x: 200, y: 150, primary: true },
      { item: 'eigen-nah', x: 210, y: 350, primary: true },
      { item: 'eigen-hinten', x: 200, y: 450, primary: true },
      { item: 'eck-hinten', x: 200, y: 420 },
    ];
    expect(labelOrder(cands, car, [200, 300])).toEqual(['eigen-nah', 'eigen-fern', 'eck-nah', 'eigen-hinten', 'eck-hinten']);
  });
  it('Mehrere Nummern an einem Haus: eine Beschriftung', () => {
    expect(joinHouseLabels(['5a', '5'])).toBe('5, 5a');
    expect(joinHouseLabels(['5b', '5', '5a', '5c'])).toBe('5–5c');
    expect(joinHouseLabels(['12', '12'])).toBe('12');
    expect(joinHouseLabels(['10', '9'])).toBe('9, 10');
    const g = groupSameHouse([
      { item: '5', street: 'A', x: 0, y: 0 },
      { item: '5a', street: 'A', x: 2, y: 1 },
      { item: '7', street: 'A', x: 14, y: 0 },
      { item: '1', street: 'B', x: 1, y: 0 }, // andere Straße, gleicher Punkt: eigene Beschriftung
    ]);
    expect(g).toEqual([['5', '5a'], ['7'], ['1']]);
  });
  it('Standardausschnitt: flach 110 m, Navi 220 m voraus; Schrift mindestens 18 px (bei Platzmangel nicht unter 16 px)', () => {
    expect(NUMBER_FONT_SMALL).toBeGreaterThanOrEqual(16);
    expect(AHEAD_LEVELS[DEFAULT_LEVEL]).toBe(110);
    expect(AHEAD_LEVELS_NAVI[DEFAULT_LEVEL]).toBe(220);
    expect(AHEAD_LEVELS_NAVI.length).toBe(AHEAD_LEVELS.length);
    expect(NUMBER_FONT).toBeGreaterThanOrEqual(18);
  });
  it('setzt den Randpfeil auf den Kartenrand', () => {
    expect(edgePoint([200, 300], 0, 400, 400, 30)).toEqual([200, 30]);
    const [x, y] = edgePoint([200, 300], 90, 400, 400, 30);
    expect(x).toBeCloseTo(370);
    expect(y).toBeCloseTo(300);
  });
});

describe('Datensicherung', () => {
  const day = 24 * 3600 * 1000;
  it('ist fällig, wenn nie oder vor mehr als 14 Tagen gesichert', () => {
    const now = Date.UTC(2026, 9, 11);
    expect(backupDue(null, now)).toBe(true);
    expect(backupDue(now - 15 * day, now)).toBe(true);
    expect(backupDue(now - 13 * day, now)).toBe(false);
  });
});

describe('Annäherungshinweis', () => {
  it('löst bei 50 m einmal und bei 15 m einmal aus, nur beim Annähern', async () => {
    const { ApproachAlert } = await import('../src/approach');
    const a = new ApproachAlert();
    expect(a.update(120, false)).toBeNull();
    expect(a.update(80, false)).toBeNull();
    expect(a.update(48, false)).toBe('far');
    expect(a.update(40, false)).toBeNull();
    expect(a.update(45, false)).toBeNull(); // entfernt sich
    expect(a.update(14, false)).toBe('near');
    expect(a.update(5, false)).toBeNull();
    const b = new ApproachAlert();
    b.update(60, true);
    expect(b.update(40, true)).toBeNull(); // Ziel hinter einem
  });
});
