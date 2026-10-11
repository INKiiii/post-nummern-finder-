// End-to-End: synthetische OSM-Datei -> PBF -> Regionspakete -> Suche/Lage wie in der App.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePbf } from '../scripts/lib/pbf-writer.mjs';
import { makeSyntheticTown } from '../scripts/lib/synthetic.mjs';
import { loadOsmPbf } from '../scripts/lib/sources/osm-pbf.mjs';
import { mergeAddresses, attachBuildings, attachDriveways, buildStreets, assignRegions, assignStreetIds, makePackage } from '../scripts/lib/regions.mjs';
import { buildIndex, searchStreets, findHouse, decodeLine, drivewayFor, distanceToStreet, nearestStreets } from '../src/shared/lookup.js';
import { distanceM } from '../src/shared/geo.js';

let pkgs;
let town;
function build(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hnf-test-'));
  const file = path.join(dir, 'town.osm.pbf');
  fs.writeFileSync(file, writePbf(town, { blockSize: 50 }));
  const src = loadOsmPbf(file);
  const { addresses } = mergeAddresses([src], ['osm', 'osm-interp']);
  const streets = buildStreets(src.streetSegments, addresses);
  attachDriveways(streets, src.drivewaySegments);
  attachBuildings(streets, src.buildings);
  assignStreetIds(streets);
  const { regions } = assignRegions(streets, src.areas, { group: 'plz', ...opts });
  return regions.map((r) => makePackage(r, [src.meta, ...src.extraSources], 'test'));
}

beforeAll(() => {
  const origErr = process.stderr.write;
  process.stderr.write = () => true;
  town = makeSyntheticTown();
  pkgs = build({ state: 'Niedersachsen' });
  process.stderr.write = origErr;
});

describe('Regionspakete', () => {
  it('teilt nach PLZ und filtert nach Bundesland', () => {
    expect(pkgs.map((p) => p.id)).toEqual(['00001', '00002']);
    const all = build();
    expect(all.map((p) => p.id)).toContain('00003');
  });

  it('führt Wegstücke zusammen und nimmt Straßen über PLZ-Grenzen in beide Pakete', () => {
    const e1 = pkgs[0].streets.find((s) => s.n === 'Elbuferstraße');
    const e2 = pkgs[1].streets.find((s) => s.n === 'Elbuferstraße');
    expect(e1.id).toBe(e2.id);
    expect(e1.l.length).toBe(1); // drei Wege -> eine Linie
  });

  it('meldet Vollständigkeit und Lücken', () => {
    const e = pkgs[0].streets.find((s) => s.n === 'Elbuferstraße');
    expect(e.q.min).toBe(1);
    expect(e.q.max).toBe(195);
    expect(e.q.missing).toEqual([17, 23, 24, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110]);
    const schilf = pkgs[1].streets.find((s) => s.n === 'Schilfring');
    expect(schilf.q.gap).toBe(true);
    expect(schilf.h.length).toBe(0);
  });

  it('übernimmt Multipolygon-Gebäude, Mehrfachnummern und Adressen ohne Straßengeometrie', () => {
    const b = pkgs[0].streets.find((s) => s.n === 'Blumenstraße');
    const labels = b.h.map((h) => h[0]);
    expect(labels).toContain('1');
    expect(labels).toContain('18');
    expect(labels).toContain('20');
    expect(labels).toContain('12a');
    const deich = pkgs[0].streets.find((s) => s.n === 'Am Deich');
    expect(deich.l.length).toBe(0);
    expect(deich.h.length).toBe(2);
  });

  it('ordnet Zufahrtswege dem Haus zu, beginnend an der Straße', () => {
    const e = pkgs[0].streets.find((s) => s.n === 'Elbuferstraße');
    expect(e.d.length).toBe(1);
    const [labels, enc] = e.d[0];
    expect(labels).toEqual(['61']);
    const line = decodeLine(enc);
    const [x0, y0] = town.proj.toXY(...line[0]);
    expect(Math.abs(y0)).toBeLessThan(0.5); // Abzweigung liegt auf der Straße
    expect(x0).toBeCloseTo(-372, 0);
    const [, y1] = town.proj.toXY(...line[line.length - 1]);
    expect(y1).toBeGreaterThan(55);
  });

  it('trennt gleichnamige Straßen in verschiedenen Orten', () => {
    const all = build();
    const dorf = all.flatMap((p) => p.streets.filter((s) => s.n === 'Dorfstraße'));
    expect(new Set(dorf.map((s) => s.id)).size).toBe(2);
  });

  it('führt Gebäude-Mittelpunkte korrekt (Haus 1 liegt in seinem Grundriss)', () => {
    const b = pkgs[0].streets.find((s) => s.n === 'Blumenstraße');
    const h1 = b.h.find((h) => h[0] === '1');
    const [lat, lon] = town.proj.toLatLon(-315, 10);
    expect(distanceM(h1[1] / 1e6, h1[2] / 1e6, lat, lon)).toBeLessThan(1);
  });
});

describe('Suche und Lage (App-Logik)', () => {
  it('findet Straßen per Autovervollständigung und Tippfehler', () => {
    const idx = buildIndex(pkgs);
    expect(searchStreets(idx, 'elbu')[0].name).toBe('Elbuferstraße');
    expect(searchStreets(idx, 'Elbuferstr.')[0].name).toBe('Elbuferstraße');
    expect(searchStreets(idx, 'Elbufrstrasse')[0].name).toBe('Elbuferstraße');
    expect(searchStreets(idx, 'schilf')[0].name).toBe('Schilfring');
  });

  it('liefert exakte und geschätzte Lagen', () => {
    const idx = buildIndex(pkgs);
    const e = searchStreets(idx, 'Elbuferstraße')[0];
    expect(findHouse(e, '42').status).toBe('exact');
    const r17 = findHouse(e, '17');
    expect(r17.status).toBe('interpolated');
    expect(r17.estimated).toBe(true);
    expect(r17.neighbors.map((n) => n.label)).toEqual(['15', '19']);
    // 17 liegt zwischen 15 und 19 auf der Nordseite
    const [x, y] = town.proj.toXY(r17.lat, r17.lon);
    expect(x).toBeCloseTo(-980 + 8 * 20, -1);
    expect(y).toBeGreaterThan(5);
    const b = searchStreets(idx, 'Blumenstraße')[0];
    expect(findHouse(b, '12b').status).toBe('base');
    expect(findHouse(b, '15').status).toBe('range');
    const s = searchStreets(idx, 'Schilfring')[0];
    expect(findHouse(s, '5').status).toBe('street');
  });

  it('behandelt eigene Punkte wie Originaldaten', () => {
    const idx0 = buildIndex(pkgs);
    const s = searchStreets(idx0, 'Schilfring')[0];
    const idx = buildIndex(pkgs, {
      points: [{ id: 'p1', streetId: s.id, streetName: 'Schilfring', number: '7', plz: '00002', lat: 53.302, lon: 10.204, updated: 1, created: 1 }],
    });
    const s2 = idx.streets.get(s.id);
    const r = findHouse(s2, '7');
    expect(r.status).toBe('exact');
    expect(r.match.user).toBe(true);
    // weitere Nummern werden aus dem eigenen Punkt geschätzt
    expect(findHouse(s2, '9').status).toBe('single');
  });

  it('legt eigene Straßen an und macht sie durchsuchbar', () => {
    const idx = buildIndex(pkgs, {
      streets: [{ id: 'x', name: 'Kranichweg', plz: '00002', line: [], start: [53.3, 10.2], updated: 1, created: 1 }],
    });
    const k = searchStreets(idx, 'kranich')[0];
    expect(k.user).toBe(true);
    expect(findHouse(k, '1').status).toBe('street');
  });

  it('liefert Zufahrt und Abstand zur Straße für zurückgesetzte Häuser', () => {
    const idx = buildIndex(pkgs);
    const e = searchStreets(idx, 'Elbuferstraße')[0];
    const r = findHouse(e, '61');
    const d = drivewayFor(e, '61', r);
    expect(d.user).toBe(false);
    expect(Math.abs(town.proj.toXY(...d.junction)[1])).toBeLessThan(0.5);
    expect(distanceToStreet(e, r.lat, r.lon)).toBeGreaterThan(60);
    expect(distanceToStreet(e, ...[findHouse(e, '59')].map((x) => [x.lat, x.lon])[0])).toBeLessThan(20);
    expect(drivewayFor(e, '59', findHouse(e, '59'))).toBeNull();
  });

  it('eigene Einfahrt hat Vorrang und führt zum Haus', () => {
    const idx0 = buildIndex(pkgs);
    const e0 = searchStreets(idx0, 'Elbuferstraße')[0];
    const [jl, jo] = town.proj.toLatLon(-580, 0);
    const idx = buildIndex(pkgs, {
      points: [{ id: 'd1', kind: 'driveway', streetId: e0.id, streetName: 'Elbuferstraße', number: '42', lat: jl, lon: jo, updated: 1, created: 1 }],
    });
    const e = idx.streets.get(e0.id);
    const r = findHouse(e, '42');
    expect(r.status).toBe('exact'); // Einfahrt ist keine Hausnummer
    const d = drivewayFor(e, '42', r);
    expect(d.user).toBe(true);
    expect(d.line[0]).toEqual([jl, jo]);
    expect(d.line[1]).toEqual([r.lat, r.lon]);
  });

  it('schlägt die nächstgelegene Straße vor', () => {
    const idx = buildIndex(pkgs);
    const near = (x, y) => nearestStreets(idx, ...town.proj.toLatLon(x, y), 50, 2).map((r) => r.street.name);
    expect(near(-600, -4)).toEqual(['Elbuferstraße']);
    expect(near(-300, 200)[0]).toBe('Blumenstraße');
    // An der Kreuzung beide, nächste zuerst
    expect(near(-295, 12)).toEqual(['Blumenstraße', 'Elbuferstraße']);
    // Straße ohne Geometrie: über die Hausnummern
    expect(near(-590, 125)[0]).toBe('Am Deich');
    expect(near(-600, 600)).toEqual([]);
  });

  it('erzeugt Nummern aus addr:interpolation-Linien', () => {
    const iw = pkgs[1].streets.find((s) => s.n === 'Interpolweg');
    expect(iw.h.map((h) => h[0])).toEqual(['1', '3', '5', '7', '9', '11', '13', '15']);
    const idx = buildIndex(pkgs);
    const st = searchStreets(idx, 'Interpolweg')[0];
    const r7 = findHouse(st, '7');
    expect(r7.status).toBe('exact');
    expect(r7.estimated).toBe(true); // Lage nur aus der Linie
    expect(r7.match.source).toBe('osm-interp');
    const [x] = town.proj.toXY(r7.lat, r7.lon);
    expect(x).toBeCloseTo(610 + (6 / 14) * 280, 0);
    expect(findHouse(st, '1').estimated).toBe(false);
  });

  it('führt abgetrennte Stücke ohne Nummern mit der gleichnamigen Straße zusammen', () => {
    const reet = pkgs.flatMap((p) => p.streets.filter((s) => s.n === 'Reetweg'));
    expect(new Set(reet.map((s) => s.id)).size).toBe(1);
    expect(reet[0].l.length).toBe(2); // beide Stücke als Linien enthalten
    expect(reet[0].h.length).toBe(2);
  });

  it('setzt geschätzte Lagen auf Gebäude ohne Hausnummer', () => {
    const idx = buildIndex(pkgs);
    const e = searchStreets(idx, 'Elbuferstraße')[0];
    expect(e.buildings.length).toBe(11);
    const r = findHouse(e, '104');
    expect(r.status).toBe('interpolated');
    expect(r.snapped).toBe(true);
    const [x, y] = town.proj.toXY(r.lat, r.lon);
    expect(x).toBeCloseTo(-980 + 51 * 20, 0);
    expect(y).toBeLessThan(-10); // gerade Seite (Süden)
  });

  it('unterscheidet Wege ohne Häuser von Straßen mit Häusern ohne Nummern', () => {
    const feld = pkgs[1].streets.find((s) => s.n === 'Kleiwurtweg');
    expect(feld.q.gap).toBe(true);
    expect(feld.q.bu).toBe(0);
    const e = pkgs[0].streets.find((s) => s.n === 'Elbuferstraße');
    expect(e.q.bu).toBe(11);
  });
});

