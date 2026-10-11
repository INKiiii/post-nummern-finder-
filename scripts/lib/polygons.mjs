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
