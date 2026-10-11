// Minimaler, abhängigkeitsfreier Leser für OSM-PBF-Dateien (Geofabrik-Auszüge).
// Liest Blobs über Positions-Reads, sodass spätere Durchläufe nur die
// benötigten Blöcke erneut dekomprimieren müssen.

import fs from 'node:fs';
import zlib from 'node:zlib';

/** Protobuf-Leser über einem Uint8Array. */
export class Proto {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }
  eof() {
    return this.pos >= this.end;
  }
  varint() {
    const b = this.buf;
    let x = b[this.pos++];
    if (x < 0x80) return x;
    x &= 0x7f;
    let shift = 7;
    let byte;
    // Bis 2^28 mit Bitoperationen, danach per Multiplikation (sicher bis 2^53).
    do {
      byte = b[this.pos++];
      if (shift < 28) x |= (byte & 0x7f) << shift;
      else x += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte >= 0x80);
    return x;
  }
  svarint() {
    const n = this.varint();
    return n % 2 === 1 ? -(n + 1) / 2 : n / 2;
  }
  bytes() {
    const len = this.varint();
    const start = this.pos;
    this.pos += len;
    return this.buf.subarray(start, start + len);
  }
  /** Liefert [start, end) eines längenbegrenzten Feldes. */
  span() {
    const len = this.varint();
    const start = this.pos;
    this.pos += len;
    return [start, start + len];
  }
  string() {
    return Buffer.from(this.bytes()).toString('utf8');
  }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) {
      const len = this.varint();
      this.pos += len;
    }
    else if (wire === 5) this.pos += 4;
    else throw new Error('Unbekannter Wire-Typ ' + wire);
  }
  /** Iteriert über gepackte Varints (unsigned). */
  packed(fn) {
    const [s, e] = this.span();
    const p = new Proto(this.buf, s, e);
    while (!p.eof()) fn(p.varint());
  }
  packedArray(signed = false) {
    const [s, e] = this.span();
    const p = new Proto(this.buf, s, e);
    const out = [];
    while (!p.eof()) out.push(signed ? p.svarint() : p.varint());
    return out;
  }
}

/**
 * Liest den Blob-Index einer PBF-Datei: Position und Größe jedes OSMData-Blobs.
 * Liest nur Header, keine Daten.
 */
export function* iterateBlobs(fd) {
  const lenBuf = Buffer.alloc(4);
  let offset = 0;
  for (;;) {
    const n = fs.readSync(fd, lenBuf, 0, 4, offset);
    if (n < 4) return;
    const headerLen = lenBuf.readUInt32BE(0);
    const headerBuf = Buffer.alloc(headerLen);
    fs.readSync(fd, headerBuf, 0, headerLen, offset + 4);
    const h = new Proto(headerBuf);
    let type = '';
    let datasize = 0;
    while (!h.eof()) {
      const key = h.varint();
      const field = key >> 3;
      if (field === 1) type = h.string();
      else if (field === 3) datasize = h.varint();
      else h.skip(key & 7);
    }
    yield { type, offset: offset + 4 + headerLen, size: datasize };
    offset += 4 + headerLen + datasize;
  }
}

export function readBlob(fd, blob) {
  const buf = Buffer.alloc(blob.size);
  fs.readSync(fd, buf, 0, blob.size, blob.offset);
  const p = new Proto(buf);
  let raw = null;
  let zdata = null;
  while (!p.eof()) {
    const key = p.varint();
    const field = key >> 3;
    if (field === 1) raw = p.bytes();
    else if (field === 3) zdata = p.bytes();
    else if (field === 4 || field === 5 || field === 6 || field === 7) {
      throw new Error('Nicht unterstützte Blob-Kompression (nur zlib/raw)');
    } else p.skip(key & 7);
  }
  if (raw) return raw;
  if (zdata) return zlib.inflateSync(zdata);
  return new Uint8Array(0);
}

/** Liest den OSMHeader (Datum des Datenstands, benötigte Features). */
export function readHeader(data) {
  const p = new Proto(data);
  const out = { required: [], replicationTimestamp: null };
  while (!p.eof()) {
    const key = p.varint();
    const field = key >> 3;
    if (field === 4) out.required.push(p.string());
    else if (field === 32) out.replicationTimestamp = p.varint();
    else p.skip(key & 7);
  }
  return out;
}

/**
 * Zerlegt einen PrimitiveBlock grob: Stringtabelle, Granularität, Gruppen-Spannen.
 * Die eigentliche Dekodierung erfolgt über die Callback-Funktionen, damit jeder
 * Durchlauf nur das liest, was er braucht.
 */
export function parseBlock(data) {
  const p = new Proto(data);
  const block = {
    data,
    strings: [],
    granularity: 100,
    latOffset: 0,
    lonOffset: 0,
    groups: [],
  };
  while (!p.eof()) {
    const key = p.varint();
    const field = key >> 3;
    if (field === 1) {
      const [s, e] = p.span();
      const st = new Proto(data, s, e);
      while (!st.eof()) {
        const k = st.varint();
        if (k >> 3 === 1) block.strings.push(Buffer.from(st.bytes()).toString('utf8'));
        else st.skip(k & 7);
      }
    } else if (field === 2) block.groups.push(p.span());
    else if (field === 17) block.granularity = p.varint();
    else if (field === 19) block.latOffset = p.varint();
    else if (field === 20) block.lonOffset = p.varint();
    else p.skip(key & 7);
  }
  return block;
}

/** Welche Elementarten enthält der Block? (bits: 1=nodes, 2=ways, 4=relations) */
export function blockKinds(block) {
  let kinds = 0;
  for (const [s, e] of block.groups) {
    const p = new Proto(block.data, s, e);
    while (!p.eof()) {
      const key = p.varint();
      const field = key >> 3;
      if (field === 1 || field === 2) kinds |= 1;
      else if (field === 3) kinds |= 2;
      else if (field === 4) kinds |= 4;
      p.skip(key & 7);
    }
  }
  return kinds;
}

function tagsFromKV(strings, keys, vals) {
  const tags = {};
  for (let i = 0; i < keys.length; i++) tags[strings[keys[i]]] = strings[vals[i]];
  return tags;
}

/**
 * Dekodiert Knoten. Mit withTags=false werden Tags übersprungen (schneller).
 * cb(id, lat, lon, tags|null)
 */
export function eachNode(block, withTags, cb) {
  const { data, strings, granularity: g, latOffset, lonOffset } = block;
  const toLat = (v) => 1e-9 * (latOffset + g * v);
  const toLon = (v) => 1e-9 * (lonOffset + g * v);
  for (const [s, e] of block.groups) {
    const p = new Proto(data, s, e);
    while (!p.eof()) {
      const key = p.varint();
      const field = key >> 3;
      if (field === 2) {
        const [ds, de] = p.span();
        const d = new Proto(data, ds, de);
        let ids = null;
        let lats = null;
        let lons = null;
        let kv = null;
        while (!d.eof()) {
          const k = d.varint();
          const f = k >> 3;
          if (f === 1) ids = d.packedArray(true);
          else if (f === 8) lats = d.packedArray(true);
          else if (f === 9) lons = d.packedArray(true);
          else if (f === 10 && withTags) kv = d.packedArray(false);
          else d.skip(k & 7);
        }
        if (!ids) continue;
        let id = 0;
        let lat = 0;
        let lon = 0;
        let kvPos = 0;
        for (let i = 0; i < ids.length; i++) {
          id += ids[i];
          lat += lats[i];
          lon += lons[i];
          let tags = null;
          if (kv) {
            if (kv[kvPos] !== 0) {
              tags = {};
              while (kvPos < kv.length && kv[kvPos] !== 0) {
                tags[strings[kv[kvPos]]] = strings[kv[kvPos + 1]];
                kvPos += 2;
              }
            }
            kvPos++;
          }
          cb(id, toLat(lat), toLon(lon), tags);
        }
      } else if (field === 1) {
        const [ns, ne] = p.span();
        const n = new Proto(data, ns, ne);
        let id = 0;
        let lat = 0;
        let lon = 0;
        let keys = [];
        let vals = [];
        while (!n.eof()) {
          const k = n.varint();
          const f = k >> 3;
          if (f === 1) id = n.svarint();
          else if (f === 2) keys = n.packedArray();
          else if (f === 3) vals = n.packedArray();
          else if (f === 8) lat = n.svarint();
          else if (f === 9) lon = n.svarint();
          else n.skip(k & 7);
        }
        cb(id, toLat(lat), toLon(lon), withTags && keys.length ? tagsFromKV(strings, keys, vals) : null);
      } else p.skip(key & 7);
    }
  }
}

/** cb(id, tags, refs:number[]) */
export function eachWay(block, cb) {
  const { data, strings } = block;
  for (const [s, e] of block.groups) {
    const p = new Proto(data, s, e);
    while (!p.eof()) {
      const key = p.varint();
      if (key >> 3 !== 3) {
        p.skip(key & 7);
        continue;
      }
      const [ws, we] = p.span();
      const w = new Proto(data, ws, we);
      let id = 0;
      let keys = [];
      let vals = [];
      let refsSpan = null;
      while (!w.eof()) {
        const k = w.varint();
        const f = k >> 3;
        if (f === 1) id = w.varint();
        else if (f === 2) keys = w.packedArray();
        else if (f === 3) vals = w.packedArray();
        else if (f === 8) refsSpan = w.span();
        else w.skip(k & 7);
      }
      const tags = tagsFromKV(strings, keys, vals);
      // Referenzen werden nur auf Anfrage dekodiert (lazy), das spart Zeit.
      const getRefs = () => {
        if (!refsSpan) return [];
        const r = new Proto(data, refsSpan[0], refsSpan[1]);
        const out = [];
        let ref = 0;
        while (!r.eof()) {
          ref += r.svarint();
          out.push(ref);
        }
        return out;
      };
      cb(id, tags, getRefs);
    }
  }
}

/** cb(id, tags, members:[{type:'node'|'way'|'relation', ref, role}]) */
export function eachRelation(block, cb) {
  const { data, strings } = block;
  const TYPES = ['node', 'way', 'relation'];
  for (const [s, e] of block.groups) {
    const p = new Proto(data, s, e);
    while (!p.eof()) {
      const key = p.varint();
      if (key >> 3 !== 4) {
        p.skip(key & 7);
        continue;
      }
      const [rs, re] = p.span();
      const r = new Proto(data, rs, re);
      let id = 0;
      let keys = [];
      let vals = [];
      let roles = [];
      let memids = [];
      let types = [];
      while (!r.eof()) {
        const k = r.varint();
        const f = k >> 3;
        if (f === 1) id = r.varint();
        else if (f === 2) keys = r.packedArray();
        else if (f === 3) vals = r.packedArray();
        else if (f === 8) roles = r.packedArray();
        else if (f === 9) memids = r.packedArray(true);
        else if (f === 10) types = r.packedArray();
        else r.skip(k & 7);
      }
      const tags = tagsFromKV(strings, keys, vals);
      const getMembers = () => {
        const out = [];
        let ref = 0;
        for (let i = 0; i < memids.length; i++) {
          ref += memids[i];
          out.push({ type: TYPES[types[i]] ?? 'node', ref, role: strings[roles[i]] ?? '' });
        }
        return out;
      };
      cb(id, tags, getMembers);
    }
  }
}
