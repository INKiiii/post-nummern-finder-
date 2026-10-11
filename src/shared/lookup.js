// Kernlogik für Suche und Hausnummern-Lage. Wird von der App und von
// scripts/sample-test.mjs gemeinsam genutzt.

import { foldText, normStreet, editDistance } from './normalize.js';
import { parseHouseNumber, normHouseNumber } from './housenumber.js';
import { makeProjection, projectOnLine, pointAtS, lineLength } from './geo.js';

export const PACKAGE_FORMAT = 'hnf-region';
export const PACKAGE_VERSION = 1;

/** Dekodiert eine Linie [lat0, lon0, dlat, dlon, ...] (1e-6 Grad) zu [[lat,lon],...]. */
export function decodeLine(enc) {
  const out = [];
  let lat = 0;
  let lon = 0;
  for (let i = 0; i < enc.length; i += 2) {
    lat += enc[i];
    lon += enc[i + 1];
    out.push([lat / 1e6, lon / 1e6]);
  }
  return out;
}

export function encodeLine(pts) {
  const out = [];
  let plat = 0;
  let plon = 0;
  for (const [la, lo] of pts) {
    const lat = Math.round(la * 1e6);
    const lon = Math.round(lo * 1e6);
    out.push(lat - plat, lon - plon);
    plat = lat;
    plon = lon;
  }
  return out;
}

/**
 * Gebäudeumrisse: je Umriss [dLat, dLon, ...] in 1e-5 Grad. Der erste Punkt ist relativ zum
 * ersten Punkt des vorigen Umrisses, die übrigen relativ zum vorigen Punkt.
 * @param {ArrayLike<number>[]} polys absolute Ganzzahlen [lat, lon, ...] (1e-5 Grad)
 */
export function encodeOutlines(polys) {
  const sorted = [...polys].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let plat = 0;
  let plon = 0;
  return sorted.map((p) => {
    const out = [];
    let la = plat;
    let lo = plon;
    for (let i = 0; i < p.length; i += 2) {
      out.push(p[i] - la, p[i + 1] - lo);
      la = p[i];
      lo = p[i + 1];
    }
    plat = p[0];
    plon = p[1];
    return out;
  });
}

/** @returns {number[][][]} Umrisse als [[lat, lon], ...] */
export function decodeOutlines(enc) {
  let plat = 0;
  let plon = 0;
  return enc.map((d) => {
    const pts = [];
    let la = plat;
    let lo = plon;
    for (let i = 0; i < d.length; i += 2) {
      la += d[i];
      lo += d[i + 1];
      if (i === 0) {
        plat = la;
        plon = lo;
      }
      pts.push([la / 1e5, lo / 1e5]);
    }
    return pts;
  });
}

function makeNumber(label, lat, lon, extra = {}) {
  const p = parseHouseNumber(label);
  return { label: p.label, norm: p.norm, num: p.num, suffix: p.suffix, to: p.to, lat, lon, ...extra };
}

/** Wandelt eine Paket-Straße in die Laufzeitstruktur um. */
export function decodeStreet(s, pkg) {
  const lines = (s.l ?? []).map(decodeLine);
  const numbers = (s.h ?? []).map(([label, lat, lon, src, plz]) =>
    makeNumber(label, lat / 1e6, lon / 1e6, {
      source: pkg?.sources?.[src ?? 0]?.id ?? 'osm',
      plz: plz ?? pkg?.plz ?? '',
    }),
  );
  const driveways = (s.d ?? []).map(([labels, enc]) => ({
    norms: labels.map(normHouseNumber),
    line: decodeLine(enc),
    user: false,
  }));
  return {
    id: s.id,
    name: s.n,
    place: s.p ?? '',
    plz: s.z ?? pkg?.plz ?? '',
    driveways,
    buildings: s.b ? decodeLine(s.b) : [],
    outlines: s.o ? decodeOutlines(s.o) : [],
    norm: normStreet(s.n),
    fold: foldText(s.n),
    lines,
    numbers,
    q: s.q ?? null,
    regions: new Set(pkg ? [pkg.id] : []),
    user: false,
    bbox: computeBBox(lines, numbers),
  };
}

export function computeBBox(lines, numbers) {
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  const add = (lat, lon) => {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  };
  for (const l of lines) for (const [lat, lon] of l) add(lat, lon);
  for (const n of numbers) add(n.lat, n.lon);
  return minLat === Infinity ? null : [minLat, minLon, maxLat, maxLon];
}

/**
 * Baut den Suchindex aus geladenen Paketen und eigenen Daten.
 * @param {object[]} packages Pakete im Dateiformat
 * @param {{points?:object[], streets?:object[]}} [user] eigene Punkte/Straßen
 */
export function buildIndex(packages, user = {}) {
  const streets = new Map();
  for (const pkg of packages) {
    for (const s of pkg.streets) {
      const existing = streets.get(s.id);
      if (existing) {
        // Straße liegt in mehreren Gebieten: Hausnummern zusammenführen.
        existing.regions.add(pkg.id);
        const have = new Set(existing.numbers.map((n) => n.norm));
        for (const n of decodeStreet(s, pkg).numbers) if (!have.has(n.norm)) existing.numbers.push(n);
      } else streets.set(s.id, decodeStreet(s, pkg));
    }
  }
  const index = { streets, byNorm: new Map() };
  for (const us of user.streets ?? []) addUserStreet(index, us);
  for (const pt of user.points ?? []) addUserPoint(index, pt);
  reindex(index);
  return index;
}

function reindex(index) {
  index.byNorm = new Map();
  for (const s of index.streets.values()) {
    const list = index.byNorm.get(s.norm);
    if (list) list.push(s);
    else index.byNorm.set(s.norm, [s]);
  }
}

/** Eigene Straße (nachgezeichnet oder nur Name + Startpunkt). */
export function addUserStreet(index, us) {
  const id = 'u:' + us.id;
  const lines = us.line && us.line.length >= 2 ? [us.line] : [];
  const numbers = [];
  const street = {
    id,
    name: us.name,
    place: us.place ?? '',
    plz: us.plz ?? '',
    norm: normStreet(us.name),
    fold: foldText(us.name),
    lines,
    numbers,
    driveways: [],
    buildings: [],
    outlines: [],
    q: null,
    regions: new Set(),
    user: true,
    start: us.start ?? (us.line?.[0] ?? null),
    bbox: null,
  };
  street.bbox = computeBBox(lines, []) ?? (street.start ? [street.start[0], street.start[1], street.start[0], street.start[1]] : null);
  index.streets.set(id, street);
  if (index.byNorm) {
    const l = index.byNorm.get(street.norm);
    l ? l.push(street) : index.byNorm.set(street.norm, [street]);
  }
  return street;
}

/** Eigener Hausnummern-Punkt. Wird wie Originaldaten behandelt, aber markiert. */
export function addUserPoint(index, pt) {
  let street = pt.streetId ? index.streets.get(pt.streetId) : null;
  if (!street) {
    // Straße per Name suchen (z. B. nach Datenaktualisierung mit neuer ID).
    const cands = index.byNorm?.get(normStreet(pt.streetName)) ?? [];
    street = nearestStreet(cands, pt.lat, pt.lon);
  }
  if (!street) {
    street = addUserStreet(index, { id: 'p:' + normStreet(pt.streetName), name: pt.streetName, plz: pt.plz, start: [pt.lat, pt.lon] });
  }
  if (pt.kind === 'driveway') {
    // Eigene Einfahrt: Abzweigung von der Straße zu dieser Hausnummer
    const norm = normHouseNumber(pt.number);
    street.driveways = street.driveways.filter((d) => !(d.user && d.norms.includes(norm)));
    street.driveways.unshift({ norms: [norm], line: [[pt.lat, pt.lon]], user: true, pointId: pt.id });
    return street;
  }
  const n = makeNumber(pt.number, pt.lat, pt.lon, { source: 'user', plz: pt.plz ?? street.plz, user: true, pointId: pt.id });
  // Eigener Punkt ersetzt einen gleichnamigen Originalpunkt nicht, sondern ergänzt ihn,
  // wenn die Nummer fehlt. Existiert sie bereits als eigener Punkt, wird aktualisiert.
  const i = street.numbers.findIndex((x) => x.norm === n.norm && x.user);
  if (i >= 0) street.numbers[i] = n;
  else street.numbers.push(n);
  street.bbox = computeBBox(street.lines, street.numbers);
  return street;
}

function nearestStreet(cands, lat, lon) {
  if (!cands.length) return null;
  if (cands.length === 1 || lat === undefined) return cands[0];
  let best = null;
  let bestD = Infinity;
  for (const s of cands) {
    if (!s.bbox) continue;
    const cLat = (s.bbox[0] + s.bbox[2]) / 2;
    const cLon = (s.bbox[1] + s.bbox[3]) / 2;
    const d = (cLat - lat) ** 2 + ((cLon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best ?? cands[0];
}

/**
 * Straßensuche mit Autovervollständigung.
 * Rangfolge: exakter Anfang > Wortanfang > enthalten > Tippfehler-tolerant.
 */
export function searchStreets(index, query, limit = 8) {
  const q = foldText(query);
  const qn = q.replace(/\s+/g, '');
  if (!qn) return [];
  const scored = [];
  for (const s of index.streets.values()) {
    let score = -1;
    if (s.norm === qn) score = 100;
    else if (s.norm.startsWith(qn)) score = 80 - Math.min(20, s.norm.length - qn.length) / 2;
    else if (s.fold.split(' ').some((w) => w.startsWith(q))) score = 60;
    else if (s.norm.includes(qn)) score = 40;
    else if (qn.length >= 4) {
      const d = editDistance(qn, s.norm.slice(0, qn.length + 1), 2);
      const d2 = editDistance(qn, s.norm, 2);
      const dm = Math.min(d, d2);
      if (dm <= (qn.length >= 7 ? 2 : 1)) score = 30 - dm * 5;
    }
    if (score >= 0) scored.push({ s, score: score + Math.min(5, s.numbers.length / 50) });
  }
  scored.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name, 'de'));
  return scored.slice(0, limit).map((x) => x.s);
}

/** Bester Treffer für einen (gesprochenen) Straßennamen oder null. */
export function bestStreetMatch(index, spoken) {
  const res = searchStreets(index, spoken, 3);
  if (!res.length) return null;
  return res[0];
}

/**
 * Sucht die Lage einer Hausnummer auf einer Straße.
 * @returns {{status:'exact'|'range'|'base'|'interpolated'|'extrapolated'|'single'|'street'|'none',
 *   lat:number, lon:number, estimated:boolean, match?:object, neighbors:object[]}}
 */
export function findHouse(street, input, near = null) {
  const p = parseHouseNumber(input);
  const nums = street.numbers;
  // Eigene Punkte haben Vorrang (z. B. Korrektur einer falsch eingetragenen Nummer)
  const same = (n) => n.norm === p.norm || (p.num !== null && n.num === p.num && n.suffix === p.suffix);
  const users = nums.filter((n) => n.user && same(n));
  const exactNorm = nums.filter((n) => n.norm === p.norm);
  const pool = users.length ? users : exactNorm.length ? exactNorm : nums.filter(same);
  // Sicherheitsnetz: dieselbe Nummer mehrfach weit auseinander (z. B. zwei Gemeinden mit
  // eigener Nummernfolge) -> die nächstgelegene nehmen und das melden.
  let exact = pool[0];
  let ambiguous = false;
  if (pool.length > 1) {
    ambiguous = pool.some((a) => pool.some((b) => a !== b && distanceApprox(a, b) > 150));
    if (near) exact = pool.reduce((best, n) => (distanceApprox(n, { lat: near[0], lon: near[1] }) < distanceApprox(best, { lat: near[0], lon: near[1] }) ? n : best));
  }
  if (exact) {
    // Nummern aus OSM-Interpolationslinien sind nur ungefähr verortet
    const approx = exact.source === 'osm-interp';
    const snapped = approx ? snapToBuilding(street, exact.lat, exact.lon, 20) : null;
    return {
      status: 'exact',
      lat: snapped?.[0] ?? exact.lat,
      lon: snapped?.[1] ?? exact.lon,
      estimated: approx,
      snapped: !!snapped,
      ambiguous,
      match: exact,
      neighbors: [],
    };
  }
  if (p.num !== null) {
    const range = nums.find((n) => n.to !== null && n.num <= p.num && p.num <= n.to && !p.suffix);
    if (range) return { status: 'range', lat: range.lat, lon: range.lon, estimated: false, match: range, neighbors: [] };
    if (p.suffix) {
      const base = nums.find((n) => n.num === p.num && !n.suffix);
      if (base) return { status: 'base', lat: base.lat, lon: base.lon, estimated: true, match: base, neighbors: [base] };
    }
    const est = interpolate(street, p.num);
    if (est) {
      // Geschätzte Lage auf ein echtes Gebäude ohne Hausnummer setzen (gleiche Straßenseite)
      const b = snapToBuilding(street, est.lat, est.lon, 25);
      if (b) return { ...est, lat: b[0], lon: b[1], snapped: true };
      return est;
    }
  }
  const mid = streetMidpoint(street);
  if (mid) return { status: 'street', lat: mid[0], lon: mid[1], estimated: true, neighbors: [] };
  return { status: 'none', lat: NaN, lon: NaN, estimated: true, neighbors: [] };
}

export function streetMidpoint(street) {
  const longest = street.lines.reduce((a, l) => (l.length > (a?.length ?? 0) ? l : a), null);
  if (longest && longest.length) {
    const proj = makeProjection(longest[0][0], longest[0][1]);
    const xy = longest.map(([la, lo]) => proj.toXY(la, lo));
    const { point } = pointAtS(xy, lineLength(xy) / 2);
    return proj.toLatLon(point[0], point[1]);
  }
  if (street.numbers.length) {
    const n = street.numbers[Math.floor(street.numbers.length / 2)];
    return [n.lat, n.lon];
  }
  return street.start ?? null;
}

/** Schätzt die Lage von Nummer n aus den Nachbarn (gleiche Straßenseite bevorzugt). */
export function interpolate(street, n) {
  const numeric = street.numbers.filter((x) => x.num !== null);
  if (!numeric.length) return null;
  const pick = (list) => {
    let lo = null;
    let hi = null;
    for (const x of list) {
      if (x.num < n && (!lo || x.num > lo.num || (x.num === lo.num && !x.suffix))) lo = x;
      if (x.num > n && (!hi || x.num < hi.num || (x.num === hi.num && !x.suffix))) hi = x;
    }
    return { lo, hi };
  };
  const sameParity = numeric.filter((x) => x.num % 2 === n % 2);
  let { lo, hi } = pick(sameParity);
  // Keine Nummer dieser Straßenseite bekannt: beide Seiten verwenden.
  if (!lo && !hi) ({ lo, hi } = pick(numeric));
  const origin = (lo ?? hi);
  const proj = makeProjection(origin.lat, origin.lon);

  if (lo && hi) {
    const t = (n - lo.num) / (hi.num - lo.num);
    const pos = alongStreet(street, proj, lo, hi, t);
    return { status: 'interpolated', lat: pos[0], lon: pos[1], estimated: true, neighbors: [lo, hi] };
  }
  // Nur eine Seite bekannt: mit den zwei nächsten Nummern extrapolieren.
  const one = lo ?? hi;
  const side = sameParity.length >= 2 ? sameParity : numeric;
  const sorted = side
    .filter((x) => x !== one && x.num !== one.num)
    .sort((a, b) => Math.abs(a.num - one.num) - Math.abs(b.num - one.num));
  const two = sorted[0];
  if (!two) {
    return { status: 'single', lat: one.lat, lon: one.lon, estimated: true, neighbors: [one] };
  }
  const t = (n - one.num) / (two.num - one.num);
  // Begrenzen, damit die Schätzung nicht weit über das Straßenende hinausläuft.
  const tc = Math.max(-3, Math.min(4, t));
  const pos = alongStreet(street, proj, one, two, tc);
  return { status: 'extrapolated', lat: pos[0], lon: pos[1], estimated: true, neighbors: [one] };
}

/** Interpoliert entlang der Straßenlinie (mit Seitenversatz), sonst linear. */
function alongStreet(street, proj, a, b, t) {
  const pa = proj.toXY(a.lat, a.lon);
  const pb = proj.toXY(b.lat, b.lon);
  let best = null;
  for (const line of street.lines) {
    if (line.length < 2) continue;
    const xy = line.map(([la, lo]) => proj.toXY(la, lo));
    const ja = projectOnLine(pa, xy);
    const jb = projectOnLine(pb, xy);
    const cost = ja.dist + jb.dist;
    if (!best || cost < best.cost) best = { cost, xy, ja, jb };
  }
  if (best && best.ja.dist < 120 && best.jb.dist < 120 && Math.abs(best.jb.s - best.ja.s) > 1) {
    const total = lineLength(best.xy);
    const s = Math.max(0, Math.min(total, best.ja.s + t * (best.jb.s - best.ja.s)));
    const { point, tangent } = pointAtS(best.xy, s);
    // Seitlicher Abstand: Mittel der Nachbarn (Vorzeichen = Straßenseite).
    const offA = Math.sign(best.ja.cross) * best.ja.dist;
    const offB = Math.sign(best.jb.cross) * best.jb.dist;
    const off = offA + Math.max(0, Math.min(1, t)) * (offB - offA);
    const x = point[0] - tangent[1] * off;
    const y = point[1] + tangent[0] * off;
    return proj.toLatLon(x, y);
  }
  const x = pa[0] + t * (pb[0] - pa[0]);
  const y = pa[1] + t * (pb[1] - pa[1]);
  return proj.toLatLon(x, y);
}

/** Sortierte Nummernliste einer Straße (für Anzeige). */
export function sortedNumbers(street) {
  return [...street.numbers].sort((a, b) => {
    if (a.num === null && b.num === null) return a.norm.localeCompare(b.norm);
    if (a.num === null) return 1;
    if (b.num === null) return -1;
    return a.num - b.num || a.suffix.localeCompare(b.suffix);
  });
}

/**
 * Zufahrt zu einer Hausnummer: eigene Einfahrt vor Daten. Die Linie beginnt an der
 * Abzweigung von der Straße; bei eigenen Einfahrten führt sie gerade zum Haus.
 * @returns {{line:number[][], junction:number[], user:boolean, pointId?:string}|null}
 */
export function drivewayFor(street, input, result) {
  const norms = new Set([normHouseNumber(input)]);
  if (result?.match && (result.status === 'range' || result.status === 'exact')) norms.add(result.match.norm);
  const list = street.driveways ?? [];
  const d = list.find((x) => x.user && x.norms.some((n) => norms.has(n))) ?? list.find((x) => x.norms.some((n) => norms.has(n)));
  if (!d) return null;
  const line = d.user && result && Number.isFinite(result.lat) ? [d.line[0], [result.lat, result.lon]] : d.line;
  return { line, junction: line[0], user: d.user, pointId: d.pointId };
}

/** Abstand eines Punktes zur Straßenlinie in Metern (null ohne Geometrie). */
export function distanceToStreet(street, lat, lon) {
  let best = null;
  const proj = makeProjection(lat, lon);
  for (const line of street.lines) {
    if (line.length < 2) continue;
    const r = projectOnLine([0, 0], line.map(([la, lo]) => proj.toXY(la, lo)));
    if (r && (best === null || r.dist < best)) best = r.dist;
  }
  return best;
}

/**
 * Straßen in der Nähe eines Standorts, nächste zuerst (für den Vorschlag auf dem Startscreen).
 * Abstand zur Straßenlinie, bei Straßen ohne Geometrie zur nächsten Hausnummer.
 * @returns {{street:object, dist:number}[]}
 */
export function nearestStreets(index, lat, lon, maxM = 60, limit = 3) {
  const pad = maxM / 111320;
  const padLon = pad / Math.cos((lat * Math.PI) / 180);
  const out = [];
  for (const s of index.streets.values()) {
    const b = s.bbox;
    if (!b || lat < b[0] - pad || lat > b[2] + pad || lon < b[1] - padLon || lon > b[3] + padLon) continue;
    let d = distanceToStreet(s, lat, lon);
    if (d === null) {
      for (const n of s.numbers) {
        const x = (n.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180);
        const y = (n.lat - lat) * 111320;
        const dn = Math.hypot(x, y);
        if (d === null || dn < d) d = dn;
      }
    }
    if (d !== null && d <= maxM) out.push({ street: s, dist: d });
  }
  // Gleiche Straße (Name) nur einmal, nächste zuerst
  out.sort((a, b) => a.dist - b.dist);
  const seen = new Set();
  return out.filter((x) => !seen.has(x.street.norm) && seen.add(x.street.norm)).slice(0, limit);
}

/**
 * Nächstes Gebäude ohne Hausnummer zu einer geschätzten Lage (bis maxM Meter), auf derselben
 * Straßenseite und nicht schon mit einer bekannten Nummer belegt. Sonst null.
 */
export function snapToBuilding(street, lat, lon, maxM = 25) {
  const blds = street.buildings ?? [];
  if (!blds.length) return null;
  const proj = makeProjection(lat, lon);
  const lines = street.lines.filter((l) => l.length >= 2).map((l) => l.map(([la, lo]) => proj.toXY(la, lo)));
  const side = (pt) => {
    let best = null;
    for (const l of lines) {
      const r = projectOnLine(pt, l);
      if (r && (!best || r.dist < best.dist)) best = r;
    }
    return best ? Math.sign(best.cross) : 0;
  };
  const mySide = side([0, 0]);
  const taken = street.numbers.map((n) => proj.toXY(n.lat, n.lon));
  let best = null;
  let bestD = maxM;
  for (const [bl, bo] of blds) {
    const p = proj.toXY(bl, bo);
    const d = Math.hypot(p[0], p[1]);
    if (d > bestD) continue;
    if (mySide && side(p) !== mySide) continue;
    if (taken.some((t) => Math.hypot(t[0] - p[0], t[1] - p[1]) < 6)) continue;
    best = [bl, bo];
    bestD = d;
  }
  return best;
}

/** Ungefährer Abstand in Metern zwischen zwei Punkten {lat, lon}. */
function distanceApprox(a, b) {
  const kx = 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * kx);
}

/** Gleichnamige Straßen: die dem Standort nächste zuerst (Reihenfolge sonst unverändert). */
export function preferNearby(streets, near) {
  if (!near) return streets;
  const dist = (s) => {
    if (!s.bbox) return Infinity;
    const lat = Math.max(s.bbox[0], Math.min(s.bbox[2], near[0]));
    const lon = Math.max(s.bbox[1], Math.min(s.bbox[3], near[1]));
    return distanceApprox({ lat, lon }, { lat: near[0], lon: near[1] });
  };
  const out = [...streets];
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      if (out[j].norm === out[i].norm && dist(out[j]) < dist(out[i])) {
        const [x] = out.splice(j, 1);
        out.splice(i, 0, x);
      }
    }
  }
  return out;
}
