// Straßenbezug statt rohem GPS: legt die Position auf die wahrscheinlichste Straße,
// bestimmt die Fahrtrichtung aus der Bewegung entlang der Straße und liefert eine ruhige
// Kartenausrichtung. Ohne DOM, damit es sich mit simulierten Fahrten testen lässt.
//
// Grundsätze:
// - Bei Schrittgeschwindigkeit oder Stillstand ist der GPS-Kurs unzuverlässig. Die Richtung
//   kommt dann aus der Bewegung entlang der Straße (mindestens einige Meter), sonst bleibt
//   die letzte sichere Richtung.
// - Die Straße wechselt erst, wenn die neue eindeutig ist (zweimal hintereinander klar besser
//   oder die alte ist zu weit weg). Tour-Straßen werden bevorzugt.
// - Im Stand bleibt alles stehen, auch wenn das GPS ein paar Meter springt.

import { makeProjection, pointAtS, projectOnLine, lineLength } from './core';
import type { HouseNumber, Index, Street } from './types';

export interface GpsInput {
  lat: number;
  lon: number;
  accuracy: number;
  /** Kurs vom GPS in Grad (kann im Stand Unsinn sein) */
  course: number | null;
  /** Geschwindigkeit in m/s, falls bekannt */
  speed: number | null;
  time: number;
}

export type Dir = 1 | -1 | 0;

export interface Match {
  street: Street | null;
  /** Index der Linie in street.lines */
  line: number;
  /** Position entlang der Linie (m) */
  s: number;
  /** Abstand der GPS-Position zur Straße (m) */
  dist: number;
  /** Fahrtrichtung entlang der Linie: +1, -1 oder 0 (noch unbekannt) */
  dir: Dir;
  /** Kartenausrichtung (Fahrtrichtung, Grad, 0 = Nord) oder null */
  bearing: number | null;
  /** Anzeigeposition (auf der Straße, wenn nah genug) */
  pos: [number, number];
  raw: [number, number];
  accuracy: number;
  moving: boolean;
  snapped: boolean;
}

export interface NumberOnLine {
  n: HouseNumber;
  line: number;
  s: number;
  /** > 0: links der Linienrichtung */
  cross: number;
  dist: number;
}

interface Geom {
  lines: number[][][];
  lengths: number[];
  numbers: NumberOnLine[] | null;
}

/** Ab dieser Geschwindigkeit (m/s, ~9 km/h) gilt der GPS-Kurs als verlässlich. */
export const COURSE_SPEED = 2.5;
/** Unter dieser Geschwindigkeit (m/s) gilt man als stehend. */
export const STILL_SPEED = 0.8;

const bearingOf = (dx: number, dy: number) => ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
const angleDiff = (a: number, b: number) => {
  let d = (((a - b) % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
};

export class StreetMatcher {
  private proj: ReturnType<typeof makeProjection> | null = null;
  private origin: [number, number] | null = null;
  private geoms = new WeakMap<Street, Geom>();
  private cur: Match | null = null;
  private pending: { id: string; count: number } | null = null;
  private sAnchor: number | null = null;
  private lastXY: [number, number] | null = null;
  private forcedId: string | null = null;
  /** Bevorzugte Straßen (Meine Tour) */
  preferred = new Set<string>();

  constructor(private getIndex: () => Index) {}

  get current(): Match | null {
    return this.cur;
  }

  /** Projektion der Sitzung (Meter um den ersten Standort). */
  projection() {
    return this.proj;
  }

  /** Straße von Hand festlegen (Tippen auf „falsche Straße“). Gilt, solange man in ihrer Nähe bleibt. */
  force(street: Street) {
    this.forcedId = street.id;
    this.pending = null;
    if (this.cur && this.lastXY) {
      const c = this.candidate(street, this.lastXY);
      if (c) this.adopt(c, this.lastXY, null, this.cur.accuracy);
    }
  }

  reset() {
    this.cur = null;
    this.pending = null;
    this.sAnchor = null;
    this.lastXY = null;
  }

  /** Linien einer Straße in Metern (zwischengespeichert). */
  geometry(street: Street): Geom | null {
    if (!this.proj) return null;
    let g = this.geoms.get(street);
    if (!g) {
      // Indizes passen zu street.lines; Linien mit < 2 Punkten bleiben leer
      const all = street.lines.map((l) => (l.length >= 2 ? l.map(([la, lo]) => this.proj!.toXY(la, lo)) : []));
      g = { lines: all, lengths: all.map((l) => (l.length >= 2 ? lineLength(l) : 0)), numbers: null };
      this.geoms.set(street, g);
    }
    return g;
  }

  /** Hausnummern einer Straße, jeweils auf ihre nächste Linie projiziert. */
  numbersOnLines(street: Street): NumberOnLine[] {
    const g = this.geometry(street);
    if (!g) return [];
    if (!g.numbers) {
      g.numbers = [];
      for (const n of street.numbers) {
        const p = this.proj!.toXY(n.lat, n.lon);
        let best: NumberOnLine | null = null;
        g.lines.forEach((l, i) => {
          if (l.length < 2) return;
          const r = projectOnLine(p, l);
          if (r && (!best || r.dist < best.dist)) best = { n, line: i, s: r.s, cross: r.cross, dist: r.dist };
        });
        if (best) g.numbers.push(best);
      }
    }
    return g.numbers;
  }

  /** Punkt (lat/lon) auf eine bestimmte Linie projizieren. */
  projectOn(street: Street, line: number, lat: number, lon: number) {
    const g = this.geometry(street);
    const l = g?.lines[line];
    if (!l || l.length < 2) return null;
    return projectOnLine(this.proj!.toXY(lat, lon), l);
  }

  toXY(lat: number, lon: number): [number, number] {
    return this.proj!.toXY(lat, lon) as [number, number];
  }

  private ensureProjection(lat: number, lon: number) {
    // Neuer Bezugspunkt, wenn man sich weit entfernt (Genauigkeit der ebenen Projektion)
    if (!this.proj || !this.origin || Math.abs(lat - this.origin[0]) > 0.2 || Math.abs(lon - this.origin[1]) > 0.3) {
      this.proj = makeProjection(lat, lon);
      this.origin = [lat, lon];
      this.geoms = new WeakMap();
      this.cur = null;
      this.lastXY = null;
      this.sAnchor = null;
    }
  }

  private candidate(street: Street, xy: number[]) {
    const g = this.geometry(street);
    if (!g) return null;
    let best: { street: Street; line: number; s: number; dist: number; tangent: number[]; point: number[] } | null = null;
    g.lines.forEach((l, i) => {
      if (l.length < 2) return;
      const r = projectOnLine(xy, l);
      if (r && (!best || r.dist < best.dist)) best = { street, line: i, s: r.s, dist: r.dist, tangent: r.tangent, point: r.point };
    });
    return best as { street: Street; line: number; s: number; dist: number; tangent: number[]; point: number[] } | null;
  }

  update(fix: GpsInput): Match {
    this.ensureProjection(fix.lat, fix.lon);
    const xy = this.proj!.toXY(fix.lat, fix.lon) as [number, number];
    const acc = Math.max(3, fix.accuracy || 10);
    const speed = fix.speed !== null && Number.isFinite(fix.speed) ? fix.speed : null;
    const reliableCourse = fix.course !== null && Number.isFinite(fix.course) && speed !== null && speed >= COURSE_SPEED ? fix.course : null;

    // Stillstand: kleine Sprünge des GPS ignorieren, Karte bleibt ruhig
    if (this.cur && this.lastXY) {
      const moved = Math.hypot(xy[0] - this.lastXY[0], xy[1] - this.lastXY[1]);
      const still = speed !== null ? speed < STILL_SPEED : true;
      if (still && moved < Math.max(8, Math.min(acc, 25))) {
        this.cur = { ...this.cur, accuracy: acc, moving: false };
        return this.cur;
      }
    }
    this.lastXY = xy;

    // Kandidaten in der Nähe
    const maxD = Math.max(25, Math.min(60, acc * 1.5));
    const pad = (maxD + 10) / 111320;
    const padLon = pad / Math.cos((fix.lat * Math.PI) / 180);
    type Cand = NonNullable<ReturnType<StreetMatcher['candidate']>> & { score: number };
    const cands: Cand[] = [];
    for (const st of this.getIndex().streets.values()) {
      const b = st.bbox;
      if (!b || !st.lines.length) continue;
      if (fix.lat < b[0] - pad || fix.lat > b[2] + pad || fix.lon < b[1] - padLon || fix.lon > b[3] + padLon) continue;
      const c = this.candidate(st, xy);
      if (!c || c.dist > maxD) continue;
      let score = c.dist;
      if (this.preferred.size && !this.preferred.has(st.id)) score += 8;
      if (reliableCourse !== null) {
        const tb = bearingOf(c.tangent[0], c.tangent[1]);
        score += 12 * Math.abs(Math.sin((angleDiff(reliableCourse, tb) * Math.PI) / 180));
      }
      if (this.cur?.street && st.id === this.cur.street.id) score -= 6;
      if (st.id === this.forcedId) score -= 40;
      cands.push({ ...c, score });
    }
    if (this.forcedId && !cands.some((c) => c.street.id === this.forcedId)) this.forcedId = null;

    if (!cands.length) {
      // Keine Straße in der Nähe: rohe Position, Richtung aus GPS-Kurs oder gehalten
      const bearing = reliableCourse ?? this.cur?.bearing ?? null;
      this.cur = {
        street: null,
        line: 0,
        s: 0,
        dist: Infinity,
        dir: 0,
        bearing,
        pos: [fix.lat, fix.lon],
        raw: [fix.lat, fix.lon],
        accuracy: acc,
        moving: speed === null || speed >= STILL_SPEED,
        snapped: false,
      };
      this.pending = null;
      this.sAnchor = null;
      return this.cur;
    }
    cands.sort((a, b) => a.score - b.score);
    let chosen = cands[0];
    const curStreet = this.cur?.street ?? null;
    if (curStreet && chosen.street.id !== curStreet.id) {
      const curCand = cands.find((c) => c.street.id === curStreet.id);
      if (curCand) {
        // Wechsel nur, wenn die neue Straße zweimal hintereinander klar besser ist
        const clearly = chosen.score + 2 < curCand.score;
        if (clearly && this.pending?.id === chosen.street.id) this.pending.count++;
        else this.pending = clearly ? { id: chosen.street.id, count: 1 } : null;
        if (!this.pending || this.pending.count < 2) chosen = curCand;
      }
    }
    if (chosen.street.id !== curStreet?.id) this.pending = null;
    return this.adopt(chosen, xy, reliableCourse, acc, speed);
  }

  private adopt(
    c: { street: Street; line: number; s: number; dist: number; tangent: number[]; point: number[] },
    xy: [number, number],
    course: number | null,
    acc: number,
    speed: number | null = null,
  ): Match {
    const prev = this.cur;
    const sameLine = prev?.street?.id === c.street.id && prev.line === c.line;
    const tb = bearingOf(c.tangent[0], c.tangent[1]);
    let dir: Dir = sameLine ? prev!.dir : 0;
    if (!sameLine) {
      this.sAnchor = c.s;
      // Neue Straße: Richtung aus GPS-Kurs oder aus der bisherigen Fahrtrichtung
      const ref = course ?? prev?.bearing ?? null;
      if (ref !== null) {
        const along = Math.cos((angleDiff(ref, tb) * Math.PI) / 180);
        dir = Math.abs(along) > 0.35 ? (Math.sign(along) as Dir) : 0;
      }
    } else if (course !== null) {
      const along = Math.cos((angleDiff(course, tb) * Math.PI) / 180);
      if (Math.abs(along) > 0.5) {
        dir = Math.sign(along) as Dir;
        this.sAnchor = c.s;
      }
    } else if (this.sAnchor !== null) {
      // Langsam: Richtung aus der Bewegung entlang der Straße (mindestens einige Meter)
      const ds = c.s - this.sAnchor;
      if (Math.abs(ds) >= Math.max(6, Math.min(acc, 30) * 0.6)) {
        dir = Math.sign(ds) as Dir;
        this.sAnchor = c.s;
      }
    } else this.sAnchor = c.s;

    // Kartenausrichtung: Straßenverlauf voraus (ruhig auch in Kurven)
    let bearing = prev?.bearing ?? null;
    const g = this.geometry(c.street)!;
    const line = g.lines[c.line];
    if (dir !== 0 && c.dist <= 40) {
      const a = pointAtS(line, Math.max(0, Math.min(g.lengths[c.line], c.s - dir * 5))).point;
      const b = pointAtS(line, Math.max(0, Math.min(g.lengths[c.line], c.s + dir * 25))).point;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 3) bearing = this.smooth(prev?.bearing ?? null, bearingOf(b[0] - a[0], b[1] - a[1]));
    } else if (course !== null) bearing = this.smooth(prev?.bearing ?? null, course);

    const snapped = c.dist <= Math.max(12, Math.min(acc, 25));
    const pos = snapped ? (this.proj!.toLatLon(c.point[0], c.point[1]) as [number, number]) : (this.proj!.toLatLon(xy[0], xy[1]) as [number, number]);
    this.cur = {
      street: c.street,
      line: c.line,
      s: c.s,
      dist: c.dist,
      dir,
      bearing,
      pos,
      raw: this.proj!.toLatLon(xy[0], xy[1]) as [number, number],
      accuracy: acc,
      moving: speed === null || speed >= STILL_SPEED,
      snapped,
    };
    return this.cur;
  }

  /** Glättung gegen Zittern; Umkehr (große Änderung) wird sofort übernommen. */
  private smooth(prev: number | null, next: number): number {
    if (prev === null) return next;
    const d = angleDiff(next, prev);
    if (Math.abs(d) < 3) return prev;
    if (Math.abs(d) > 100) return next;
    return (prev + d * 0.6 + 360) % 360;
  }
}
