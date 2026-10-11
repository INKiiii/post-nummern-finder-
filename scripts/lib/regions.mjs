// Zusammenführen der Quellen, Straßen bilden, Gebiete zuordnen, Pakete schreiben.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { normStreet } from '../../src/shared/normalize.js';
import { normHouseNumber, splitHouseNumbers, completeness, compareHouseNumbers } from '../../src/shared/housenumber.js';
import { makeProjection, distanceM } from '../../src/shared/geo.js';
import { encodeLine, PACKAGE_FORMAT, PACKAGE_VERSION } from '../../src/shared/lookup.js';
import { AreaIndex, PointGrid } from './polygons.mjs';

const PLZ_RE = /^\d{5}$/;

/**
 * Führt Adressen mehrerer Quellen zusammen. Gleiche Adresse (Straße + Nummer,
 * Abstand < 150 m) wird nur einmal übernommen; die bevorzugte Quelle liefert die Lage.
 * @param {{meta:object, addresses:object[]}[]} sources
 * @param {string[]} preferOrder Quellen-IDs, beste zuerst
 */
export function mergeAddresses(sources, preferOrder = []) {
  const rank = (id) => {
    const i = preferOrder.indexOf(id);
    return i < 0 ? preferOrder.length : i;
  };
  const byKey = new Map();
  const out = [];
  let merged = 0;
  for (const src of sources) {
    for (const a of src.addresses) {
      for (const hn of splitHouseNumbers(a.housenumber)) {
        const rec = { ...a, housenumber: hn, norm: normStreet(a.street) };
        const key = rec.norm + '|' + normHouseNumber(hn);
        const list = byKey.get(key);
        const dup = list?.find((b) => distanceM(b.lat, b.lon, rec.lat, rec.lon) < 150);
        if (dup) {
          merged++;
          dup.sources.add(rec.source);
          if (rank(rec.source) < rank(dup.source)) {
            dup.lat = rec.lat;
            dup.lon = rec.lon;
            dup.source = rec.source;
          }
          dup.postcode ||= rec.postcode;
          dup.city ||= rec.city;
          dup.suburb ||= rec.suburb;
          continue;
        }
        rec.sources = new Set([rec.source]);
        list ? list.push(rec) : byKey.set(key, [rec]);
        out.push(rec);
      }
    }
  }
  return { addresses: out, merged };
}

class UnionFind {
  constructor(n) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(i) {
    while (this.p[i] !== i) i = this.p[i] = this.p[this.p[i]];
    return i;
  }
  union(a, b) {
    this.p[this.find(a)] = this.find(b);
  }
}

function bboxOfPts(pts) {
  let y0 = Infinity;
  let x0 = Infinity;
  let y1 = -Infinity;
  let x1 = -Infinity;
  for (const [y, x] of pts) {
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
  }
  return [y0, x0, y1, x1];
}

/** Ungefährer Abstand (m) zwischen zwei Boxen [minLat,minLon,maxLat,maxLon]. */
function bboxGapM(a, b) {
  const dy = Math.max(0, a[0] - b[2], b[0] - a[2]) * 111320;
  const kx = 111320 * Math.cos((((a[0] + a[2]) / 2) * Math.PI) / 180);
  const dx = Math.max(0, a[1] - b[3], b[1] - a[3]) * kx;
  return Math.hypot(dx, dy);
}

/** Verbindet Wegstücke mit gemeinsamen Endknoten zu möglichst langen Linien. */
export function mergeChains(segs) {
  const ends = new Map();
  const add = (id, i) => {
    const l = ends.get(id);
    l ? l.push(i) : ends.set(id, [i]);
  };
  segs.forEach((s, i) => {
    add(s.nodeIds[0], i);
    add(s.nodeIds[s.nodeIds.length - 1], i);
  });
  const used = new Uint8Array(segs.length);
  const chains = [];
  const take = (endId) => {
    const c = (ends.get(endId) ?? []).find((i) => !used[i]);
    if (c === undefined) return null;
    used[c] = 1;
    const s = segs[c];
    return s.nodeIds[0] === endId ? s : { nodeIds: [...s.nodeIds].reverse(), pts: [...s.pts].reverse() };
  };
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let ids = [...segs[i].nodeIds];
    let pts = [...segs[i].pts];
    for (let n; (n = take(ids[ids.length - 1])); ) {
      ids.push(...n.nodeIds.slice(1));
      pts.push(...n.pts.slice(1));
    }
    for (let n; (n = take(ids[0])); ) {
      // n beginnt bei ids[0] -> umgekehrt voranstellen
      ids = [...[...n.nodeIds].reverse().slice(0, -1), ...ids];
      pts = [...[...n.pts].reverse().slice(0, -1), ...pts];
    }
    chains.push(pts);
  }
  return chains;
}

/** Douglas-Peucker-Vereinfachung (Toleranz in Metern). */
export function simplifyLine(pts, tol = 1.5) {
  if (pts.length <= 2) return pts;
  const proj = makeProjection(pts[0][0], pts[0][1]);
  const xy = pts.map(([la, lo]) => proj.toXY(la, lo));
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = xy[a];
    const [bx, by] = xy[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-9;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * xy[i][0] - dx * xy[i][1] + bx * ay - by * ax) / len;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function majority(values) {
  const m = new Map();
  for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
  let best = '';
  let n = 0;
  for (const [v, c] of m) if (c > n) [best, n] = [v, c];
  return best;
}

/**
 * Bildet Straßen aus gleichnamigen, benachbarten Wegstücken und ordnet Adressen zu.
 * Adressen ohne passende Straßengeometrie ergeben Straßen nur aus Punkten.
 */
export function buildStreets(segments, addresses) {
  const groups = new Map();
  const g = (norm) => {
    let x = groups.get(norm);
    if (!x) groups.set(norm, (x = { segs: [], addrs: [] }));
    return x;
  };
  for (const s of segments) g(normStreet(s.name)).segs.push(s);
  for (const a of addresses) g(a.norm).addrs.push(a);

  const streets = [];
  for (const [norm, { segs, addrs }] of groups) {
    // 1) Wegstücke clustern: gemeinsamer Knoten oder Abstand < 100 m.
    const boxes = segs.map((s) => bboxOfPts(s.pts));
    const uf = new UnionFind(segs.length);
    const nodeOwner = new Map();
    segs.forEach((s, i) => {
      for (const id of [s.nodeIds[0], s.nodeIds[s.nodeIds.length - 1]]) {
        const o = nodeOwner.get(id);
        if (o !== undefined) uf.union(i, o);
        else nodeOwner.set(id, i);
      }
    });
    const cell = 0.004;
    const grid = new Map();
    boxes.forEach((b, i) => {
      for (let y = Math.floor(b[0] / cell); y <= Math.floor(b[2] / cell); y++)
        for (let x = Math.floor(b[1] / cell); x <= Math.floor(b[3] / cell); x++) {
          const k = y * 1e6 + x;
          const l = grid.get(k);
          if (l) {
            for (const j of l) if (uf.find(i) !== uf.find(j) && bboxGapM(b, boxes[j]) < 100) uf.union(i, j);
            l.push(i);
          } else grid.set(k, [i]);
        }
    });
    const clusters = new Map();
    segs.forEach((s, i) => {
      const r = uf.find(i);
      let c = clusters.get(r);
      if (!c) clusters.set(r, (c = { norm, segs: [], addrs: [], names: [] }));
      c.segs.push(s);
      c.names.push(s.name);
    });
    const list = [...clusters.values()];
    for (const c of list) c.bbox = bboxOfPts(c.segs.flatMap((s) => s.pts));

    // 2) Adressen der nächstgelegenen gleichnamigen Straße zuordnen (max. 600 m).
    for (const a of addrs) {
      let best = null;
      let bestD = Infinity;
      for (const c of list) {
        const d = bboxGapM(c.bbox, [a.lat, a.lon, a.lat, a.lon]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (best && bestD < (best.segs.length ? 600 : 400)) {
        best.addrs.push(a);
        if (!best.segs.length) best.bbox = bboxOfPts([...best.addrs.map((x) => [x.lat, x.lon])]);
      } else {
        const c = { norm, segs: [], addrs: [a], names: [], bbox: [a.lat, a.lon, a.lat, a.lon], pointsOnly: true };
        list.push(c);
      }
    }
    for (const c of list) {
      const chains = c.segs.length ? mergeChains(c.segs).map((l) => simplifyLine(l)) : [];
      streets.push({
        norm,
        name: majority([...c.names, ...c.addrs.map((a) => a.street)]),
        lines: chains,
        addresses: c.addrs,
        isPlace: c.addrs.length > 0 && c.addrs.every((a) => a.isPlace),
        bbox: c.bbox,
        highway: majority(c.segs.map((s) => s.highway)),
      });
    }
  }
  return streets;
}

function streetMid(st) {
  const longest = st.lines.reduce((a, l) => (l.length > (a?.length ?? 0) ? l : a), null);
  if (longest) return longest[Math.floor(longest.length / 2)];
  return [(st.bbox[0] + st.bbox[2]) / 2, (st.bbox[1] + st.bbox[3]) / 2];
}

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function slug(s) {
  return normStreet(s).replace(/[^a-z0-9]/g, '').slice(0, 40) || 'gebiet';
}

/**
 * Ordnet Straßen und Adressen Gebieten zu.
 * @param {object[]} streets aus buildStreets
 * @param {{postal:object[], admin:Record<string,object[]>}} areas
 * @param {{group:'plz'|'kreis', state?:string, only?:string[], plzPrefix?:string[]}} opts
 */
export function assignRegions(streets, areas, opts) {
  const postal = new AreaIndex(areas.postal ?? []);
  const kreise = new AreaIndex(areas.admin?.['6'] ?? []);
  const gemeinden = new AreaIndex(areas.admin?.['8'] ?? []);
  const withPlz = new PointGrid();
  for (const st of streets) for (const a of st.addresses) if (PLZ_RE.test(a.postcode)) withPlz.add(a.lat, a.lon, a);

  const plzAt = (lat, lon) => postal.find(lat, lon)?.key ?? withPlz.nearest(lat, lon)?.postcode ?? null;
  const keyAt = (lat, lon, postcode) => {
    if (opts.group === 'kreis') return kreise.find(lat, lon)?.key ?? null;
    return PLZ_RE.test(postcode ?? '') ? postcode : plzAt(lat, lon);
  };

  const regions = new Map();
  const region = (key) => {
    let r = regions.get(key);
    if (!r) regions.set(key, (r = { key, streets: new Set(), cities: new Map(), plz: new Set(), sample: [] }));
    return r;
  };
  let unassigned = 0;
  for (const st of streets) {
    const keys = new Set();
    for (const a of st.addresses) {
      a.plz = PLZ_RE.test(a.postcode) ? a.postcode : plzAt(a.lat, a.lon) ?? '';
      const k = keyAt(a.lat, a.lon, a.plz);
      if (!k) continue;
      keys.add(k);
      const r = region(k);
      if (a.plz) r.plz.add(a.plz);
      const place = a.city || gemeinden.find(a.lat, a.lon)?.name || '';
      if (place) r.cities.set(place, (r.cities.get(place) ?? 0) + 1);
      if (a.suburb && a.suburb !== place) r.cities.set(a.suburb, (r.cities.get(a.suburb) ?? 0) + 0.5);
      if (r.sample.length < 40) r.sample.push([a.lat, a.lon]);
    }
    for (const line of st.lines) {
      const [lat, lon] = line[Math.floor(line.length / 2)];
      const k = keyAt(lat, lon, null);
      if (k && (!st.addresses.length || opts.group === 'kreis' || postal.find(lat, lon))) keys.add(k);
    }
    if (!keys.size) {
      const [lat, lon] = streetMid(st);
      const k = keyAt(lat, lon, null);
      if (k) keys.add(k);
    }
    if (!keys.size) {
      unassigned++;
      continue;
    }
    const [mLat, mLon] = streetMid(st);
    st.place =
      majority(st.addresses.map((a) => (a.city && a.suburb && a.suburb !== a.city ? `${a.city} (${a.suburb})` : a.city))) ||
      gemeinden.find(mLat, mLon)?.name ||
      withPlz.nearest(mLat, mLon)?.city ||
      '';
    st.plz = majority(st.addresses.map((a) => a.plz)) || plzAt(mLat, mLon) || '';
    st.regionKeys = keys;
    for (const k of keys) {
      const r = region(k);
      r.streets.add(st);
      if (opts.group === 'plz') r.plz.add(k);
      if (r.sample.length < 40) r.sample.push([mLat, mLon]);
    }
  }

  // Filter: Bundesland, PLZ-Präfix, einzelne Gebiete
  let stateArea = null;
  if (opts.state) {
    stateArea = (areas.admin?.['4'] ?? []).find((a) => a.name.toLowerCase() === opts.state.toLowerCase());
    if (!stateArea) process.stderr.write(`Warnung: Landesgrenze "${opts.state}" nicht in den Daten, kein Filter nach Bundesland.\n`);
  }
  const stateIdx = stateArea ? new AreaIndex([stateArea]) : null;
  const out = [];
  for (const r of regions.values()) {
    if (opts.only?.length && !opts.only.includes(r.key) && !opts.only.includes(slug(r.key))) continue;
    if (opts.plzPrefix?.length && opts.group === 'plz' && !opts.plzPrefix.some((p) => r.key.startsWith(p))) continue;
    if (stateIdx && r.sample.length) {
      const inside = r.sample.filter(([la, lo]) => stateIdx.find(la, lo)).length;
      if (inside / r.sample.length < 0.5) continue;
    }
    const places = [...r.cities.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    const id = opts.group === 'kreis' ? slug(r.key) : r.key;
    out.push({
      id,
      key: r.key,
      name: opts.group === 'kreis' ? r.key : `${r.key} ${places[0] ?? ''}`.trim(),
      plz: [...r.plz].filter((p) => PLZ_RE.test(p)).sort(),
      places,
      streets: [...r.streets],
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return { regions: out, unassigned };
}

/** Vergibt stabile Straßen-IDs (Name + grobe Lage). */
export function assignStreetIds(streets) {
  const used = new Set();
  for (const st of streets) {
    const [lat, lon] = streetMid(st);
    let id = fnv(`${st.norm}|${lat.toFixed(2)}|${lon.toFixed(2)}`);
    let n = 2;
    while (used.has(id)) id = fnv(`${st.norm}|${lat.toFixed(2)}|${lon.toFixed(2)}|${n++}`);
    used.add(id);
    st.id = id;
  }
}

/** Erzeugt das Paketobjekt eines Gebiets. */
export function makePackage(region, sourcesMeta, built) {
  const srcIds = new Set();
  for (const st of region.streets) for (const a of st.addresses) srcIds.add(a.source);
  const sources = sourcesMeta.filter((m) => srcIds.has(m.id) || m.id === 'osm');
  const srcIndex = new Map(sources.map((m, i) => [m.id, i]));
  const mainPlz = region.plz.length === 1 ? region.plz[0] : '';
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  const streets = [...region.streets]
    .sort((a, b) => a.name.localeCompare(b.name, 'de'))
    .map((st) => {
      const addrs = [...st.addresses].sort((a, b) => compareHouseNumbers(a.housenumber, b.housenumber));
      const q = completeness(addrs.map((a) => a.housenumber));
      for (const [y0, x0, y1, x1] of [st.bbox]) {
        minLat = Math.min(minLat, y0);
        minLon = Math.min(minLon, x0);
        maxLat = Math.max(maxLat, y1);
        maxLon = Math.max(maxLon, x1);
      }
      const s = {
        id: st.id,
        n: st.name,
        p: st.place || undefined,
        z: st.plz && st.plz !== mainPlz ? st.plz : undefined,
        l: st.lines.map(encodeLine),
        h: addrs.map((a) => {
          const e = [a.housenumber, Math.round(a.lat * 1e6), Math.round(a.lon * 1e6)];
          const si = srcIndex.get(a.source) ?? 0;
          const z = a.plz && a.plz !== mainPlz ? a.plz : undefined;
          if (si || z) e.push(si);
          if (z) e.push(z);
          return e;
        }),
        q: { min: q.min, max: q.max, missing: q.missing.slice(0, 200), count: q.count, ratio: Math.round(q.ratio * 1000) / 1000, gap: q.gap },
      };
      if (st.isPlace) s.t = 'place';
      return s;
    });
  return {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    id: region.id,
    name: region.name,
    plz: mainPlz,
    plzList: region.plz,
    places: region.places,
    built,
    bbox: [minLat, minLon, maxLat, maxLon].map((v) => Math.round(v * 1e6) / 1e6),
    sources,
    streets,
  };
}

export function writePackage(pkg, outDir) {
  const json = JSON.stringify(pkg);
  const gz = zlib.gzipSync(json, { level: 9 });
  const file = `${pkg.id}.json.gz`;
  fs.writeFileSync(path.join(outDir, file), gz);
  // Hash nur über den Inhalt (ohne Bauzeit), damit "Aktualisieren" nur echte Änderungen meldet.
  const hash = crypto
    .createHash('sha1')
    .update(JSON.stringify([pkg.name, pkg.sources.map((s) => s.id), pkg.streets]))
    .digest('hex')
    .slice(0, 12);
  return { file, size: gz.length, rawSize: json.length, hash };
}
