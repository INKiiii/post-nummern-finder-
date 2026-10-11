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
  const segments = []; // {id, name, highway, refs}
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
        if (a) addrWays.push({ id, addr: a, refs: getRefs() });
        const hw = tags.highway;
        if (hw && tags.name && HIGHWAYS.has(hw === 'construction' ? 'construction' : hw) && tags.area !== 'yes') {
          segments.push({ id, name: tags.name, highway: hw, refs: getRefs() });
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
  log(`Durchlauf A fertig (${((Date.now() - t0) / 1000).toFixed(0)} s): ${addrNodes.length} Adressknoten, ${addrWays.length} Adresswege, ${addrRels.length} Adressrelationen, ${segments.length} Straßenstücke, ${areaRels.length} Grenzen`);

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
  for (const s of segments) need.pushAll(s.refs);
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
    addresses: addresses.map((a) => ({ ...a, source: 'osm' })),
    streetSegments,
    areas,
  };
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
