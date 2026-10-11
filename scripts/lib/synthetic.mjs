// Erfundenes Testgebiet ("Musterdorf", PLZ 00001/00002/00003) als OSM-Daten.
// Dient für automatische Tests und als Demo-Gebiet. Keine echten Adressen.

import { makeProjection } from '../../src/shared/geo.js';

export const SYNTH_ORIGIN = [53.3, 10.2];

export function makeSyntheticTown(origin = SYNTH_ORIGIN) {
  const proj = makeProjection(origin[0], origin[1]);
  const nodes = [];
  const ways = [];
  const relations = [];
  let nid = 1000;
  let wid = 5000;
  let rid = 9000;
  const node = (x, y, tags) => {
    const [lat, lon] = proj.toLatLon(x, y);
    const n = { id: nid++, lat, lon, tags };
    nodes.push(n);
    return n.id;
  };
  const way = (refs, tags) => {
    const w = { id: wid++, refs, tags };
    ways.push(w);
    return w.id;
  };
  const line = (pts) => pts.map(([x, y]) => node(x, y));
  const square = (cx, cy, size, tags) => {
    const h = size / 2;
    const r = line([
      [cx - h, cy - h],
      [cx + h, cy - h],
      [cx + h, cy + h],
      [cx - h, cy + h],
    ]);
    return way([...r, r[0]], { building: 'house', ...tags });
  };
  const addr = (street, hn, plz, city) => ({
    'addr:street': street,
    'addr:housenumber': hn,
    ...(plz ? { 'addr:postcode': plz } : {}),
    ...(city ? { 'addr:city': city } : {}),
  });

  // --- Elbuferstraße: West -> Ost, 2 km, drei Wegstücke mit gemeinsamen Knoten ---
  const e = line([
    [-1000, 0],
    [-500, 0],
    [0, 0],
    [400, 40],
    [1000, 40],
  ]);
  way([e[0], e[1]], { highway: 'residential', name: 'Elbuferstraße' });
  way([e[1], e[2], e[3]], { highway: 'residential', name: 'Elbuferstraße' });
  way([e[3], e[4]], { highway: 'tertiary', name: 'Elbuferstraße' });
  const missing = new Set([17, 23, 24, ...Array.from({ length: 11 }, (_, i) => 100 + i)]);
  const yAt = (x) => (x <= 0 ? 0 : x >= 400 ? 40 : x / 10);
  for (let n = 1; n <= 195; n++) {
    if (missing.has(n)) continue;
    // ungerade Nummern nördlich (links in Fahrtrichtung Ost), gerade südlich
    const x = -980 + Math.floor((n - 1) / 2) * 20;
    const y = yAt(x) + (n % 2 === 1 ? 15 : -15);
    const plz = x < 0 ? '00001' : '00002';
    const city = x < 0 ? 'Musterdorf' : 'Beispielhausen';
    if (n % 3 === 0) node(x, y, addr('Elbuferstraße', String(n), plz, city));
    else square(x, y, 10, addr('Elbuferstraße', String(n), plz, n === 5 ? '' : city));
  }

  // --- Blumenstraße: Nord-Süd bei x=-300, Nummern 1..20 mit Sonderfällen ---
  const b = line([
    [-300, 0],
    [-300, 400],
  ]);
  way(b, { highway: 'residential', name: 'Blumenstraße' });
  for (let n = 2; n <= 11; n++) {
    const y = 20 + Math.floor((n - 1) / 2) * 30;
    const x = -300 + (n % 2 ? -14 : 14);
    square(x, y, 9, addr('Blumenstraße', String(n), '00001', 'Musterdorf'));
  }
  node(-286, 20 + 5 * 30 + 10, addr('Blumenstraße', '12a', '00001', 'Musterdorf'));
  node(-286, 20 + 5 * 30, addr('Blumenstraße', '12', '00001', 'Musterdorf'));
  node(-286, 20 + 6 * 30, addr('Blumenstraße', '14-16', '00001', 'Musterdorf'));
  node(-286, 20 + 8 * 30, addr('Blumenstraße', '18;20', '00001', 'Musterdorf'));
  // Hausnummer 1 als Multipolygon-Gebäude (Relation)
  const mp = line([
    [-320, 5],
    [-310, 5],
    [-310, 15],
    [-320, 15],
  ]);
  const mpw1 = way([mp[0], mp[1], mp[2]], {});
  const mpw2 = way([mp[2], mp[3], mp[0]], {});
  relations.push({
    id: rid++,
    tags: { type: 'multipolygon', building: 'yes', ...addr('Blumenstraße', '1', '00001', 'Musterdorf') },
    members: [
      { type: 'way', ref: mpw1, role: 'outer' },
      { type: 'way', ref: mpw2, role: 'outer' },
    ],
  });

  // --- Schilfring: Neubaugebiet, Straße im Bau, keine Hausnummern ---
  const s = line([
    [200, 200],
    [300, 200],
    [300, 300],
    [200, 300],
  ]);
  way([...s, s[0]], { highway: 'construction', construction: 'residential', name: 'Schilfring' });
  // Nachbarstraße mit Schreibvariante in den Adressen
  const r = line([
    [200, 200],
    [200, 60],
  ]);
  way(r, { highway: 'residential', name: 'Reetweg' });
  node(214, 120, addr('Reetweg', '2', '00002', 'Beispielhausen'));
  node(214, 150, addr('Reetweg', '4', '00002', 'Beispielhausen'));

  // --- "Am Deich": nur Adressen, keine Straßengeometrie ---
  node(-600, 120, addr('Am Deich', '1', '00001', 'Musterdorf'));
  node(-580, 120, addr('Am Deich', '3', '00001', 'Musterdorf'));

  // --- Dorfstraße zweimal: im Ort und 6 km entfernt (anderes Dorf, PLZ 00003) ---
  way(line([[-800, -300], [-600, -300]]), { highway: 'residential', name: 'Dorfstraße' });
  node(-700, -285, addr('Dorfstraße', '1', '00001', 'Musterdorf'));
  way(line([[6000, -300], [6200, -300]]), { highway: 'residential', name: 'Dorfstraße' });
  node(6100, -285, addr('Dorfstraße', '1', '00003', 'Fernhausen'));
  node(6150, -285, addr('Dorfstraße', '3', '00003', 'Fernhausen'));

  // --- Flächen: PLZ (00001 West, 00002 Ost, 00003 fern), Land, Gemeinden ---
  const area = (pts, tags, split = true) => {
    const ids = line(pts);
    const mid = Math.floor(ids.length / 2);
    const members = split
      ? [way(ids.slice(0, mid + 1), {}), way([...ids.slice(mid), ids[0]], {})]
      : [way([...ids, ids[0]], {})];
    relations.push({ id: rid++, tags, members: members.map((ref) => ({ type: 'way', ref, role: 'outer' })) });
  };
  const west = [[-1500, -1000], [0, -1000], [0, 1000], [-1500, 1000]];
  const east = [[0, -1000], [1500, -1000], [1500, 1000], [0, 1000]];
  area(west, { type: 'boundary', boundary: 'postal_code', postal_code: '00001' });
  area(east, { type: 'boundary', boundary: 'postal_code', postal_code: '00002' });
  area([[5500, -1000], [6500, -1000], [6500, 1000], [5500, 1000]], { type: 'boundary', boundary: 'postal_code', postal_code: '00003' });
  area([[-2000, -2000], [2000, -2000], [2000, 2000], [-2000, 2000]], { type: 'boundary', boundary: 'administrative', admin_level: '4', name: 'Niedersachsen' });
  area(west, { type: 'boundary', boundary: 'administrative', admin_level: '8', name: 'Musterdorf' }, false);
  area(east, { type: 'boundary', boundary: 'administrative', admin_level: '8', name: 'Beispielhausen' }, false);

  return { nodes, ways, relations, proj };
}
