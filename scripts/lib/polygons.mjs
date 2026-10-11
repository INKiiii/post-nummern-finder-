// Ringe aus OSM-Wegen zusammensetzen und Punkt-in-Polygon-Abfragen mit Raster-Index.

/**
 * Setzt Ringe aus Wegstücken zusammen (über gemeinsame Endknoten).
 * Unvollständige Ringe (z. B. am Rand eines Auszugs) werden künstlich geschlossen.
 * @param {{nodeIds:number[], pts:number[][]}[]} parts
 * @returns {number[][][]} Ringe aus [lat, lon]
 */
export function assembleRings(parts) {
  const unused = new Set(parts.filter((p) => p.pts.length >= 2).map((_, i) => i));
  const valid = parts.filter((p) => p.pts.length >= 2);
  const byEnd = new Map();
  const addEnd = (id, i) => {
    const l = byEnd.get(id);
    l ? l.push(i) : byEnd.set(id, [i]);
  };
  valid.forEach((p, i) => {
    addEnd(p.nodeIds[0], i);
    addEnd(p.nodeIds[p.nodeIds.length - 1], i);
  });
  const rings = [];
  for (const start of [...unused]) {
    if (!unused.has(start)) continue;
    unused.delete(start);
    const ids = [...valid[start].nodeIds];
    const pts = [...valid[start].pts];
    let guard = 0;
    while (ids[0] !== ids[ids.length - 1] && guard++ < 100000) {
      const end = ids[ids.length - 1];
      const next = (byEnd.get(end) ?? []).find((i) => unused.has(i));
      if (next === undefined) break;
      unused.delete(next);
      const p = valid[next];
      if (p.nodeIds[0] === end) {
        ids.push(...p.nodeIds.slice(1));
        pts.push(...p.pts.slice(1));
      } else {
        ids.push(...[...p.nodeIds].reverse().slice(1));
        pts.push(...[...p.pts].reverse().slice(1));
      }
    }
    if (pts.length >= 3) rings.push(pts);
  }
  return rings;
}

export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][1] + ring[i][1]) * (ring[j][0] - ring[i][0]);
  }
  return Math.abs(a / 2);
}

/** Gerade-Ungerade-Regel über alle Ringe (äußere und innere). */
export function ringsContain(rings, lat, lon) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i];
      const [yj, xj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function bboxOf(rings) {
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const r of rings)
    for (const [la, lo] of r) {
      if (la < minLat) minLat = la;
      if (la > maxLat) maxLat = la;
      if (lo < minLon) minLon = lo;
      if (lo > maxLon) maxLon = lo;
    }
  return [minLat, minLon, maxLat, maxLon];
}

/** Raster-Index für schnelle Punkt-in-Fläche-Abfragen. */
export class AreaIndex {
  /** @param {{key:string, name?:string, rings:number[][][]}[]} areas */
  constructor(areas, cell = 0.05) {
    this.cell = cell;
    this.grid = new Map();
    this.areas = areas.filter((a) => a.rings.length).map((a) => ({ ...a, bbox: bboxOf(a.rings) }));
    for (const a of this.areas) {
      const [y0, x0, y1, x1] = a.bbox;
      for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++)
        for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) {
          const k = gy * 100000 + gx;
          const l = this.grid.get(k);
          l ? l.push(a) : this.grid.set(k, [a]);
        }
    }
  }
  get size() {
    return this.areas.length;
  }
  find(lat, lon) {
    const k = Math.floor(lat / this.cell) * 100000 + Math.floor(lon / this.cell);
    for (const a of this.grid.get(k) ?? []) {
      const [y0, x0, y1, x1] = a.bbox;
      if (lat < y0 || lat > y1 || lon < x0 || lon > x1) continue;
      if (ringsContain(a.rings, lat, lon)) return a;
    }
    return null;
  }
}

/** Raster für Nächster-Nachbar-Suche über Punkte. */
export class PointGrid {
  constructor(cell = 0.01) {
    this.cell = cell;
    this.grid = new Map();
  }
  add(lat, lon, item) {
    const k = Math.floor(lat / this.cell) * 100000 + Math.floor(lon / this.cell);
    const l = this.grid.get(k);
    l ? l.push([lat, lon, item]) : this.grid.set(k, [[lat, lon, item]]);
  }
  nearest(lat, lon, maxRings = 5) {
    const gy = Math.floor(lat / this.cell);
    const gx = Math.floor(lon / this.cell);
    const kx = Math.cos((lat * Math.PI) / 180);
    let best = null;
    let bestD = Infinity;
    for (let r = 0; r <= maxRings; r++) {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dy), Math.abs(dx)) !== r) continue;
          for (const [la, lo, item] of this.grid.get((gy + dy) * 100000 + gx + dx) ?? []) {
            const d = (la - lat) ** 2 + ((lo - lon) * kx) ** 2;
            if (d < bestD) {
              bestD = d;
              best = item;
            }
          }
        }
      if (best && r >= 1) break;
    }
    return best;
  }
}

/** Alle Einträge im Umkreis (Meter), nach Abstand sortiert. */
PointGrid.prototype.within = function (lat, lon, radiusM) {
  const kx = Math.cos((lat * Math.PI) / 180);
  const r = Math.ceil(radiusM / 111320 / this.cell) + 1;
  const gy = Math.floor(lat / this.cell);
  const gx = Math.floor(lon / this.cell);
  const out = [];
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++)
      for (const [la, lo, item] of this.grid.get((gy + dy) * 100000 + gx + dx) ?? []) {
        const d = Math.hypot((la - lat) * 111320, (lo - lon) * 111320 * kx);
        if (d <= radiusM) out.push({ item, d });
      }
  return out.sort((a, b) => a.d - b.d);
};

/** Raster über Liniensegmente für "nächster Punkt auf einer Straße". */
export class SegmentGrid {
  constructor(cell = 0.002) {
    this.cell = cell;
    this.grid = new Map();
  }
  addLine(pts, item) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const y0 = Math.floor(Math.min(a[0], b[0]) / this.cell);
      const y1 = Math.floor(Math.max(a[0], b[0]) / this.cell);
      const x0 = Math.floor(Math.min(a[1], b[1]) / this.cell);
      const x1 = Math.floor(Math.max(a[1], b[1]) / this.cell);
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const k = y * 100000 + x;
          const l = this.grid.get(k);
          l ? l.push([a, b, item]) : this.grid.set(k, [[a, b, item]]);
        }
    }
  }
  /** Nächster Punkt auf einer Linie im Umkreis von maxM Metern oder null. */
  nearest(lat, lon, maxM = 50) {
    const kx = 111320 * Math.cos((lat * Math.PI) / 180);
    const ky = 111320;
    const r = Math.ceil(maxM / 111320 / this.cell) + 1;
    const gy = Math.floor(lat / this.cell);
    const gx = Math.floor(lon / this.cell);
    let best = null;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        for (const [a, b, item] of this.grid.get((gy + dy) * 100000 + gx + dx) ?? []) {
          const ax = (a[1] - lon) * kx;
          const ay = (a[0] - lat) * ky;
          const bx = (b[1] - lon) * kx;
          const by = (b[0] - lat) * ky;
          const vx = bx - ax;
          const vy = by - ay;
          const l2 = vx * vx + vy * vy;
          const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / l2)) : 0;
          const px = ax + t * vx;
          const py = ay + t * vy;
          const d = Math.hypot(px, py);
          if (d <= maxM && (!best || d < best.d)) best = { d, point: [lat + py / ky, lon + px / kx], item };
        }
    return best;
  }
}
