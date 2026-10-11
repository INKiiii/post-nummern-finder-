// Geometrie-Helfer: lokale Projektion in Metern, Abstände, Projektion auf Linien.

const R = 6371008.8;
const RAD = Math.PI / 180;

export function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Kurs von 1 nach 2 in Grad (0 = Nord, 90 = Ost). */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x =
    Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) -
    Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Winkel auf (-180, 180] normieren. */
export function wrap180(a) {
  a = ((a + 180) % 360 + 360) % 360 - 180;
  return a === -180 ? 180 : a;
}

/** Lokale ebene Projektion (x = Ost, y = Nord) in Metern um einen Ursprung. */
export function makeProjection(lat0, lon0) {
  const kx = R * RAD * Math.cos(lat0 * RAD);
  const ky = R * RAD;
  return {
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLatLon: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

/**
 * Projiziert Punkt p auf eine Polylinie (Punkte in Metern).
 * @returns {{s:number, dist:number, seg:number, t:number, point:number[], tangent:number[], cross:number}}
 *   s = Bogenlänge bis zum Fußpunkt, cross > 0: Punkt links der Linienrichtung.
 */
export function projectOnLine(p, line) {
  let best = null;
  let acc = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const len = Math.sqrt(len2);
    let t = len2 > 0 ? ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    const dist = Math.hypot(p[0] - qx, p[1] - qy);
    if (!best || dist < best.dist) {
      const tangent = len > 0 ? [dx / len, dy / len] : [1, 0];
      best = {
        s: acc + t * len,
        dist,
        seg: i,
        t,
        point: [qx, qy],
        tangent,
        cross: tangent[0] * (p[1] - qy) - tangent[1] * (p[0] - qx),
      };
    }
    acc += len;
  }
  if (!best && line.length === 1) {
    const [ax, ay] = line[0];
    best = { s: 0, dist: Math.hypot(p[0] - ax, p[1] - ay), seg: 0, t: 0, point: [ax, ay], tangent: [1, 0], cross: 0 };
  }
  return best;
}

export function lineLength(line) {
  let l = 0;
  for (let i = 0; i < line.length - 1; i++) l += Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
  return l;
}

/** Punkt und Tangente bei Bogenlänge s (geklemmt). */
export function pointAtS(line, s) {
  let acc = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (acc + len >= s || i === line.length - 2) {
      const t = len > 0 ? Math.max(0, Math.min(1, (s - acc) / len)) : 0;
      const tangent = len > 0 ? [(bx - ax) / len, (by - ay) / len] : [1, 0];
      return { point: [ax + t * (bx - ax), ay + t * (by - ay)], tangent };
    }
    acc += len;
  }
  return { point: line[0], tangent: [1, 0] };
}

/** Flächenschwerpunkt eines Polygons (Punkte [x,y]); Fallback Mittelwert. */
export function polygonCentroid(pts) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-12) {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of pts) {
      sx += x;
      sy += y;
    }
    return [sx / n, sy / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}
