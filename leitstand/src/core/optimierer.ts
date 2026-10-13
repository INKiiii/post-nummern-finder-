/**
 * Optimierer: Zuordnung Behälter → Tour und Reihenfolge je Tour (kleines Vehicle-Routing-Problem).
 *
 *  1. Cheapest Insertion für offene Behälter
 *  2. Lokale Suche: Tour auflösen, Verschieben, Tauschen
 *  3. Reihenfolge je Tour: Brute Force bis 7 Gebiete, sonst nächster Nachbar + 2-opt
 *
 * Harte Nebenbedingung: keine Tour über Schichtlänge. Umgesetzt als Strafkosten, die jede
 * echte Ersparnis übersteigen (1.000 € je Minute). Ist ein Plan ohne Überstunden nicht
 * möglich (z. B. Spitzentag), minimiert der Optimierer die Überstunden und meldet sie.
 *
 * Beweglich sind nur Behälter, die noch in der Halle stehen. Sie können nur Touren bekommen,
 * deren Fahrzeug noch an der Rampe steht. Behälter an Bord eines abgefahrenen Fahrzeugs
 * bleiben bei ihrer Tour (Übergaben plant uebergabe.ts).
 */
import { schichtMin } from '../config';
import { behaelterFolge, fahrMinuten, tourKosten, zustellMinuten, type Kontext } from './modell';
import type { KnotenId, Plan, StartZustand } from './types';

export const STRAFE_JE_UEBERSTUNDE_MIN = 1000;
export const STRAFE_JE_LIEGEN = 2000;
const EPS = 1e-6;

export interface OptimiererOptionen {
  /** Touren, die keine Behälter aus der Halle (mehr) bekommen dürfen */
  gesperrteTouren?: string[];
  /** Behälter dürfen liegen bleiben (sonst muss alles zugestellt werden) */
  liegenLassenErlaubt?: boolean;
  /** nur die Reihenfolge je Tour optimieren */
  nurReihenfolge?: boolean;
  /** ganze Touren auflösen (Tour einsparen) */
  tourenAufloesen?: boolean;
  verschieben?: boolean;
  tauschen?: boolean;
  /** Reihenfolge innerhalb der Touren ändern */
  reihenfolge?: boolean;
  maxRunden?: number;
}

/** Vorberechnete Daten für schnelle Bewertung */
export class Problem {
  readonly ctx: Kontext;
  readonly tourIds: string[];
  readonly start: Record<string, StartZustand>;
  readonly basis: KnotenId;
  readonly anfahrt = new Map<string, KnotenId>();
  /** Zeit im Bezirk: Fahrt im Gebiet + Zustellung */
  readonly arbeitMin = new Map<string, number>();
  readonly innenKm = new Map<string, number>();
  /** Touren, die Behälter aus der Halle bekommen können */
  readonly ziele: Set<string>;
  /** Behälter in der Halle */
  readonly beweglich: Set<string>;
  /** Touren mit Übergaben: werden nicht verändert */
  readonly fest: Set<string>;
  private readonly distCache = new Map<number, number>();

  constructor(ctx: Kontext, plan: Plan, gesperrt: string[] = []) {
    this.ctx = ctx;
    const { tag, welt, annahmen: a } = ctx;
    this.tourIds = tag.touren.map((t) => t.id);
    this.start = tag.start;
    this.basis = welt.basis.knoten;
    for (const id of tag.behaelterIds) {
      const b = tag.behaelter[id];
      const bz = welt.bezirke[b.zielbezirk];
      this.anfahrt.set(id, bz.anfahrpunkt);
      this.innenKm.set(id, bz.innenKm);
      this.arbeitMin.set(id, fahrMinuten(bz.innenKm, a.tempoImGebietKmh) + zustellMinuten(b.inhalt, a).summe);
    }
    const unterwegs = new Set<string>();
    const erledigt = new Set<string>();
    for (const id of this.tourIds) {
      for (const b of tag.start[id].geladen) unterwegs.add(b);
      for (const b of tag.start[id].erledigt) erledigt.add(b);
    }
    this.beweglich = new Set(tag.behaelterIds.filter((b) => !unterwegs.has(b) && !erledigt.has(b)));
    this.fest = new Set(this.tourIds.filter((id) => (plan.touren[id]?.schritte ?? []).some((s) => s.art === 'uebergabe')));
    this.ziele = new Set(
      this.tourIds.filter((id) => {
        const s = tag.start[id];
        return s.besetzt && !s.defekt && s.mussLaden && !gesperrt.includes(id) && !this.fest.has(id);
      }),
    );
  }

  dist(a: KnotenId, b: KnotenId): number {
    if (a === b) return 0;
    const key = a < b ? a * 100000 + b : b * 100000 + a;
    let d = this.distCache.get(key);
    if (d === undefined) {
      d = this.ctx.wege.distanz(a, b);
      this.distCache.set(key, d);
    }
    return d;
  }

  /** Kilometer zwischen den Gebieten für eine Folge (Start → Bezirke → Basis) */
  kmZwischen(tourId: string, folge: readonly string[]): number {
    let km = 0;
    let k = this.start[tourId].knoten;
    for (const b of folge) {
      const z = this.anfahrt.get(b)!;
      km += this.dist(k, z);
      k = z;
    }
    return km + this.dist(k, this.basis);
  }

  /** Bewertung einer Tour (ohne Übergaben): Kosten + Strafe für Überstunden */
  tour(tourId: string, folge: readonly string[]): { wert: number; kosten: number; dauer: number; ueber: number; km: number } {
    const s = this.start[tourId];
    const a = this.ctx.annahmen;
    const aktiv = s.besetzt && (folge.length > 0 || s.geladen.length > 0 || hatGearbeitet(s));
    if (!aktiv) return { wert: 0, kosten: 0, dauer: 0, ueber: 0, km: 0 };
    if (s.defekt) {
      // steht still: nur das bisher Geleistete zählt
      const dauer = s.zeit - s.schichtbeginn;
      const ueber = Math.max(0, dauer - schichtMin(a));
      const km = s.bisher.kmZwischen + s.bisher.kmInnen;
      const kosten = tourKosten(true, dauer, km, a).summe;
      return { wert: kosten + ueber * STRAFE_JE_UEBERSTUNDE_MIN, kosten, dauer, ueber, km };
    }
    let t = s.zeit + (s.mussLaden ? a.ladezeitMin : 0);
    let kmIn = s.bisher.kmInnen;
    for (const b of folge) {
      kmIn += this.innenKm.get(b)!;
      t += this.arbeitMin.get(b)!;
    }
    const kmZw = s.bisher.kmZwischen + this.kmZwischen(tourId, folge);
    t += fahrMinuten(kmZw - s.bisher.kmZwischen, a.tempoZwischenKmh);
    const dauer = t - s.schichtbeginn;
    const ueber = Math.max(0, dauer - schichtMin(a));
    const kosten = tourKosten(true, dauer, kmZw + kmIn, a).summe;
    return { wert: kosten + ueber * STRAFE_JE_UEBERSTUNDE_MIN, kosten, dauer, ueber, km: kmZw + kmIn };
  }

  /** Beste Reihenfolge (minimale km zwischen den Gebieten) */
  ordne(tourId: string, folge: readonly string[]): string[] {
    if (folge.length <= 1) return [...folge];
    if (folge.length <= 7) return this.ordneExakt(tourId, folge);
    return this.ordne2opt(tourId, folge);
  }

  private ordneExakt(tourId: string, folge: readonly string[]): string[] {
    const n = folge.length;
    const knoten = folge.map((b) => this.anfahrt.get(b)!);
    const start = this.start[tourId].knoten;
    let best = this.kmZwischen(tourId, folge) + EPS;
    let bestFolge = [...folge];
    const genutzt = new Array<boolean>(n).fill(false);
    const aktuell: number[] = [];
    const suche = (k: KnotenId, km: number) => {
      if (km >= best) return;
      if (aktuell.length === n) {
        const gesamt = km + this.dist(k, this.basis);
        if (gesamt < best - EPS) {
          best = gesamt;
          bestFolge = aktuell.map((i) => folge[i]);
        }
        return;
      }
      for (let i = 0; i < n; i++) {
        if (genutzt[i]) continue;
        genutzt[i] = true;
        aktuell.push(i);
        suche(knoten[i], km + this.dist(k, knoten[i]));
        aktuell.pop();
        genutzt[i] = false;
      }
    };
    suche(start, 0);
    return bestFolge;
  }

  private ordne2opt(tourId: string, folge: readonly string[]): string[] {
    // nächster Nachbar
    const offen = [...folge];
    const rf: string[] = [];
    let k = this.start[tourId].knoten;
    while (offen.length > 0) {
      let bi = 0;
      for (let i = 1; i < offen.length; i++) if (this.dist(k, this.anfahrt.get(offen[i])!) < this.dist(k, this.anfahrt.get(offen[bi])!) - EPS) bi = i;
      const b = offen.splice(bi, 1)[0];
      rf.push(b);
      k = this.anfahrt.get(b)!;
    }
    let akt = this.kmZwischen(tourId, rf) < this.kmZwischen(tourId, folge) ? rf : [...folge];
    let bestKm = this.kmZwischen(tourId, akt);
    let besser = true;
    while (besser) {
      besser = false;
      for (let i = 0; i < akt.length - 1; i++) {
        for (let j = i + 1; j < akt.length; j++) {
          const kandidat = [...akt.slice(0, i), ...akt.slice(i, j + 1).reverse(), ...akt.slice(j + 1)];
          const km = this.kmZwischen(tourId, kandidat);
          if (km < bestKm - EPS) {
            akt = kandidat;
            bestKm = km;
            besser = true;
          }
        }
      }
      // Or-opt: einzelnes Gebiet an andere Stelle
      for (let i = 0; i < akt.length; i++) {
        for (let j = 0; j < akt.length; j++) {
          if (i === j) continue;
          const kandidat = [...akt];
          const [b] = kandidat.splice(i, 1);
          kandidat.splice(j, 0, b);
          const km = this.kmZwischen(tourId, kandidat);
          if (km < bestKm - EPS) {
            akt = kandidat;
            bestKm = km;
            besser = true;
          }
        }
      }
    }
    return akt;
  }
}

function hatGearbeitet(s: StartZustand): boolean {
  const m = s.bisher.min;
  return m.laden + m.fahrtZwischen + m.fahrtInnen + m.zustellung + m.uebergabe + m.warten > 0;
}

/** Arbeitsstand der Suche */
export class Loesung {
  folgen: Record<string, string[]>;
  liegen: string[];
  private werte = new Map<string, number>();

  constructor(
    readonly p: Problem,
    folgen: Record<string, string[]>,
    liegen: string[],
  ) {
    this.folgen = Object.fromEntries(Object.entries(folgen).map(([k, v]) => [k, [...v]]));
    this.liegen = [...liegen];
  }

  kopie(): Loesung {
    return new Loesung(this.p, this.folgen, this.liegen);
  }

  wert(tourId: string): number {
    let w = this.werte.get(tourId);
    if (w === undefined) {
      w = this.p.fest.has(tourId) ? 0 : this.p.tour(tourId, this.folgen[tourId] ?? []).wert;
      this.werte.set(tourId, w);
    }
    return w;
  }

  gesamt(): number {
    let s = this.liegen.length * STRAFE_JE_LIEGEN;
    for (const id of this.p.tourIds) s += this.wert(id);
    return s;
  }

  setze(tourId: string, folge: string[]): void {
    this.folgen[tourId] = folge;
    this.werte.delete(tourId);
  }

  /** beste Einfügestelle für Behälter b in Tour t (ohne Umsortieren) */
  einfuegung(t: string, b: string, folge = this.folgen[t] ?? []): { pos: number; delta: number; folge: string[] } {
    const vorher = this.p.fest.has(t) ? 0 : this.p.tour(t, folge).wert;
    let best = { pos: -1, delta: Infinity, folge: folge };
    for (let pos = 0; pos <= folge.length; pos++) {
      const neu = [...folge.slice(0, pos), b, ...folge.slice(pos)];
      const d = this.p.tour(t, neu).wert - vorher;
      if (d < best.delta - EPS) best = { pos, delta: d, folge: neu };
    }
    return best;
  }

  /** Tour, in der der Behälter liegt (oder null) */
  tourVon(b: string): string | null {
    for (const id of this.p.tourIds) if (this.folgen[id]?.includes(b)) return id;
    return null;
  }
}

// ---------------------------------------------------------------------------------------

/** Plan → Arbeitsstand: Behälter in ungültigen Touren werden „offen“ */
function startLoesung(p: Problem, plan: Plan): { l: Loesung; offen: string[] } {
  const folgen: Record<string, string[]> = {};
  const offen: string[] = [];
  for (const id of p.tourIds) {
    if (p.fest.has(id)) {
      folgen[id] = behaelterFolge(plan, id);
      continue;
    }
    const folge: string[] = [];
    for (const b of behaelterFolge(plan, id)) {
      if (p.beweglich.has(b) && !p.ziele.has(id)) offen.push(b);
      else folge.push(b);
    }
    folgen[id] = folge;
  }
  for (const b of plan.liegenLassen) if (p.beweglich.has(b)) offen.push(b);
  const liegen = plan.liegenLassen.filter((b) => !p.beweglich.has(b));
  return { l: new Loesung(p, folgen, liegen), offen };
}

/** Cheapest Insertion: am weitesten entfernte Behälter zuerst */
export function einfuegen(l: Loesung, offen: string[], liegenErlaubt: boolean, ausschluss: string[] = []): void {
  const p = l.p;
  const sortiert = [...offen].sort(
    (x, y) => p.dist(p.basis, p.anfahrt.get(y)!) - p.dist(p.basis, p.anfahrt.get(x)!) || x.localeCompare(y),
  );
  for (const b of sortiert) {
    let best: { tour: string; delta: number; folge: string[] } | null = null;
    for (const t of p.tourIds) {
      if (!p.ziele.has(t) || ausschluss.includes(t)) continue;
      const e = l.einfuegung(t, b);
      if (!best || e.delta < best.delta - EPS) best = { tour: t, delta: e.delta, folge: e.folge };
    }
    if (!best || (liegenErlaubt && best.delta >= STRAFE_JE_LIEGEN)) l.liegen.push(b);
    else l.setze(best.tour, best.folge);
  }
}

/** Plan optimieren. Gibt einen neuen Plan zurück, der Eingabeplan bleibt unverändert. */
export function optimiere(ctx: Kontext, plan: Plan, opt: OptimiererOptionen = {}): Plan {
  const p = new Problem(ctx, plan, opt.gesperrteTouren);
  const { l, offen } = startLoesung(p, plan);
  einfuegen(l, offen, !!opt.liegenLassenErlaubt);
  const o = {
    tourenAufloesen: opt.tourenAufloesen ?? true,
    verschieben: opt.verschieben ?? true,
    tauschen: opt.tauschen ?? true,
    reihenfolge: opt.reihenfolge ?? true,
    liegenLassenErlaubt: !!opt.liegenLassenErlaubt,
    maxRunden: opt.maxRunden ?? 60,
  };
  if (opt.nurReihenfolge) {
    ordneAlle(l);
  } else {
    lokaleSuche(l, o);
  }
  return zuPlan(l, plan);
}

export interface SuchOptionen {
  tourenAufloesen: boolean;
  verschieben: boolean;
  tauschen: boolean;
  reihenfolge: boolean;
  liegenLassenErlaubt: boolean;
  maxRunden: number;
}

export function lokaleSuche(l: Loesung, o: SuchOptionen): void {
  if (o.reihenfolge) ordneAlle(l);
  for (let runde = 0; runde < o.maxRunden; runde++) {
    if (o.tourenAufloesen && tourAufloesen(l, o)) continue;
    const zug = besterZug(l, o);
    if (!zug) break;
    zug();
  }
  if (o.reihenfolge) ordneAlle(l);
}

function ordneAlle(l: Loesung): void {
  for (const id of l.p.tourIds) {
    if (l.p.fest.has(id) || l.p.start[id].defekt) continue;
    const f = l.folgen[id] ?? [];
    const neu = l.p.ordne(id, f);
    if (neu.join() !== f.join()) l.setze(id, neu);
  }
}

/** Versucht, eine Tour komplett auf die anderen zu verteilen. true bei Erfolg. */
function tourAufloesen(l: Loesung, o: SuchOptionen): boolean {
  const p = l.p;
  const vorher = l.gesamt();
  const kandidaten = p.tourIds
    .filter((t) => p.ziele.has(t) && (l.folgen[t]?.length ?? 0) > 0 && l.folgen[t].every((b) => p.beweglich.has(b)))
    .sort((x, y) => p.tour(x, l.folgen[x]).dauer - p.tour(y, l.folgen[y]).dauer);
  for (const t of kandidaten) {
    const versuch = l.kopie();
    const offen = versuch.folgen[t];
    versuch.setze(t, []);
    einfuegen(versuch, offen, false, [t]);
    if (versuch.folgen[t].length > 0) continue;
    // kurz nachbessern ohne die aufgelöste Tour wieder zu öffnen
    const ziele = p.ziele as Set<string>;
    ziele.delete(t);
    try {
      ordneAlle(versuch);
      for (let i = 0; i < 20; i++) {
        const zug = besterZug(versuch, { ...o, tauschen: true });
        if (!zug) break;
        zug();
      }
      ordneAlle(versuch);
    } finally {
      ziele.add(t);
    }
    if (versuch.gesamt() < vorher - EPS) {
      l.folgen = versuch.folgen;
      l.liegen = versuch.liegen;
      for (const id of p.tourIds) l.setze(id, l.folgen[id] ?? []);
      return true;
    }
  }
  return false;
}

/** Bester einzelner Zug (Verschieben, Tauschen, Liegenlassen/Aufnehmen, Umsortieren) oder null */
function besterZug(l: Loesung, o: SuchOptionen): (() => void) | null {
  const p = l.p;
  let bestDelta = -EPS * 10;
  let best: (() => void) | null = null;
  const nimm = (delta: number, zug: () => void) => {
    if (delta < bestDelta - EPS) {
      bestDelta = delta;
      best = zug;
    }
  };

  const quellen = p.tourIds.filter((t) => !p.fest.has(t));
  const ziele = p.tourIds.filter((t) => p.ziele.has(t));

  if (o.verschieben) {
    for (const a of quellen) {
      const fa = l.folgen[a] ?? [];
      for (let i = 0; i < fa.length; i++) {
        const b = fa[i];
        if (!p.beweglich.has(b)) continue;
        const ohne = [...fa.slice(0, i), ...fa.slice(i + 1)];
        const dA = p.tour(a, ohne).wert - l.wert(a);
        for (const z of ziele) {
          if (z === a) continue;
          const e = l.einfuegung(z, b);
          nimm(dA + e.delta, () => {
            l.setze(a, p.ordne(a, ohne));
            l.setze(z, p.ordne(z, e.folge));
          });
        }
        if (o.liegenLassenErlaubt) {
          nimm(dA + STRAFE_JE_LIEGEN, () => {
            l.setze(a, p.ordne(a, ohne));
            l.liegen.push(b);
          });
        }
      }
    }
    if (o.liegenLassenErlaubt) {
      for (let i = 0; i < l.liegen.length; i++) {
        const b = l.liegen[i];
        if (!p.beweglich.has(b)) continue;
        for (const z of ziele) {
          const e = l.einfuegung(z, b);
          nimm(e.delta - STRAFE_JE_LIEGEN, () => {
            l.liegen = l.liegen.filter((x) => x !== b);
            l.setze(z, p.ordne(z, e.folge));
          });
        }
      }
    }
  }

  if (o.tauschen) {
    for (let ai = 0; ai < ziele.length; ai++) {
      const a = ziele[ai];
      const fa = l.folgen[a] ?? [];
      for (let bi = ai + 1; bi < ziele.length; bi++) {
        const z = ziele[bi];
        const fz = l.folgen[z] ?? [];
        for (let i = 0; i < fa.length; i++) {
          if (!p.beweglich.has(fa[i])) continue;
          const ohneA = [...fa.slice(0, i), ...fa.slice(i + 1)];
          for (let j = 0; j < fz.length; j++) {
            if (!p.beweglich.has(fz[j])) continue;
            const ohneZ = [...fz.slice(0, j), ...fz.slice(j + 1)];
            const eA = l.einfuegung(a, fz[j], ohneA);
            const eZ = l.einfuegung(z, fa[i], ohneZ);
            const delta = p.tour(a, eA.folge).wert - l.wert(a) + p.tour(z, eZ.folge).wert - l.wert(z);
            nimm(delta, () => {
              l.setze(a, p.ordne(a, eA.folge));
              l.setze(z, p.ordne(z, eZ.folge));
            });
          }
        }
      }
    }
  }

  if (o.reihenfolge) {
    for (const t of quellen) {
      if (p.start[t].defekt) continue;
      const f = l.folgen[t] ?? [];
      const neu = p.ordne(t, f);
      if (neu.join() === f.join()) continue;
      nimm(p.tour(t, neu).wert - l.wert(t), () => l.setze(t, neu));
    }
  }
  return best;
}

/** Arbeitsstand → Plan (Touren mit Übergaben bleiben wie im Eingabeplan) */
function zuPlan(l: Loesung, original: Plan): Plan {
  const touren: Plan['touren'] = {};
  for (const id of l.p.tourIds) {
    if (l.p.fest.has(id)) touren[id] = structuredClone(original.touren[id]);
    else touren[id] = { schritte: (l.folgen[id] ?? []).map((b) => ({ art: 'bezirk' as const, behaelterId: b })) };
  }
  return { touren, liegenLassen: [...l.liegen] };
}

/** Plan aus einem Arbeitsstand (für Vorschläge mit wenigen Zügen) */
export function loesungZuPlan(l: Loesung, original: Plan): Plan {
  return zuPlan(l, original);
}

export function loesungAusPlan(ctx: Kontext, plan: Plan, gesperrt: string[] = []): { l: Loesung; offen: string[] } {
  return startLoesung(new Problem(ctx, plan, gesperrt), plan);
}
