// Straßenbezug, Fahrtrichtung, Seiten, Vorschauleiste und Vorbeifahr-Warnung
// mit simulierten GPS-Fahrten im Testgebiet (Musterdorf).
import { describe, it, expect, beforeAll } from 'vitest';
import { townPackages } from './town.mjs';
import { buildIndex } from '../src/core';
import { StreetMatcher, type GpsInput, type Match } from '../src/matcher';
import { upcomingNumbers, targetInfo } from '../src/preview';
import { findHouse, drivewayFor } from '../src/core';
import { makeProjection } from '../src/core';
import { SYNTH_ORIGIN } from '../scripts/lib/synthetic.mjs';
import type { Index, Street } from '../src/types';

let index: Index;
const proj = makeProjection(SYNTH_ORIGIN[0], SYNTH_ORIGIN[1]);
const street = (name: string) => [...index.streets.values()].find((s) => s.name === name)!;

/** Pseudo-Zufall mit festem Startwert (reproduzierbar). */
function rng(seed = 1) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

interface DriveOpts {
  speed: number;
  noise?: number;
  seed?: number;
  /** GPS liefert unter ~2,5 m/s unsinnigen Kurs (wie echte Geräte) */
  junkCourse?: boolean;
}

/** Erzeugt GPS-Punkte entlang eines Weges (x/y in Metern im Testgebiet), 1 Punkt pro Sekunde. */
function drive(path: [number, number][], o: DriveOpts): GpsInput[] {
  const r = rng(o.seed ?? 7);
  const out: GpsInput[] = [];
  let t = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, ay] = path[i];
    const [bx, by] = path[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const course = ((Math.atan2(bx - ax, by - ay) * 180) / Math.PI + 360) % 360;
    for (let d = 0; d < len; d += o.speed) {
      const f = d / len;
      const nx = ((r() - 0.5) * 2 * (o.noise ?? 3));
      const ny = ((r() - 0.5) * 2 * (o.noise ?? 3));
      const [lat, lon] = proj.toLatLon(ax + (bx - ax) * f + nx, ay + (by - ay) * f + ny);
      const reliable = o.speed >= 2.5;
      out.push({
        lat,
        lon,
        accuracy: 6,
        course: reliable ? course : o.junkCourse === false ? null : r() * 360,
        speed: o.speed,
        time: (t += 1000),
      });
    }
  }
  return out;
}

function run(m: StreetMatcher, fixes: GpsInput[]): Match[] {
  return fixes.map((f) => m.update(f));
}

const parity = (labels: string[]) => labels.map((l) => Number.parseInt(l, 10) % 2);

beforeAll(() => {
  index = buildIndex(townPackages().pkgs as any);
});

describe('Straßenbezug und Fahrtrichtung', () => {
  it('Schrittgeschwindigkeit: Richtung aus der Bewegung, Seiten richtig (Elbuferstraße nach Osten)', () => {
    const m = new StreetMatcher(() => index);
    const res = run(m, drive([[-900, -3], [-840, -3]], { speed: 1.2, noise: 2 }));
    const last = res[res.length - 1];
    expect(last.street?.name).toBe('Elbuferstraße');
    expect(last.dir).not.toBe(0);
    // Nach Osten ist Norden links: ungerade links, gerade rechts
    const p = upcomingNumbers(m, last)!;
    expect(parity(p.left.map((u) => u.n.label))).toEqual([1, 1, 1]);
    expect(parity(p.right.map((u) => u.n.label))).toEqual([0, 0, 0]);
    const l = p.left.map((u) => Number.parseInt(u.n.label, 10));
    expect([...l].sort((a, b) => a - b)).toEqual(l); // aufsteigend voraus
    expect(p.left[0].ahead).toBeLessThanOrEqual(p.left[1].ahead);
    // Karte zeigt nach Osten (Fahrtrichtung)
    expect(Math.abs(((last.bearing! - 90 + 540) % 360) - 180)).toBeLessThan(10);
  });

  it('Umkehr bei Schrittgeschwindigkeit: Seiten und Reihenfolge drehen sich mit', () => {
    const m = new StreetMatcher(() => index);
    run(m, drive([[-900, -3], [-800, -3]], { speed: 1.2, noise: 2 }));
    const before = upcomingNumbers(m, m.current)!;
    const back = run(m, drive([[-800, 3], [-780, 3], [-781, 3], [-830, 3]], { speed: 1.2, noise: 2, seed: 3 }));
    const last = back[back.length - 1];
    const after = upcomingNumbers(m, last)!;
    expect(parity(after.left.map((u) => u.n.label))).toEqual([0, 0, 0]);
    expect(parity(after.right.map((u) => u.n.label))).toEqual([1, 1, 1]);
    const r = after.right.map((u) => Number.parseInt(u.n.label, 10));
    expect([...r].sort((a, b) => b - a)).toEqual(r); // jetzt absteigend
    expect(before.left[0].n.label).not.toBe(after.right[0].n.label);
    expect(Math.abs(((last.bearing! - 270 + 540) % 360) - 180)).toBeLessThan(15);
  });

  it('Stillstand mit springendem GPS: Position, Richtung und Ausrichtung bleiben ruhig', () => {
    const m = new StreetMatcher(() => index);
    run(m, drive([[-700, -3], [-600, -3]], { speed: 6 }));
    const ref = m.current!;
    const r = rng(11);
    for (let i = 0; i < 40; i++) {
      const [lat, lon] = proj.toLatLon(-600 + (r() - 0.5) * 8, -3 + (r() - 0.5) * 8);
      const res = m.update({ lat, lon, accuracy: 10, course: r() * 360, speed: 0, time: 100000 + i * 1000 });
      expect(res.dir).toBe(ref.dir);
      expect(res.bearing).toBe(ref.bearing);
      expect(res.pos).toEqual(ref.pos);
    }
  });

  it('Kreuzung geradeaus: Straße wechselt nicht', () => {
    const m = new StreetMatcher(() => index);
    const res = run(m, drive([[-420, -3], [-180, -3]], { speed: 8 }));
    expect(new Set(res.map((x) => x.street?.name))).toEqual(new Set(['Elbuferstraße']));
  });

  it('Kreuzung im Schritttempo (Kurs unbrauchbar): Straße wechselt nicht', () => {
    const m = new StreetMatcher(() => index);
    const res = run(m, drive([[-330, -3], [-270, -3]], { speed: 1 }));
    expect(new Set(res.map((x) => x.street?.name))).toEqual(new Set(['Elbuferstraße']));
  });

  it('Abbiegen: neue Straße erst, wenn eindeutig', () => {
    const m = new StreetMatcher(() => index);
    const res = run(m, drive([[-420, -3], [-302, -3], [-302, 120]], { speed: 6 }));
    const names = res.map((x) => x.street?.name);
    expect(names[0]).toBe('Elbuferstraße');
    expect(names[names.length - 1]).toBe('Blumenstraße');
    // kein Hin und Her
    const switches = names.filter((n, i) => i && n !== names[i - 1]).length;
    expect(switches).toBe(1);
    const last = res[res.length - 1];
    const p = upcomingNumbers(m, last)!;
    // Nach Norden: West (ungerade) links, Ost (gerade) rechts
    expect(parity(p.left.map((u) => u.n.label)).every((x) => x === 1)).toBe(true);
    expect(parity(p.right.map((u) => u.n.label)).every((x) => x === 0)).toBe(true);
  });

  it('Kurve: Ausrichtung folgt ruhig dem Straßenverlauf, Richtung bleibt', () => {
    const m = new StreetMatcher(() => index);
    const res = run(m, drive([[-100, -2], [0, -2], [400, 38], [520, 38]], { speed: 5 }));
    const dirs = new Set(res.slice(3).map((x) => x.dir));
    expect(dirs.size).toBe(1);
    for (let i = 4; i < res.length; i++) {
      const d = Math.abs(((res[i].bearing! - res[i - 1].bearing! + 540) % 360) - 180);
      expect(d).toBeLessThan(12);
    }
  });

  it('Straße über zwei Postleitzahlgebiete: durchgehend dieselbe Straße', () => {
    const m = new StreetMatcher(() => index);
    const res = run(m, drive([[-80, -3], [80, 5]], { speed: 5 }));
    expect(new Set(res.map((x) => x.street?.id)).size).toBe(1);
    const e = street('Elbuferstraße');
    expect(e.regions.size).toBe(2);
  });

  it('bevorzugt Tour-Straßen bei Gleichstand', () => {
    // Punkt genau zwischen Reetweg (x=200) und dem Schilfring-Rand (x=200..300 bei y=200)
    const [lat, lon] = proj.toLatLon(205, 190);
    const a = new StreetMatcher(() => index);
    const reet = street('Reetweg');
    const schilf = street('Schilfring');
    a.preferred = new Set([schilf.id]);
    expect(a.update({ lat, lon, accuracy: 8, course: null, speed: 0, time: 1 }).street?.id).toBe(schilf.id);
    const b = new StreetMatcher(() => index);
    b.preferred = new Set([reet.id]);
    expect(b.update({ lat, lon, accuracy: 8, course: null, speed: 0, time: 1 }).street?.id).toBe(reet.id);
  });

  it('Korrektur per Tippen: festgelegte Straße bleibt, solange man in der Nähe ist', () => {
    const m = new StreetMatcher(() => index);
    run(m, drive([[-330, -3], [-310, -3]], { speed: 1 }));
    m.force(street('Blumenstraße'));
    const res = run(m, drive([[-310, -3], [-305, 2]], { speed: 1, seed: 5 }));
    expect(res[res.length - 1].street?.name).toBe('Blumenstraße');
  });
});

describe('Ziel und Vorbeifahr-Warnung', () => {
  const tgt = (s: Street, nr: string) => {
    const r = findHouse(s, nr, null);
    const d = drivewayFor(s, nr, r);
    return {
      t: { lat: r.lat, lon: r.lon, street: s },
      d: d ? { junction: d.junction, away: d.line[1] ?? d.line[0] } : null,
    };
  };

  it('Haus in zweiter Reihe: führt zur Einfahrt, Seite aus der Einfahrt, dann „vorbei“', () => {
    const e = street('Elbuferstraße');
    const { t, d } = tgt(e, '61');
    expect(d).not.toBeNull();
    const m = new StreetMatcher(() => index);
    const toward = run(m, drive([[-600, -3], [-420, -3]], { speed: 5 }));
    const a = targetInfo(m, toward[toward.length - 1], t, d)!;
    expect(a.kind).toBe('ahead');
    expect(a.viaDriveway).toBe(true);
    expect(a.side).toBe('left'); // Einfahrt nach Norden, Fahrt nach Osten
    expect(a.distance).toBeGreaterThan(40);
    const past = run(m, drive([[-420, -3], [-355, -3]], { speed: 5 }));
    const b = targetInfo(m, past[past.length - 1], t, d)!;
    expect(b.kind).toBe('passed');
    expect(b.distance).toBeGreaterThan(8);
    expect(b.distance).toBeLessThan(25);
  });

  it('fehlende Nummer (geschätzt): Ziel auf der richtigen Seite voraus', () => {
    const e = street('Elbuferstraße');
    const r = findHouse(e, '17', null);
    expect(r.estimated).toBe(true);
    const m = new StreetMatcher(() => index);
    const res = run(m, drive([[-960, -3], [-930, -3]], { speed: 1.2 }));
    const info = targetInfo(m, res[res.length - 1], { lat: r.lat, lon: r.lon, street: e })!;
    expect(info.kind).toBe('ahead');
    expect(info.side).toBe('left'); // ungerade = Nordseite
  });

  it('Ziel auf anderer Straße: Luftlinie, keine Seite', () => {
    const b = street('Blumenstraße');
    const r = findHouse(b, '9', null);
    const m = new StreetMatcher(() => index);
    const res = run(m, drive([[-600, -3], [-500, -3]], { speed: 5 }));
    const info = targetInfo(m, res[res.length - 1], { lat: r.lat, lon: r.lon, street: b })!;
    expect(info.kind).toBe('other');
    expect(info.side).toBeNull();
  });
});
