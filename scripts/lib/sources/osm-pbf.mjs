// Datenquelle: OSM-Auszug (.osm.pbf), z. B. von download.geofabrik.de.
// Drei Durchläufe, jeder liest nur die nötigen Blöcke:
//   A) alle Blöcke: Adressknoten, relevante Wege, Relationen (Gebäude-Multipolygone, PLZ-/Verwaltungsgrenzen)
//   B) nur Weg-Blöcke: Mitgliedswege der Relationen
//   C) nur Knoten-Blöcke: Koordinaten aller benötigten Knoten

import fs from 'node:fs';
import { iterateBlobs, readBlob, readHeader, parseBlock, blockKinds, eachNode, eachWay, eachRelation } from '../pbf.mjs';
import { assembleRings, ringArea } from '../polygons.mjs';
import { makeProjection, polygonCentroid, lineLength, pointAtS } from '../../../src/shared/geo.js';

// Straßenarten, die für die Zustellung relevant sind (mit Namen).
const HIGHWAYS = new Set([
  'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
  'trunk', 'unclassified', 'residential', 'living_street', 'service', 'pedestrian',
  'track', 'road', 'construction', 'footway', 'path', 'cycleway', 'steps', 'bridleway',
]);

function addrOf(tags) {
  const hn = tags['addr:housenumber'];
  const street = tags['addr:street'];
  const place = tags['addr:place'];
  if (!hn || (!street && !place)) return null;
  return {
    housenumber: hn,
    street: street ?? place,
    isPlace: !street,
    postcode: tags['addr:postcode'] ?? '',
    city: tags['addr:city'] ?? '',
    suburb: tags['addr:suburb'] ?? tags['addr:hamlet'] ?? '',
  };
}

function log(msg) {
  process.stderr.write(msg + '\n');
}

/** Wachsender Float64-Puffer für Knoten-IDs. */
class IdList {
  constructor() {
    this.a = new Float64Array(1 << 20);
    this.n = 0;
  }
  push(v) {
    if (this.n === this.a.length) {
      const b = new Float64Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  pushAll(arr) {
    for (const v of arr) this.push(v);
  }
  sortedUnique() {
    const s = this.a.subarray(0, this.n).sort();
    let w = 0;
    for (let i = 0; i < s.length; i++) if (i === 0 || s[i] !== s[i - 1]) s[w++] = s[i];
    return s.slice(0, w);
  }
}

/**
 * @param {string} file Pfad zur .osm.pbf
 * @param {{adminLevels?:string[]}} [opts]
 */
export function loadOsmPbf(file, opts = {}) {
  const adminLevels = new Set(opts.adminLevels ?? ['4', '6', '8']);
  const fd = fs.openSync(file, 'r');
  const t0 = Date.now();
  const blobs = [];
  let replicationTimestamp = null;

  const addrNodes = [];
  const addrWays = []; // {id, tags(addr), refs}
  const interpWays = []; // {type, street, refs} – addr:interpolation-Linien
  const plainBuildings = []; // Gebäude ohne Hausnummer (Wohngebäude), nur refs
  const segments = []; // {id, name, highway, refs}
  const driveways = []; // {id, refs} – Zufahrtswege (highway=service, service=driveway)
  const addrRels = []; // {addr, outer:[wayIds]}
  const areaRels = []; // {kind:'postal'|'admin', level, key, name, ways:[wayIds]}
  const memberWayIds = new Set();

  // ---------- Durchlauf A ----------
  let count = 0;
  for (const blob of iterateBlobs(fd)) {
    if (blob.type === 'OSMHeader') {
      const h = readHeader(readBlob(fd, blob));
      replicationTimestamp = h.replicationTimestamp;
      const unsupported = h.required.filter((f) => !['OsmSchema-V0.6', 'DenseNodes', 'HistoricalInformation', 'Sort.Type_then_ID'].includes(f));
      if (unsupported.length) log('Warnung: nicht unterstützte PBF-Features: ' + unsupported.join(', '));
      continue;
    }
    if (blob.type !== 'OSMData') continue;
    const block = parseBlock(readBlob(fd, blob));
    const kinds = blockKinds(block);
    blobs.push({ ...blob, kinds });
    if (kinds & 1 && block.strings.includes('addr:housenumber')) {
      eachNode(block, true, (id, lat, lon, tags) => {
        if (!tags) return;
        const a = addrOf(tags);
        if (a) addrNodes.push({ ...a, lat, lon, osm: 'n' + id });
      });
    }
    if (kinds & 2) {
      eachWay(block, (id, tags, getRefs) => {
        const a = addrOf(tags);
        if (a) addrWays.push({ id, addr: a, refs: getRefs(), building: !!tags.building });
        else if (tags.building && RESIDENTIAL.has(tags.building) && !tags['addr:housenumber']) {
          plainBuildings.push(getRefs());
        }
        if (tags['addr:interpolation']) {
          interpWays.push({ type: tags['addr:interpolation'], street: tags['addr:street'] ?? '', refs: getRefs() });
        }
        const hw = tags.highway;
        if (hw && tags.name && HIGHWAYS.has(hw === 'construction' ? 'construction' : hw) && tags.area !== 'yes') {
          segments.push({ id, name: tags.name, highway: hw, refs: getRefs() });
        } else if (hw === 'service' && tags.service === 'driveway') {
          driveways.push({ id, refs: getRefs() });
        }
      });
    }
    if (kinds & 4) {
      eachRelation(block, (id, tags, getMembers) => {
        const type = tags.type;
        const a = addrOf(tags);
        if (a && (type === 'multipolygon' || type === 'building')) {
          const outer = getMembers().filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === '' || m.role === 'outline'));
          if (outer.length) {
            addrRels.push({ id, addr: a, ways: outer.map((m) => m.ref) });
            outer.forEach((m) => memberWayIds.add(m.ref));
          }
        }
        let area = null;
        if (tags.boundary === 'postal_code' && /^\d{5}$/.test(tags.postal_code ?? '')) {
          area = { kind: 'postal', key: tags.postal_code, name: tags.note ?? tags.name ?? '' };
        } else if (tags.boundary === 'administrative' && adminLevels.has(tags.admin_level) && tags.name) {
          area = { kind: 'admin', level: tags.admin_level, key: tags.name, name: tags.name };
        }
        if (area) {
          const ways = getMembers().filter((m) => m.type === 'way' && m.role !== 'subarea' && m.role !== 'admin_centre' && m.role !== 'label');
          area.ways = ways.map((m) => m.ref);
          area.ways.forEach((w) => memberWayIds.add(w));
          areaRels.push(area);
        }
      });
    }
    if (++count % 500 === 0) log(`  A: ${count} Blöcke, ${addrNodes.length + addrWays.length} Adressen, ${segments.length} Straßenstücke`);
  }
  log(`Durchlauf A fertig (${((Date.now() - t0) / 1000).toFixed(0)} s): ${addrNodes.length} Adressknoten, ${addrWays.length} Adresswege, ${addrRels.length} Adressrelationen, ${segments.length} Straßenstücke, ${driveways.length} Zufahrten, ${areaRels.length} Grenzen`);

  // ---------- Durchlauf B ----------
  const memberWays = new Map();
  if (memberWayIds.size) {
    for (const blob of blobs) {
      if (!(blob.kinds & 2)) continue;
      eachWay(parseBlock(readBlob(fd, blob)), (id, _tags, getRefs) => {
        if (memberWayIds.has(id)) memberWays.set(id, getRefs());
      });
    }
    log(`Durchlauf B fertig: ${memberWays.size}/${memberWayIds.size} Mitgliedswege gefunden`);
  }

  // ---------- Durchlauf C ----------
  const need = new IdList();
  for (const w of addrWays) need.pushAll(w.refs);
  for (const w of interpWays) need.pushAll(w.refs);
  for (const refs of plainBuildings) need.pushAll(refs);
  for (const s of segments) need.pushAll(s.refs);
  for (const d of driveways) need.pushAll(d.refs);
  for (const refs of memberWays.values()) need.pushAll(refs);
  const ids = need.sortedUnique();
  const lats = new Int32Array(ids.length);
  const lons = new Int32Array(ids.length);
  const found = new Uint8Array(ids.length);
  let ptr = 0;
  let lastId = -Infinity;
  const lowerBound = (v) => {
    let lo = 0;
    let hi = ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ids[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (const blob of blobs) {
    if (!(blob.kinds & 1)) continue;
    eachNode(parseBlock(readBlob(fd, blob)), false, (id, lat, lon) => {
      if (id < lastId) ptr = lowerBound(id); // unsortierte Datei
      lastId = id;
      while (ptr < ids.length && ids[ptr] < id) ptr++;
      if (ids[ptr] === id) {
        lats[ptr] = Math.round(lat * 1e7);
        lons[ptr] = Math.round(lon * 1e7);
        found[ptr] = 1;
      }
    });
  }
  fs.closeSync(fd);
  log(`Durchlauf C fertig: ${ids.length} Knoten benötigt (${((Date.now() - t0) / 1000).toFixed(0)} s)`);

  const coord = (id) => {
    const i = lowerBound(id);
    return i < ids.length && ids[i] === id && found[i] ? [lats[i] / 1e7, lons[i] / 1e7] : null;
  };
  const resolve = (refs) => {
    const nodeIds = [];
    const pts = [];
    for (const r of refs) {
      const c = coord(r);
      if (c) {
        nodeIds.push(r);
        pts.push(c);
      }
    }
    return { nodeIds, pts };
  };

  // ---------- Geometrien ----------
  const addresses = [];
  for (const a of addrNodes) addresses.push(a);
  for (const w of addrWays) {
    const { pts } = resolve(w.refs);
    const c = representativePoint(pts, w.refs[0] === w.refs[w.refs.length - 1]);
    if (c) addresses.push({ ...w.addr, lat: c[0], lon: c[1], osm: 'w' + w.id });
  }
  for (const r of addrRels) {
    const rings = assembleRings(r.ways.filter((id) => memberWays.has(id)).map((id) => resolve(memberWays.get(id))));
    if (!rings.length) continue;
    const largest = rings.reduce((a, b) => (ringArea(b) > ringArea(a) ? b : a));
    const c = representativePoint(largest, true);
    if (c) addresses.push({ ...r.addr, lat: c[0], lon: c[1], osm: 'r' + r.id });
  }

  const streetSegments = [];
  for (const s of segments) {
    const { nodeIds, pts } = resolve(s.refs);
    if (pts.length >= 2) streetSegments.push({ name: s.name, highway: s.highway, nodeIds, pts });
  }

  // addr:interpolation: Nummern zwischen zwei Adressknoten entlang der Linie verteilen
  const nodeAddr = new Map();
  for (const a of addrNodes) nodeAddr.set(Number(a.osm.slice(1)), a);
  let interpCount = 0;
  for (const w of interpWays) {
    for (const g of interpolateWay(w, nodeAddr, coord)) {
      addresses.push(g);
      interpCount++;
    }
  }

  // Wohngebäude ohne Hausnummer (Mittelpunkt, ab 30 m² Grundfläche)
  const buildings = [];
  // Gebäudeumrisse (vereinfacht, ~1 m genau) für die Karte: Gebäude mit Adresse + Wohngebäude
  const outlines = [];
  const withOutlines = opts.outlines !== false;
  if (withOutlines) {
    for (const w of addrWays) {
      if (!w.building || w.refs.length < 4 || w.refs[0] !== w.refs[w.refs.length - 1]) continue;
      const o = outlineOf(resolve(w.refs).pts);
      if (o) outlines.push(o);
    }
  }
  for (const refs of plainBuildings) {
    if (refs.length < 4 || refs[0] !== refs[refs.length - 1]) continue;
    const { pts } = resolve(refs);
    if (pts.length < 4) continue;
    const proj = makeProjection(pts[0][0], pts[0][1]);
    const ring = pts.slice(0, -1).map(([la, lo]) => proj.toXY(la, lo));
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    if (Math.abs(area / 2) < 30) continue;
    const [x, y] = polygonCentroid(ring);
    buildings.push(proj.toLatLon(x, y));
    if (withOutlines) {
      const o = outlineOf(pts);
      if (o) outlines.push(o);
    }
  }
  if (withOutlines) log(`Gebäudeumrisse: ${outlines.length}`);
  log(`Interpolationslinien: ${interpCount} Nummern erzeugt; ${buildings.length} Wohngebäude ohne Hausnummer`);

  const drivewaySegments = [];
  for (const d of driveways) {
    const r = resolve(d.refs);
    if (r.pts.length >= 2) drivewaySegments.push(r);
  }

  const areas = { postal: [], admin: {} };
  for (const a of areaRels) {
    const rings = assembleRings(a.ways.filter((id) => memberWays.has(id)).map((id) => resolve(memberWays.get(id))));
    if (!rings.length) continue;
    if (a.kind === 'postal') areas.postal.push({ key: a.key, name: a.name, rings });
    else (areas.admin[a.level] ??= []).push({ key: a.key, name: a.name, rings });
  }

  const date = replicationTimestamp ? new Date(replicationTimestamp * 1000).toISOString() : fs.statSync(file).mtime.toISOString();
  log(`OSM geladen: ${addresses.length} Adressen, ${streetSegments.length} Straßenstücke, ${areas.postal.length} PLZ-Flächen (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  return {
    meta: {
      id: 'osm',
      name: 'OpenStreetMap',
      license: 'ODbL-1.0',
      attribution: '© OpenStreetMap-Mitwirkende',
      url: 'https://www.openstreetmap.org/copyright',
      date,
    },
    addresses: addresses.map((a) => ({ ...a, source: a.source ?? 'osm' })),
    extraSources: [
      {
        id: 'osm-interp',
        name: 'OpenStreetMap (Interpolationslinie)',
        license: 'ODbL-1.0',
        attribution: '© OpenStreetMap-Mitwirkende',
        url: 'https://www.openstreetmap.org/copyright',
        date,
      },
    ],
    buildings,
    outlines,
    streetSegments,
    drivewaySegments,
    areas,
  };
}

/**
 * Vereinfachter Gebäudeumriss als Int32Array [lat, lon, ...] in 1e-5 Grad (offener Ring).
 * Punkte, die weniger als 0,6 m von der Verbindung ihrer Nachbarn abweichen, entfallen.
 */
export function outlineOf(pts) {
  if (pts.length < 4) return null;
  const proj = makeProjection(pts[0][0], pts[0][1]);
  let ring = pts.slice(0, -1).map(([la, lo]) => proj.toXY(la, lo));
  for (let changed = true; changed && ring.length > 3; ) {
    changed = false;
    for (let i = 0; i < ring.length && ring.length > 3; i++) {
      const a = ring[(i - 1 + ring.length) % ring.length];
      const b = ring[i];
      const c = ring[(i + 1) % ring.length];
      const dx = c[0] - a[0];
      const dy = c[1] - a[1];
      const len = Math.hypot(dx, dy);
      const d = len > 1e-9 ? Math.abs(dy * (b[0] - a[0]) - dx * (b[1] - a[1])) / len : Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d < 0.6) {
        ring.splice(i, 1);
        i--;
        changed = true;
      }
    }
  }
  const out = [];
  for (const [x, y] of ring) {
    const [la, lo] = proj.toLatLon(x, y);
    const qa = Math.round(la * 1e5);
    const qo = Math.round(lo * 1e5);
    if (out.length && out[out.length - 2] === qa && out[out.length - 1] === qo) continue;
    out.push(qa, qo);
  }
  return out.length >= 6 ? Int32Array.from(out) : null;
}

// Gebäudearten, die als Wohn- bzw. Zustellgebäude zählen (keine Garagen, Schuppen usw.)
const RESIDENTIAL = new Set([
  'yes', 'house', 'residential', 'detached', 'semidetached_house', 'terrace', 'apartments',
  'farm', 'bungalow', 'dormitory', 'commercial', 'retail', 'office', 'farm_auxiliary_house',
]);

/**
 * Erzeugt Adressen aus einer addr:interpolation-Linie. Zwischen je zwei Knoten mit Hausnummer
 * werden die fehlenden Nummern (gerade/ungerade/alle) gleichmäßig verteilt.
 */
export function interpolateWay(w, nodeAddr, coord) {
  const step = w.type === 'all' || w.type === '1' ? 1 : w.type === 'odd' || w.type === 'even' || w.type === '2' ? 2 : 0;
  if (!step) return [];
  const pts = w.refs.map((r) => coord(r));
  if (pts.some((p) => !p)) return [];
  const proj = makeProjection(pts[0][0], pts[0][1]);
  const xy = pts.map(([la, lo]) => proj.toXY(la, lo));
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  const anchors = [];
  w.refs.forEach((r, i) => {
    const a = nodeAddr.get(r);
    const n = a ? parseInt(a.housenumber, 10) : NaN;
    if (a && Number.isFinite(n) && /^\d+$/.test(a.housenumber.trim())) anchors.push({ i, n, a });
  });
  const out = [];
  for (let k = 0; k + 1 < anchors.length; k++) {
    const A = anchors[k];
    const B = anchors[k + 1];
    const lo = Math.min(A.n, B.n);
    const hi = Math.max(A.n, B.n);
    if (hi - lo < 2 || hi - lo > 400 || (step === 2 && (hi - lo) % 2)) continue;
    const street = w.street || A.a.street;
    if (!street || (B.a.street && B.a.street !== street)) continue;
    for (let n = lo + step; n < hi; n += step) {
      const t = (n - A.n) / (B.n - A.n);
      const s = cum[A.i] + t * (cum[B.i] - cum[A.i]);
      let j = 1;
      while (j < cum.length - 1 && cum[j] < s) j++;
      const f = Math.max(0, Math.min(1, (s - cum[j - 1]) / (cum[j] - cum[j - 1] || 1)));
      const [lat, lon] = proj.toLatLon(xy[j - 1][0] + f * (xy[j][0] - xy[j - 1][0]), xy[j - 1][1] + f * (xy[j][1] - xy[j - 1][1]));
      out.push({
        housenumber: String(n),
        street,
        isPlace: A.a.isPlace,
        postcode: A.a.postcode || B.a.postcode,
        city: A.a.city || B.a.city,
        suburb: A.a.suburb,
        lat,
        lon,
        source: 'osm-interp',
      });
    }
  }
  return out;
}

/** Mittelpunkt einer Fläche (Schwerpunkt) bzw. Mitte einer offenen Linie. */
function representativePoint(pts, closed) {
  if (!pts.length) return null;
  if (pts.length === 1) return pts[0];
  const proj = makeProjection(pts[0][0], pts[0][1]);
  const xy = pts.map(([la, lo]) => proj.toXY(la, lo));
  if (closed && pts.length >= 4) {
    const ring = xy.slice(0, -1);
    const [x, y] = polygonCentroid(ring);
    return proj.toLatLon(x, y);
  }
  const { point } = pointAtS(xy, lineLength(xy) / 2);
  return proj.toLatLon(point[0], point[1]);
}
