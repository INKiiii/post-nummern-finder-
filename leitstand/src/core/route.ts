/**
 * Routengeometrie einer Tour und Zeitpläne entlang der Route.
 *
 * Eine Route ist eine Linie durch das Straßennetz (Punkte mit laufender Strecke s in km),
 * gegliedert in Teile (Fahrt zwischen Gebieten, Weg im Bezirk, Treffpunkt) und mit den
 * Stopps des Bezirks in Gangfolge. Ein Zeitplan ordnet jeder Strecke s eine Uhrzeit zu
 * (mit Haltezeiten an den Stopps). Die Simulation nutzt das für den Ist-Ablauf, der
 * Leitstand für die Soll-Zeit und Prognosen.
 */
import { G } from '../glossar';
import type { Kontext, PlanAuswertung } from './modell';
import type { KnotenId, Vec2 } from './types';

export type RoutenSchritt = { art: 'bezirk'; behaelterId: string } | { art: 'treffpunkt'; knoten: KnotenId; name: string };

export interface RoutenTeil {
  art: 'fahrt' | 'bezirk' | 'treffpunkt';
  s0: number;
  s1: number;
  /** Ziel der Fahrt bzw. Name des Bezirks/Treffpunkts */
  name: string;
  bezirkId?: string;
  behaelterId?: string;
  /** Index des Schritts im Plan (für Bezirk und Treffpunkt) */
  schritt?: number;
}

export interface RoutenStopp {
  stoppId: number;
  s: number;
  bezirkId: string;
  behaelterId: string;
  /** Position in der Gangfolge des Bezirks (0-basiert) */
  index: number;
}

export interface Route {
  punkte: Vec2[];
  /** laufende Strecke in km je Punkt */
  s: number[];
  knoten: KnotenId[];
  teile: RoutenTeil[];
  stopps: RoutenStopp[];
  laenge: number;
}

export function leereRoute(start: Vec2, knoten: KnotenId): Route {
  return { punkte: [start], s: [0], knoten: [knoten], teile: [], stopps: [], laenge: 0 };
}

class RoutenBauer {
  r: Route;
  constructor(
    private ctx: Kontext,
    start: KnotenId,
  ) {
    const k = ctx.welt.netz.knoten[start];
    this.r = leereRoute({ x: k.x, y: k.y }, start);
  }
  get ende(): KnotenId {
    return this.r.knoten[this.r.knoten.length - 1];
  }
  get s(): number {
    return this.r.s[this.r.s.length - 1];
  }
  anhaengen(weg: KnotenId[]): void {
    const k = this.ctx.welt.netz.knoten;
    for (const id of weg) {
      if (id === this.ende) continue;
      const p = { x: k[id].x, y: k[id].y };
      const v = this.r.punkte[this.r.punkte.length - 1];
      this.r.punkte.push(p);
      this.r.s.push(this.s + Math.hypot(p.x - v.x, p.y - v.y));
      this.r.knoten.push(id);
    }
  }
  fahrt(ziel: KnotenId, name: string): void {
    const s0 = this.s;
    this.anhaengen(this.ctx.wege.pfad(this.ende, ziel));
    this.r.teile.push({ art: 'fahrt', s0, s1: this.s, name });
  }
}

/** Route ab `start` über die Schritte, auf Wunsch mit Rückfahrt zur Basis */
export function baueRoute(ctx: Kontext, start: KnotenId, schritte: RoutenSchritt[], zurBasis = true, schrittIndexStart = 0): Route {
  const { welt, tag } = ctx;
  const b = new RoutenBauer(ctx, start);
  schritte.forEach((sch, i) => {
    if (sch.art === 'bezirk') {
      const bz = welt.bezirke[tag.behaelter[sch.behaelterId].zielbezirk];
      b.fahrt(bz.anfahrpunkt, bz.name);
      const s0 = b.s;
      const startIdx = b.r.punkte.length - 1;
      b.anhaengen(bz.innenWeg);
      // Stopps in Gangfolge auf dem Innenweg suchen
      let j = startIdx;
      bz.stopps.forEach((stoppId, index) => {
        const knoten = welt.stopps[stoppId].knoten;
        let i = j;
        while (i < b.r.knoten.length && b.r.knoten[i] !== knoten) i++;
        if (i >= b.r.knoten.length) i = j; // sollte nicht vorkommen
        b.r.stopps.push({ stoppId, s: b.r.s[i], bezirkId: bz.id, behaelterId: sch.behaelterId, index });
        j = i;
      });
      b.r.teile.push({ art: 'bezirk', s0, s1: b.s, name: bz.name, bezirkId: bz.id, behaelterId: sch.behaelterId, schritt: schrittIndexStart + i });
    } else {
      b.fahrt(sch.knoten, `${G.treffpunkt} ${sch.name}`);
      b.r.teile.push({ art: 'treffpunkt', s0: b.s, s1: b.s, name: `${G.treffpunkt} ${sch.name}`, schritt: schrittIndexStart + i });
    }
  });
  if (zurBasis) b.fahrt(welt.basis.knoten, G.zustellbasis);
  b.r.laenge = b.s;
  return b.r;
}

/** Route einer Tour laut Planauswertung (Start am Startknoten der Tour) */
export function routeAusAuswertung(ctx: Kontext, aus: PlanAuswertung, tourId: string): Route {
  const t = aus.touren[tourId];
  const start = ctx.tag.start[tourId];
  const schritte: RoutenSchritt[] = t.schritte.map((x) =>
    x.schritt.art === 'bezirk' ? { art: 'bezirk', behaelterId: x.schritt.behaelterId } : { art: 'treffpunkt', knoten: x.schritt.treffpunkt, name: x.schritt.treffpunktName },
  );
  return baueRoute(ctx, start.knoten, schritte, !start.defekt && t.aktiv);
}

/** Knotenfolge der ganzen Tour (für Linien in Karte und Szene) */
export function tourWeg(ctx: Kontext, aus: PlanAuswertung, tourId: string): KnotenId[] {
  if (!aus.touren[tourId]?.aktiv) return [];
  return routeAusAuswertung(ctx, aus, tourId).knoten;
}

/** Route ab Strecke s abschneiden und mit einer neuen Route fortsetzen (Umplanung unterwegs) */
export function verketteRoute(alt: Route, bisS: number, neu: Route): Route {
  const i = suchIndex(alt.s, bisS);
  const punkte = alt.punkte.slice(0, i + 1);
  const s = alt.s.slice(0, i + 1);
  const knoten = alt.knoten.slice(0, i + 1);
  const basis = s[s.length - 1];
  for (let j = 1; j < neu.punkte.length; j++) {
    punkte.push(neu.punkte[j]);
    s.push(basis + neu.s[j]);
    knoten.push(neu.knoten[j]);
  }
  const teile = [...alt.teile.filter((t) => t.s0 < basis - 1e-9).map((t) => ({ ...t, s1: Math.min(t.s1, basis) })), ...neu.teile.map((t) => ({ ...t, s0: t.s0 + basis, s1: t.s1 + basis }))];
  const stopps = [...alt.stopps.filter((x) => x.s <= basis + 1e-9), ...neu.stopps.map((x) => ({ ...x, s: x.s + basis }))];
  return { punkte, s, knoten, teile, stopps, laenge: s[s.length - 1] };
}

/** größter Index i mit werte[i] <= x (werte aufsteigend) */
export function suchIndex(werte: number[], x: number): number {
  let lo = 0;
  let hi = werte.length - 1;
  if (x <= werte[0]) return 0;
  if (x >= werte[hi]) return hi;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (werte[m] <= x) lo = m;
    else hi = m;
  }
  return lo;
}

/** Punkt und Fahrtrichtung (Radiant, Welt) bei Strecke s */
export function punktBei(r: Route, s: number): { x: number; y: number; richtung: number } {
  if (r.punkte.length === 1) return { ...r.punkte[0], richtung: 0 };
  const i = Math.min(suchIndex(r.s, s), r.punkte.length - 2);
  const a = r.punkte[i];
  const b = r.punkte[i + 1];
  const l = r.s[i + 1] - r.s[i];
  const f = l > 0 ? Math.max(0, Math.min(1, (s - r.s[i]) / l)) : 0;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, richtung: Math.atan2(b.y - a.y, b.x - a.x) };
}

/** Nächster Punkt der Route zu p im Streckenbereich [sMin, sMax] */
export function naechstesS(r: Route, p: Vec2, sMin = 0, sMax = Infinity): { s: number; abstand: number } {
  let best = { s: Math.max(0, Math.min(sMin, r.laenge)), abstand: Infinity };
  const i0 = suchIndex(r.s, sMin);
  for (let i = i0; i < r.punkte.length - 1 && r.s[i] <= sMax; i++) {
    const a = r.punkte[i];
    const b = r.punkte[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let f = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
    f = Math.max(0, Math.min(1, f));
    const s = r.s[i] + (r.s[i + 1] - r.s[i]) * f;
    if (s < sMin - 1e-9 || s > sMax + 1e-9) continue;
    const d = Math.hypot(p.x - (a.x + dx * f), p.y - (a.y + dy * f));
    if (d < best.abstand - 1e-12) best = { s, abstand: d };
  }
  return best;
}

export function teilBei(r: Route, s: number): RoutenTeil | undefined {
  for (const t of r.teile) if (s >= t.s0 - 1e-9 && s <= t.s1 + 1e-9 && t.art !== 'treffpunkt') return t;
  return undefined;
}

// ---------------------------------------------------------------------------------------
// Zeitplan entlang der Route
// ---------------------------------------------------------------------------------------

/** Stützstellen (s, t): s nicht fallend, t steigend; gleiches s = Halt */
export interface Zeitplan {
  s: number[];
  t: number[];
}

export interface ZeitplanParameter {
  /** km/h für einen Fahrt-Teil */
  kmhFahrt: (teil: RoutenTeil) => number;
  /** km/h im Bezirk */
  kmhInnen: (teil: RoutenTeil) => number;
  /** Haltezeit in Minuten an einem Stopp */
  halt: (stopp: RoutenStopp) => number;
  /** Aufenthalt am Treffpunkt in Minuten */
  treffpunkt?: (teil: RoutenTeil) => number;
}

export function zeitplan(r: Route, startZeit: number, p: ZeitplanParameter): Zeitplan {
  const zp: Zeitplan = { s: [0], t: [startZeit] };
  let s = 0;
  let t = startZeit;
  const bis = (ziel: number, kmh: number) => {
    if (ziel <= s + 1e-12) return;
    t += ((ziel - s) / kmh) * 60;
    s = ziel;
    zp.s.push(s);
    zp.t.push(t);
  };
  const halten = (min: number) => {
    if (min <= 0) return;
    t += min;
    zp.s.push(s);
    zp.t.push(t);
  };
  for (const teil of r.teile) {
    if (teil.art === 'fahrt') bis(teil.s1, p.kmhFahrt(teil));
    else if (teil.art === 'treffpunkt') halten(p.treffpunkt?.(teil) ?? 0);
    else {
      const v = p.kmhInnen(teil);
      for (const st of r.stopps) {
        if (st.behaelterId !== teil.behaelterId || st.s < teil.s0 - 1e-9 || st.s > teil.s1 + 1e-9) continue;
        bis(st.s, v);
        halten(p.halt(st));
      }
      bis(teil.s1, v);
    }
  }
  return zp;
}

/** Strecke s zur Uhrzeit t */
export function sBeiZeit(zp: Zeitplan, t: number): number {
  const i = suchIndex(zp.t, t);
  if (i >= zp.t.length - 1) return zp.s[zp.s.length - 1];
  const dt = zp.t[i + 1] - zp.t[i];
  const f = dt > 0 ? Math.max(0, Math.min(1, (t - zp.t[i]) / dt)) : 0;
  return zp.s[i] + (zp.s[i + 1] - zp.s[i]) * f;
}

/** Ankunft (erstes Erreichen) und Abfahrt (letzter Zeitpunkt) bei Strecke s */
export function zeitBeiS(zp: Zeitplan, s: number): { ankunft: number; abfahrt: number } {
  const n = zp.s.length;
  if (s <= zp.s[0]) {
    let j = 0;
    while (j + 1 < n && zp.s[j + 1] <= zp.s[0] + 1e-12) j++;
    return { ankunft: zp.t[0], abfahrt: zp.t[j] };
  }
  if (s >= zp.s[n - 1]) {
    let j = n - 1;
    while (j > 0 && zp.s[j - 1] >= zp.s[n - 1] - 1e-12) j--;
    return { ankunft: zp.t[j], abfahrt: zp.t[n - 1] };
  }
  // erstes i mit zp.s[i] >= s
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (zp.s[m] < s - 1e-12) lo = m + 1;
    else hi = m;
  }
  const i = lo;
  let ankunft: number;
  if (Math.abs(zp.s[i] - s) <= 1e-12) ankunft = zp.t[i];
  else {
    const ds = zp.s[i] - zp.s[i - 1];
    ankunft = zp.t[i - 1] + (zp.t[i] - zp.t[i - 1]) * ((s - zp.s[i - 1]) / ds);
  }
  let j = i;
  if (Math.abs(zp.s[i] - s) <= 1e-12) while (j + 1 < n && Math.abs(zp.s[j + 1] - s) <= 1e-12) j++;
  const abfahrt = Math.abs(zp.s[j] - s) <= 1e-12 ? zp.t[j] : ankunft;
  return { ankunft, abfahrt };
}

/** Zeitplan ab Strecke s abschneiden und mit einem neuen (ab s, Zeit t) fortsetzen */
export function verketteZeitplan(alt: Zeitplan, bisS: number, bisT: number, neu: Zeitplan): Zeitplan {
  const s: number[] = [];
  const t: number[] = [];
  for (let i = 0; i < alt.s.length && alt.t[i] <= bisT + 1e-9; i++) {
    s.push(alt.s[i]);
    t.push(alt.t[i]);
  }
  if (!s.length || s[s.length - 1] < bisS - 1e-12 || t[t.length - 1] < bisT - 1e-9) {
    s.push(bisS);
    t.push(bisT);
  }
  for (let j = 1; j < neu.s.length; j++) {
    s.push(bisS + neu.s[j]);
    t.push(neu.t[j]);
  }
  return { s, t };
}
