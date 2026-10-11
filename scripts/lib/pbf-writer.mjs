// Einfacher OSM-PBF-Schreiber für Testdaten und Demo-Gebiete.
// Erzeugt gültige Dateien (DenseNodes, Ways, Relations, zlib-komprimiert).

import zlib from 'node:zlib';

class Writer {
  constructor() {
    this.bytes = [];
  }
  varint(n) {
    if (n < 0) throw new Error('negativer varint');
    while (n >= 0x80) {
      this.bytes.push((n % 0x80) | 0x80);
      n = Math.floor(n / 0x80);
    }
    this.bytes.push(n);
    return this;
  }
  svarint(n) {
    return this.varint(n >= 0 ? n * 2 : -n * 2 - 1);
  }
  key(field, wire) {
    return this.varint(field * 8 + wire);
  }
  uint(field, n) {
    return this.key(field, 0).varint(n);
  }
  sint(field, n) {
    return this.key(field, 0).svarint(n);
  }
  bytesField(field, buf) {
    this.key(field, 2).varint(buf.length);
    for (const b of buf) this.bytes.push(b);
    return this;
  }
  string(field, s) {
    return this.bytesField(field, Buffer.from(s, 'utf8'));
  }
  packed(field, arr, signed = false) {
    const w = new Writer();
    for (const v of arr) signed ? w.svarint(v) : w.varint(v);
    return this.bytesField(field, w.out());
  }
  out() {
    return Uint8Array.from(this.bytes);
  }
}

function frame(type, payload) {
  const blob = new Writer();
  blob.uint(2, payload.length);
  blob.bytesField(3, zlib.deflateSync(payload));
  const blobBytes = blob.out();
  const header = new Writer();
  header.string(1, type);
  header.uint(3, blobBytes.length);
  const headerBytes = header.out();
  const len = Buffer.alloc(4);
  len.writeUInt32BE(headerBytes.length);
  return Buffer.concat([len, Buffer.from(headerBytes), Buffer.from(blobBytes)]);
}

/**
 * @param {{nodes:{id:number,lat:number,lon:number,tags?:object}[],
 *          ways:{id:number,refs:number[],tags?:object}[],
 *          relations?:{id:number,members:{type:string,ref:number,role?:string}[],tags?:object}[]}} data
 * @param {{blockSize?:number}} [opts]
 */
export function writePbf(data, opts = {}) {
  const blockSize = opts.blockSize ?? 8000;
  const parts = [];
  const header = new Writer();
  header.string(4, 'OsmSchema-V0.6');
  header.string(4, 'DenseNodes');
  header.uint(32, Math.floor(Date.UTC(2026, 0, 1) / 1000));
  parts.push(frame('OSMHeader', header.out()));

  const nodes = [...data.nodes].sort((a, b) => a.id - b.id);
  const ways = [...data.ways].sort((a, b) => a.id - b.id);
  const rels = [...(data.relations ?? [])].sort((a, b) => a.id - b.id);

  const chunks = (arr) => {
    const out = [];
    for (let i = 0; i < arr.length; i += blockSize) out.push(arr.slice(i, i + blockSize));
    return out;
  };

  const makeBlock = (groupFn) => {
    const strings = [''];
    const index = new Map([['', 0]]);
    const sid = (s) => {
      s = String(s);
      let i = index.get(s);
      if (i === undefined) {
        i = strings.length;
        strings.push(s);
        index.set(s, i);
      }
      return i;
    };
    const group = groupFn(sid);
    const st = new Writer();
    for (const s of strings) st.string(1, s);
    const block = new Writer();
    block.bytesField(1, st.out());
    block.bytesField(2, group);
    return frame('OSMData', block.out());
  };

  for (const chunk of chunks(nodes)) {
    parts.push(
      makeBlock((sid) => {
        let pid = 0;
        let plat = 0;
        let plon = 0;
        const ids = [];
        const lats = [];
        const lons = [];
        const kv = [];
        for (const n of chunk) {
          const lat = Math.round(n.lat * 1e7);
          const lon = Math.round(n.lon * 1e7);
          ids.push(n.id - pid);
          lats.push(lat - plat);
          lons.push(lon - plon);
          pid = n.id;
          plat = lat;
          plon = lon;
          for (const [k, v] of Object.entries(n.tags ?? {})) kv.push(sid(k), sid(v));
          kv.push(0);
        }
        const dense = new Writer();
        dense.packed(1, ids, true);
        dense.packed(8, lats, true);
        dense.packed(9, lons, true);
        dense.packed(10, kv);
        const g = new Writer();
        g.bytesField(2, dense.out());
        return g.out();
      }),
    );
  }
  for (const chunk of chunks(ways)) {
    parts.push(
      makeBlock((sid) => {
        const g = new Writer();
        for (const w of chunk) {
          const ww = new Writer();
          ww.uint(1, w.id);
          const entries = Object.entries(w.tags ?? {});
          ww.packed(2, entries.map(([k]) => sid(k)));
          ww.packed(3, entries.map(([, v]) => sid(v)));
          let prev = 0;
          ww.packed(
            8,
            w.refs.map((r) => {
              const d = r - prev;
              prev = r;
              return d;
            }),
            true,
          );
          g.bytesField(3, ww.out());
        }
        return g.out();
      }),
    );
  }
  for (const chunk of chunks(rels)) {
    parts.push(
      makeBlock((sid) => {
        const g = new Writer();
        const TYPES = { node: 0, way: 1, relation: 2 };
        for (const r of chunk) {
          const rw = new Writer();
          rw.uint(1, r.id);
          const entries = Object.entries(r.tags ?? {});
          rw.packed(2, entries.map(([k]) => sid(k)));
          rw.packed(3, entries.map(([, v]) => sid(v)));
          rw.packed(8, r.members.map((m) => sid(m.role ?? '')));
          let prev = 0;
          rw.packed(
            9,
            r.members.map((m) => {
              const d = m.ref - prev;
              prev = m.ref;
              return d;
            }),
            true,
          );
          rw.packed(10, r.members.map((m) => TYPES[m.type]));
          g.bytesField(4, rw.out());
        }
        return g.out();
      }),
    );
  }
  return Buffer.concat(parts);
}
