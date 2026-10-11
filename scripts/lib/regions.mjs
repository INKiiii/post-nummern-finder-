// Zusammenführen der Quellen, Straßen bilden, Gebiete zuordnen, Pakete schreiben.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { normStreet } from '../../src/shared/normalize.js';
import { normHouseNumber, splitHouseNumbers, completeness, compareHouseNumbers } from '../../src/shared/housenumber.js';
import { makeProjection, distanceM } from '../../src/shared/geo.js';
import { encodeLine, PACKAGE_FORMAT, PACKAGE_VERSION } from '../../src/shared/lookup.js';
import { AreaIndex, PointGrid, SegmentGrid } from './polygons.mjs';

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
    // 3) Abgetrennte Stücke ohne Hausnummern (z. B. Feldweg-Fortsetzung) gehören zur
    //    gleichnamigen Straße in der Nähe (bis 1,5 km): zusammenführen statt doppelt anzeigen.
    const merged = mergeEmptyClusters(list, 1500).flatMap((c) => splitByMunicipality(c));
    for (const c of merged) {
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

/**
 * Ordnet Zufahrtswege (highway=service, service=driveway) den Häusern zu.
 * Ein Ende muss an einer benannten Straße liegen (Abzweigung, max. 15 m),
 * das andere Ende beim Haus (Adresse max. 30 m, notfalls 45 m entfernt).
 * Die Linie beginnt immer an der Straße; der erste Punkt ist die Abzweigung.
 * @returns {number} Anzahl zugeordneter Zufahrten
 */
export function attachDriveways(streets, drivewaySegments) {
  if (!drivewaySegments?.length) return 0;
  const roads = new SegmentGrid();
  const addrs = new PointGrid(0.001);
  for (const st of streets) {
    for (const l of st.lines) roads.addLine(l, st);
    for (const a of st.addresses) addrs.add(a.lat, a.lon, { a, st });
  }
  let attached = 0;
  for (const raw of mergeChains(drivewaySegments)) {
    const A = raw[0];
    const B = raw[raw.length - 1];
    const ja = roads.nearest(A[0], A[1], 15);
    const jb = roads.nearest(B[0], B[1], 15);
    if (!ja && !jb) continue;
    // Abzweigung = das Ende näher an einer Straße; Linie von dort zum Haus
    const fromA = ja && (!jb || ja.d <= jb.d);
    const line = fromA ? [...raw] : [...raw].reverse();
    const junction = fromA ? ja : jb;
    if (junction.d > 1) line.unshift(junction.point);
    const end = line[line.length - 1];
    let houses = addrs.within(end[0], end[1], 30);
    if (!houses.length) houses = addrs.within(end[0], end[1], 45).slice(0, 1);
    if (!houses.length) continue;
    const simplified = simplifyLine(line, 1);
    const byStreet = new Map();
    for (const { item } of houses.slice(0, 4)) {
      const l = byStreet.get(item.st);
      l ? l.push(item.a.housenumber) : byStreet.set(item.st, [item.a.housenumber]);
    }
    for (const [st, labels] of byStreet) (st.driveways ??= []).push({ labels, line: simplified });
    attached++;
  }
  return attached;
}

/**
 * Zählt Hausnummern, die in einer Adressliste mehrfach an weit auseinanderliegenden
 * Stellen (> 150 m) vorkommen – Zeichen für zwei getrennte Nummernfolgen.
 */
export function farDuplicates(addrs) {
  const byNum = new Map();
  for (const a of addrs) {
    const k = normHouseNumber(a.housenumber);
    const l = byNum.get(k);
    l ? l.push(a) : byNum.set(k, [a]);
  }
  let n = 0;
  for (const l of byNum.values()) {
    if (l.length < 2) continue;
    if (l.some((a, i) => l.some((b, j) => j > i && distanceM(a.lat, a.lon, b.lat, b.lon) > 150))) n++;
  }
  return n;
}

/**
 * Trennt eine Straße, die durch mehrere Gemeinden (oder Ortsteile) läuft und dort jeweils
 * eigene Nummern hat (z. B. Elbuferstraße in Tespe und in Marschacht: zweimal Nr. 95).
 * Getrennt wird nach addr:city, notfalls nach Ortsteil oder PLZ – nur wenn das die
 * doppelten Nummern tatsächlich auflöst. Wegstücke gehen an den Teil mit den nächsten Adressen.
 */
export function splitByMunicipality(c) {
  const addrs = c.addrs;
  if (addrs.length < 6) return [c];
  const baseline = farDuplicates(addrs);
  if (baseline < 3) return [c];
  const keyFns = [
    (a) => (a.city || '').trim().toLowerCase(),
    (a) => ((a.city || '') + '|' + (a.suburb || '')).trim().toLowerCase(),
    (a) => (a.postcode || '').trim(),
  ];
  for (const keyFn of keyFns) {
    const groups = new Map();
    const unkeyed = [];
    for (const a of addrs) {
      const k = keyFn(a);
      if (!k || k === '|') unkeyed.push(a);
      else (groups.get(k) ?? groups.set(k, []).get(k)).push(a);
    }
    const big = [...groups.values()].filter((g) => g.length >= 3);
    if (big.length < 2) continue;
    const remaining = [...groups.values()].reduce((n, g) => n + farDuplicates(g), 0);
    if (remaining > baseline * 0.2) continue;
    // Adressen ohne Ort/PLZ: zur Gruppe der nächsten Adresse
    const keyed = [...groups.entries()].flatMap(([k, g]) => g.map((a) => [k, a]));
    const nearestKey = (lat, lon) => {
      let best = null;
      let bestD = Infinity;
      for (const [k, a] of keyed) {
        const d = (a.lat - lat) ** 2 + ((a.lon - lon) * 0.6) ** 2;
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      return best;
    };
    for (const a of unkeyed) groups.get(nearestKey(a.lat, a.lon)).push(a);
    const parts = new Map([...groups.keys()].map((k) => [k, { ...c, segs: [], addrs: groups.get(k), names: [] }]));
    // Wegstücke an der Grenze teilen: jeder Punkt gehört zum Teil mit der nächsten Adresse.
    // Wechselt der Teil zwischen zwei Stützpunkten, wird der Grenzpunkt per Halbierung gesucht.
    let synthId = -1;
    for (const seg of c.segs) {
      const keys = seg.pts.map(([la, lo]) => nearestKey(la, lo));
      let curKey = keys[0];
      let pts = [seg.pts[0]];
      let ids = [seg.nodeIds[0]];
      const flush = () => {
        if (pts.length >= 2) {
          const part = parts.get(curKey);
          part.segs.push({ ...seg, nodeIds: ids, pts });
          part.names.push(seg.name);
        }
      };
      for (let i = 1; i < seg.pts.length; i++) {
        if (keys[i] !== curKey) {
          let lo = seg.pts[i - 1];
          let hi = seg.pts[i];
          for (let k = 0; k < 16; k++) {
            const m = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
            if (nearestKey(m[0], m[1]) === curKey) lo = m;
            else hi = m;
          }
          const cut = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
          const cutId = synthId--;
          pts.push(cut);
          ids.push(cutId);
          flush();
          curKey = keys[i];
          pts = [cut];
          ids = [cutId];
        }
        pts.push(seg.pts[i]);
        ids.push(seg.nodeIds[i]);
      }
      flush();
    }
    return [...parts.values()].map((p) => ({
      ...p,
      bbox: bboxOfPts([...p.segs.flatMap((sg) => sg.pts), ...p.addrs.map((a) => [a.lat, a.lon])]),
      pointsOnly: !p.segs.length,
    }));
  }
  return [c];
}

/** Führt Cluster ohne Adressen mit dem nächsten gleichnamigen Cluster (bis maxM) zusammen. */
export function mergeEmptyClusters(list, maxM) {
  const uf = new UnionFind(list.length);
  for (let i = 0; i < list.length; i++) {
    if (list[i].addrs.length) continue;
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < list.length; j++) {
      if (j === i) continue;
      const d = bboxGapM(list[i].bbox, list[j].bbox);
      // Cluster mit Adressen bevorzugen
      const score = d - (list[j].addrs.length ? 1e-6 : 0);
      if (d <= maxM && score < bestD) {
        bestD = score;
        best = j;
      }
    }
    if (best >= 0) uf.union(i, best);
  }
  const groups = new Map();
  list.forEach((c, i) => {
    const r = uf.find(i);
    const g = groups.get(r);
    if (!g) groups.set(r, { ...c, segs: [...c.segs], addrs: [...c.addrs], names: [...c.names] });
    else {
      g.segs.push(...c.segs);
      g.addrs.push(...c.addrs);
      g.names.push(...c.names);
      g.bbox = [Math.min(g.bbox[0], c.bbox[0]), Math.min(g.bbox[1], c.bbox[1]), Math.max(g.bbox[2], c.bbox[2]), Math.max(g.bbox[3], c.bbox[3])];
      g.pointsOnly = g.pointsOnly && c.pointsOnly;
    }
  });
  return [...groups.values()];
}

/**
 * Ordnet Wohngebäude ohne Hausnummer der nächsten Straße zu (bis 50 m), sofern dort keine
 * Adresse liegt. Damit lassen sich geschätzte Lagen auf echte Gebäude setzen und Straßen
 * ohne Nummern von Feldwegen ohne Häuser unterscheiden.
 * @returns {number} Anzahl zugeordneter Gebäude
 */
export function attachBuildings(streets, buildings) {
  if (!buildings?.length) return 0;
  const roads = new SegmentGrid();
  const addrs = new PointGrid(0.001);
  for (const st of streets) {
    for (const l of st.lines) roads.addLine(l, st);
    for (const a of st.addresses) addrs.add(a.lat, a.lon, a);
  }
  let n = 0;
  for (const [lat, lon] of buildings) {
    if (addrs.within(lat, lon, 8).length) continue;
    const near = roads.nearest(lat, lon, 50);
    if (!near) continue;
    (near.item.buildings ??= []).push([lat, lon]);
    n++;
  }
  return n;
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
        q: {
          min: q.min,
          max: q.max,
          missing: q.missing.slice(0, 200),
          count: q.count,
          ratio: Math.round(q.ratio * 1000) / 1000,
          gap: q.gap,
          // Wohngebäude ohne Nummer an dieser Straße (0 bei Lücke = Weg ohne Häuser)
          bu: st.buildings?.length ?? 0,
        },
      };
      if (st.isPlace) s.t = 'place';
      if (st.driveways?.length) s.d = st.driveways.map((d) => [d.labels, encodeLine(d.line)]);
      if (st.buildings?.length) s.b = encodeLine(st.buildings);
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
