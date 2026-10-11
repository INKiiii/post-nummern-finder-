// End-to-End: synthetische OSM-Datei -> PBF -> Regionspakete -> Suche/Lage wie in der App.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePbf } from '../scripts/lib/pbf-writer.mjs';
import { makeSyntheticTown } from '../scripts/lib/synthetic.mjs';
import { loadOsmPbf } from '../scripts/lib/sources/osm-pbf.mjs';
import { mergeAddresses, buildStreets, assignRegions, assignStreetIds, makePackage } from '../scripts/lib/regions.mjs';
import { buildIndex, searchStreets, findHouse } from '../src/shared/lookup.js';
import { distanceM } from '../src/shared/geo.js';

let pkgs;
let town;
function build(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hnf-test-'));
  const file = path.join(dir, 'town.osm.pbf');
  fs.writeFileSync(file, writePbf(town, { blockSize: 50 }));
  const src = loadOsmPbf(file);
  const { addresses } = mergeAddresses([src]);
  const streets = buildStreets(src.streetSegments, addresses);
  assignStreetIds(streets);
  const { regions } = assignRegions(streets, src.areas, { group: 'plz', ...opts });
  return regions.map((r) => makePackage(r, [src.meta], 'test'));
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
});
