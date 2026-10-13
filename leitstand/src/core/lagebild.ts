/**
 * Lagebild: alles, was der Leitstand über den laufenden Tag weiß, berechnet ausschließlich
 * aus dem Strom der Scan-Ereignisse (plus den Plan- und Stammdaten der Basis).
 *
 *  - Fahrzeugposition: letzte POSITION-Meldungen, auf die geplante Route abgebildet
 *  - Behälter: haben keinen eigenen Tracker, ihre Position ist die ihres Fahrzeugs
 *    (Zuordnung per Verladescan oder abgeleitet aus den Ladescans ihrer Pakete)
 *  - Pakete: einzeln über Zustellscans
 *  - Briefe: werden nicht gescannt; Fortschritt geschätzt aus Position und Gangfolge
 *  - Prognosen: Soll-Zeiten des Rechenmodells, angepasst an das beobachtete Tempo
 */
import { G } from '../glossar';
import { fmtUhr } from './format';
import { addInhalt, fahrMinuten, ladungAus, leeresBisher, zustellMinuten, type Kontext } from './modell';
import {
  baueRoute,
  naechstesS,
  punktBei,
  routenSchritte,
  suchIndex,
  teilBei,
  uebergabenAbgleichen,
  verketteRoute,
  verketteZeitplan,
  zeitBeiS,
  zeitplan,
  type AbgleichEintrag,
  type Route,
  type RoutenTeil,
  type Zeitplan,
} from './route';
import type { ScanEreignis } from './scan';
import { stoppAnteil, stoppMengen } from './sendungen';
import type { Inhalt, Plan, Schritt, StartZustand, Tour } from './types';

export type FahrzeugPhase = 'rampe' | 'laedt' | 'unterwegs' | 'zurueck';
export type BehaelterLageStatus = 'halle' | 'verladen' | 'unterwegs' | 'zugestellt';

interface Fix {
  t: number;
  x: number;
  y: number;
  /** Strecke auf der Route (null = abseits der Route) */
  s: number | null;
}

export interface FahrzeugLage {
  tourId: string;
  fahrzeugId: string;
  phase: FahrzeugPhase;
  tourStart: number | null;
  tourEnde: number | null;
  beladenSeit: number | null;
  fixes: Fix[];
  /** zuverlässigster bekannter Punkt: letzte Position oder Zustellscan */
  ref: { t: number; s: number } | null;
  /** seit wann steht das Fahrzeug ungefähr an ref.s */
  stehtSeit: number | null;
  behaelter: string[];
  pakete: { geladen: number; zugestellt: number; nicht: number };
  letzterScan: number | null;
  route: Route;
  soll: Zeitplan;
  /** Soll-Zeitplan ohne Wartezeiten an Treffpunkten ab sollAbS */
  sollBasis: Zeitplan;
  sollAbS: number;
  /** Panne gemeldet: das Fahrzeug steht ab Strecke s (nach dem laufenden Bezirk) */
  defekt: { seit: number; s: number } | null;
}

export interface BehaelterLage {
  id: string;
  status: BehaelterLageStatus;
  fahrzeugId: string | null;
  tourId: string | null;
  seit: number | null;
  /** Woher wissen wir, in welchem Fahrzeug er ist? */
  quelle: 'barcode' | 'pakete' | null;
  /** zuletzt in ein anderes Fahrzeug umgeladen (Übergabe bzw. Umplanung an der Rampe) */
  umgeladen: { zeit: number; vonFahrzeug: string } | null;
}

export interface BezirkLage {
  bezirkId: string;
  behaelterId: string;
  /** Index des aktuellen Stopps in der Gangfolge (geschätzt), -1 = noch nicht begonnen */
  stoppIndex: number;
  fertig: boolean;
  pakete: { gesamt: number; zugestellt: number; nicht: number };
  /** Anteil der Briefe, die vermutlich zugestellt sind (geschätzt) */
  briefeAnteil: number;
  beginn: number | null;
  ende: number | null;
}

export interface Prognose {
  phase: FahrzeugPhase;
  statusText: string;
  /** Abfahrt: tatsächlich (nach TOUR_START) oder geplant */
  abfahrt: number;
  naechster: { name: string; art: RoutenTeil['art'] | 'basis'; ankunft: number; ende: number; vorOrt: boolean } | null;
  rueckkehr: number;
  /** 0…1 nach Soll-Zeit */
  fortschritt: number;
  /** beobachtetes Tempo (1 = wie geplant, > 1 = langsamer) */
  tempo: number;
}

export interface Pose {
  x: number;
  y: number;
  richtung: number;
  anRampe: boolean;
  /** Übergang zwischen Rampe und Route: Abfahrt (0 = Rampe … 1 = Route) bzw. Ankunft (0 = Route … 1 = Rampe) */
  uebergang: { art: 'abfahrt' | 'ankunft'; anteil: number } | null;
}

export interface Zustellung {
  t: number;
  stoppId: number;
  ok: boolean;
}

/** Zustellungen im Fenster (von, bis] – die Liste ist zeitlich sortiert */
export function zustellungenIm(liste: readonly Zustellung[], von: number, bis: number): Zustellung[] {
  let lo = 0;
  let hi = liste.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (liste[m].t <= von) lo = m + 1;
    else hi = m;
  }
  const erg: Zustellung[] = [];
  for (let i = lo; i < liste.length && liste[i].t <= bis; i++) erg.push(liste[i]);
  return erg;
}

/** Wie weit darf eine Meldung neben der Route liegen, um noch zugeordnet zu werden (km) */
const MAX_ABSTAND = 0.12;
/** Anzeigeverzögerung: Positionen kommen nur jede Minute, dazwischen wird interpoliert */
export const ANZEIGE_VERZOEGERUNG_MIN = 1;

export class Lagebild {
  ctx: Kontext;
  plan: Plan;
  private fz = new Map<string, FahrzeugLage>();
  private tourVonFahrzeug = new Map<string, Tour>();
  private beh = new Map<string, BehaelterLage>();
  private sendungen = new Map<string, { behaelter: string; stopp: number; status: 'basis' | 'fahrzeug' | 'zugestellt' | 'nicht'; fahrzeug?: string }>();
  private bez = new Map<string, BezirkLage>();
  /** Zustellscans in zeitlicher Reihenfolge (z. B. für das Leuchten der Häuser) */
  readonly zustellungen: Zustellung[] = [];
  /** Übergaben, bei denen alle Behälter im neuen Fahrzeug gescannt sind */
  readonly uebergabenErledigt = new Set<string>();
  /** Zähler je Ereignisart */
  zaehler: Record<string, number> = {};
  anzahl = 0;
  letzteZeit = 0;

  constructor(ctx: Kontext, plan: Plan) {
    this.ctx = ctx;
    this.plan = plan;
    for (const t of ctx.tag.touren) {
      this.tourVonFahrzeug.set(t.fahrzeugId, t);
      this.fz.set(t.id, {
        tourId: t.id,
        fahrzeugId: t.fahrzeugId,
        phase: 'rampe',
        tourStart: null,
        tourEnde: null,
        beladenSeit: null,
        fixes: [],
        ref: null,
        stehtSeit: null,
        behaelter: [],
        pakete: { geladen: 0, zugestellt: 0, nicht: 0 },
        letzterScan: null,
        route: baueRoute(ctx, ctx.welt.basis.knoten, []),
        soll: { s: [0], t: [0] },
        sollBasis: { s: [0], t: [0] },
        sollAbS: 0,
        defekt: null,
      });
    }
    for (const b of ctx.tag.behaelterIds) {
      this.beh.set(b, { id: b, status: 'halle', fahrzeugId: null, tourId: null, seit: null, quelle: null, umgeladen: null });
      this.bez.set(ctx.tag.behaelter[b].zielbezirk, {
        bezirkId: ctx.tag.behaelter[b].zielbezirk,
        behaelterId: b,
        stoppIndex: -1,
        fertig: false,
        pakete: { gesamt: 0, zugestellt: 0, nicht: 0 },
        briefeAnteil: 0,
        beginn: null,
        ende: null,
      });
    }
    for (const t of ctx.tag.touren) this.sollRouteNeu(t.id, null);
    this.sollAbgleichen();
  }

  // -------------------------------------------------------------------------------------
  // Soll-Route und Soll-Zeit (aus Plan und Rechenmodell)
  // -------------------------------------------------------------------------------------

  private sollZeitplan(route: Route, start: number): Zeitplan {
    const a = this.ctx.annahmen;
    const cache = new Map<string, Map<number, Inhalt>>();
    return zeitplan(route, start, {
      kmhFahrt: () => a.tempoZwischenKmh,
      kmhInnen: () => a.tempoImGebietKmh,
      halt: (st) => {
        let m = cache.get(st.behaelterId);
        if (!m) cache.set(st.behaelterId, (m = stoppMengen(this.ctx.welt, this.ctx.tag, st.behaelterId)));
        return zustellMinuten(m.get(st.stoppId)!, a).summe;
      },
      treffpunkt: () => a.uebergabeMin,
    });
  }

  private geplanteAbfahrt(tourId: string): number {
    const f = this.fz.get(tourId)!;
    const s = this.ctx.tag.start[tourId];
    return (f.beladenSeit ?? s.schichtbeginn) + this.ctx.annahmen.ladezeitMin;
  }

  /** Soll-Route einer Tour aus dem Plan (unterwegs: ab Commit-Punkt verkettet) */
  private sollRouteNeu(tourId: string, commit: { s: number; t: number } | null): void {
    const f = this.fz.get(tourId)!;
    const schritte = this.plan.touren[tourId]?.schritte ?? [];
    if (!commit) {
      f.route = baueRoute(this.ctx, this.ctx.welt.basis.knoten, routenSchritte(schritte), true);
      f.sollBasis = this.sollZeitplan(f.route, f.tourStart ?? this.geplanteAbfahrt(tourId));
      f.sollAbS = 0;
      f.soll = f.sollBasis;
      return;
    }
    const erledigt = new Set(f.route.teile.filter((x) => x.art === 'bezirk' && x.s1 <= commit.s + 1e-9).map((x) => x.behaelterId!));
    const anBord = new Set(f.behaelter);
    const rest = this.offeneSchritte(f, schritte, erledigt, anBord, commit.s);
    const knoten = f.route.knoten[Math.max(0, f.route.s.findIndex((x) => x >= commit.s - 1e-9))];
    // mit Panne: nur noch Übergaben am Standort, keine Rückfahrt
    const neu = baueRoute(this.ctx, knoten, routenSchritte(rest), !f.defekt);
    const tSoll = zeitBeiS(f.soll, commit.s).abfahrt;
    const neuZp = this.sollZeitplan(neu, tSoll);
    f.sollBasis = verketteZeitplan(f.soll, commit.s, tSoll, neuZp);
    f.soll = f.sollBasis;
    f.sollAbS = commit.s;
    f.route = verketteRoute(f.route, commit.s, neu);
  }

  /**
   * Noch offene Planschritte einer Tour unterwegs: Übergaben, die noch nicht stattgefunden
   * haben, und Bezirke für Behälter an Bord oder solche, die bei einer Übergabe dazukommen.
   */
  private offeneSchritte(f: FahrzeugLage, schritte: readonly Schritt[], erledigt: Set<string>, anBord: Set<string>, abS: number): Schritt[] {
    const rest: Schritt[] = [];
    const kommt = new Set<string>();
    for (const x of schritte) {
      if (x.art === 'uebergabe') {
        if (this.uebergabenErledigt.has(x.id)) continue;
        const teil = f.route.teile.find((y) => y.art === 'treffpunkt' && y.uebergabeId === x.id);
        if (teil && teil.s0 < abS - 1e-9) continue;
        rest.push(x);
        for (const b of x.aufnehmen) kommt.add(b);
      } else if (!f.defekt && !erledigt.has(x.behaelterId) && (anBord.has(x.behaelterId) || kommt.has(x.behaelterId))) rest.push(x);
    }
    return rest;
  }

  /**
   * Panne gemeldet (über das Gerät): Das Fahrzeug fährt den laufenden Bezirk noch zu Ende
   * bzw. bis zur nächsten Kreuzung und bleibt dann stehen. Liefert den Punkt, an dem es steht.
   */
  defektMelden(tourId: string, zeit: number): { s: number; t: number } | null {
    const f = this.fz.get(tourId);
    if (!f || f.phase !== 'unterwegs' || f.defekt) return null;
    const c = this.commitPunkt(tourId, zeit);
    f.defekt = { seit: zeit, s: c.s };
    return c;
  }

  /** Soll-Zeiten: wer zuerst am Treffpunkt ist, wartet auf den Partner */
  private sollAbgleichen(): void {
    const eintraege = new Map<string, AbgleichEintrag>();
    for (const [id, f] of this.fz) eintraege.set(id, { route: f.route, zp: f.sollBasis, abS: f.sollAbS });
    const { zeitplaene } = uebergabenAbgleichen(eintraege, this.uebergabenErledigt);
    for (const [id, zp] of zeitplaene) this.fz.get(id)!.soll = zp;
  }

  /**
   * Neuer Plan (Umplanung). Für Touren unterwegs gilt er ab dem Commit-Punkt, den der
   * Leitstand festlegt (Ende des laufenden Bezirks bzw. nächste Kreuzung voraus).
   * Liefert die Commit-Punkte, damit die Fahrer (bzw. die Simulation) dieselben nutzen.
   */
  planSetzen(ctx: Kontext, plan: Plan, zeit: number): Map<string, number> {
    this.ctx = ctx;
    this.plan = plan;
    const commits = new Map<string, number>();
    for (const t of ctx.tag.touren) {
      const f = this.fz.get(t.id)!;
      if (f.phase === 'rampe' || f.phase === 'laedt') this.sollRouteNeu(t.id, null);
      else if (f.phase === 'unterwegs') {
        const c = f.defekt ? { s: f.defekt.s, t: zeitBeiS(f.soll, f.defekt.s).ankunft } : this.commitPunkt(t.id, zeit);
        commits.set(t.id, c.s);
        this.sollRouteNeu(t.id, c);
      }
    }
    this.sollAbgleichen();
    return commits;
  }

  /** Annahmen geändert: Soll-Zeiten neu, Routen bleiben */
  annahmenSetzen(ctx: Kontext): void {
    this.ctx = ctx;
    for (const t of ctx.tag.touren) {
      const f = this.fz.get(t.id)!;
      f.sollBasis = this.sollZeitplan(f.route, f.tourStart ?? this.geplanteAbfahrt(t.id));
      f.sollAbS = 0;
    }
    this.sollAbgleichen();
  }

  // -------------------------------------------------------------------------------------
  // Ereignisse anwenden
  // -------------------------------------------------------------------------------------

  anwenden(e: ScanEreignis): void {
    this.anzahl++;
    this.zaehler[e.art] = (this.zaehler[e.art] ?? 0) + 1;
    this.letzteZeit = Math.max(this.letzteZeit, e.zeit);
    switch (e.art) {
      case 'PAKET_EINGANG_BASIS': {
        if (!this.sendungen.has(e.sendung)) {
          this.sendungen.set(e.sendung, { behaelter: e.behaelter, stopp: e.stopp, status: 'basis' });
          const bz = this.bez.get(this.ctx.tag.behaelter[e.behaelter]?.zielbezirk ?? '');
          if (bz) bz.pakete.gesamt++;
        }
        break;
      }
      case 'BEHAELTER_VERLADEN': {
        const f = this.fahrzeugLage(e.fahrzeug);
        if (f) this.behaelterVerladen(e.behaelter, f, e.zeit, 'barcode');
        break;
      }
      case 'PAKET_IN_FAHRZEUG': {
        const f = this.fahrzeugLage(e.fahrzeug);
        const p = this.sendungen.get(e.sendung);
        if (!f || !p) break;
        if (p.status === 'basis') f.pakete.geladen++;
        else if (p.status === 'fahrzeug' && p.fahrzeug && p.fahrzeug !== e.fahrzeug) {
          // umgeladen (Übergabe): zählt jetzt beim neuen Fahrzeug
          const alt = this.fahrzeugLage(p.fahrzeug);
          if (alt) alt.pakete.geladen--;
          f.pakete.geladen++;
        }
        p.status = 'fahrzeug';
        p.fahrzeug = e.fahrzeug;
        // ohne Barcode am Behälter: Zuordnung aus den Ladescans der Pakete
        const b = this.beh.get(p.behaelter);
        if (b && (b.status === 'halle' || (b.fahrzeugId !== f.fahrzeugId && b.status !== 'zugestellt'))) this.behaelterVerladen(p.behaelter, f, e.zeit, 'pakete');
        f.letzterScan = e.zeit;
        break;
      }
      case 'TOUR_START': {
        const f = this.fz.get(e.tour);
        if (!f) break;
        f.phase = 'unterwegs';
        f.tourStart = e.zeit;
        f.ref = { t: e.zeit, s: 0 };
        f.stehtSeit = e.zeit;
        // Soll-Zeit ab dem tatsächlichen Start
        const verschiebung = e.zeit - f.sollBasis.t[0];
        f.sollBasis = { s: f.sollBasis.s, t: f.sollBasis.t.map((t) => t + verschiebung) };
        this.sollAbgleichen();
        for (const b of f.behaelter) this.beh.get(b)!.status = 'unterwegs';
        break;
      }
      case 'POSITION': {
        const f = this.fahrzeugLage(e.fahrzeug);
        if (!f || f.phase !== 'unterwegs') break;
        const s = this.abbilden(f, e.x, e.y, e.zeit);
        f.fixes.push({ t: e.zeit, x: e.x, y: e.y, s });
        if (s !== null) this.fortschritt(f, s, e.zeit);
        break;
      }
      case 'ZUSTELLUNG':
      case 'NICHT_ZUGESTELLT': {
        const f = this.fahrzeugLage(e.fahrzeug);
        const p = this.sendungen.get(e.sendung);
        if (!f || !p) break;
        if (p.status === 'zugestellt' || p.status === 'nicht') break;
        p.status = e.art === 'ZUSTELLUNG' ? 'zugestellt' : 'nicht';
        const bz = this.bez.get(this.ctx.tag.behaelter[p.behaelter].zielbezirk)!;
        if (e.art === 'ZUSTELLUNG') {
          f.pakete.zugestellt++;
          bz.pakete.zugestellt++;
        } else {
          f.pakete.nicht++;
          bz.pakete.nicht++;
        }
        f.letzterScan = e.zeit;
        this.zustellungen.push({ t: e.zeit, stoppId: p.stopp, ok: e.art === 'ZUSTELLUNG' });
        // Der Zustellscan zeigt, an welchem Stopp das Fahrzeug ist
        const st = f.route.stopps.find((x) => x.stoppId === p.stopp && x.behaelterId === p.behaelter);
        if (st && f.phase === 'unterwegs') this.fortschritt(f, st.s, e.zeit);
        break;
      }
      case 'TOUR_ENDE': {
        const f = this.fz.get(e.tour);
        if (!f) break;
        f.phase = 'zurueck';
        f.tourEnde = e.zeit;
        this.fortschritt(f, f.route.laenge, e.zeit);
        break;
      }
    }
  }

  private fahrzeugLage(fahrzeugId: string): FahrzeugLage | undefined {
    const t = this.tourVonFahrzeug.get(fahrzeugId);
    return t ? this.fz.get(t.id) : undefined;
  }

  private behaelterVerladen(id: string, f: FahrzeugLage, zeit: number, quelle: 'barcode' | 'pakete'): void {
    const b = this.beh.get(id);
    if (!b) return;
    if (b.fahrzeugId && b.fahrzeugId !== f.fahrzeugId) {
      const alt = this.fahrzeugLage(b.fahrzeugId);
      if (alt) alt.behaelter = alt.behaelter.filter((x) => x !== id);
      b.umgeladen = { zeit, vonFahrzeug: b.fahrzeugId };
    }
    if (!f.behaelter.includes(id)) f.behaelter.push(id);
    b.status = f.phase === 'unterwegs' ? 'unterwegs' : 'verladen';
    b.fahrzeugId = f.fahrzeugId;
    b.tourId = f.tourId;
    b.seit = b.seit ?? zeit;
    if (quelle === 'barcode' || !b.quelle) b.quelle = quelle;
    // Übergabe erledigt, sobald alle übernommenen Behälter im Fahrzeug sind
    for (const x of this.plan.touren[f.tourId]?.schritte ?? []) {
      if (x.art !== 'uebergabe' || !x.aufnehmen.includes(id) || this.uebergabenErledigt.has(x.id)) continue;
      if (x.aufnehmen.every((y) => f.behaelter.includes(y))) this.uebergabenErledigt.add(x.id);
    }
    if (f.phase === 'rampe') {
      f.phase = 'laedt';
      f.beladenSeit = zeit;
      this.sollRouteNeu(f.tourId, null);
      this.sollAbgleichen();
    }
  }

  /**
   * Meldung auf die Route abbilden. Gesucht wird nur vorwärts und nur so weit, wie das
   * Fahrzeug seit der letzten Meldung höchstens gekommen sein kann. Gibt es mehrere fast
   * gleich gute Stellen (dieselbe Straße wird später noch einmal befahren, Sackgasse hin
   * und zurück), gilt die früheste: lieber kurz zurückhängen als falsch vorspringen.
   */
  private abbilden(f: FahrzeugLage, x: number, y: number, t: number): number | null {
    const sAlt = f.ref?.s ?? 0;
    const tAlt = f.ref?.t ?? t;
    const sMax = sAlt + ((Math.max(0, t - tAlt) + 0.5) / 60) * 52 + 0.1;
    const sMin = Math.max(0, sAlt - 0.02);
    const best = naechstesS(f.route, { x, y }, sMin, sMax);
    if (best.abstand > MAX_ABSTAND) return null;
    const grenze = best.abstand + 0.025;
    const i0 = suchIndex(f.route.s, sMin);
    for (let i = i0; i < f.route.punkte.length - 1 && f.route.s[i] <= sMax; i++) {
      const a = f.route.punkte[i];
      const b = f.route.punkte[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
      const s = f.route.s[i] + (f.route.s[i + 1] - f.route.s[i]) * u;
      if (s < sMin || s > sMax) continue;
      if (Math.hypot(x - (a.x + dx * u), y - (a.y + dy * u)) <= grenze) return Math.max(sAlt, s);
    }
    return Math.max(sAlt, best.s);
  }

  /** Fortschritt eines Fahrzeugs bis Strecke s zur Zeit t verbuchen */
  private fortschritt(f: FahrzeugLage, s: number, t: number): void {
    const vorher = f.ref?.s ?? 0;
    if (s < vorher) s = vorher;
    if (!f.ref || s - vorher > 0.03) f.stehtSeit = t;
    f.ref = { t: Math.max(t, f.ref?.t ?? t), s };
    // Bezirke: begonnen, Stopp-Index, fertig
    for (const teil of f.route.teile) {
      if (teil.art !== 'bezirk' || !teil.bezirkId) continue;
      const bz = this.bez.get(teil.bezirkId)!;
      if (s >= teil.s0 - 1e-6 && bz.beginn === null && s > teil.s0 + 0.005) bz.beginn = t;
      if (s >= teil.s1 - 1e-6 || (s > teil.s1 - 0.01 && t === f.tourEnde)) {
        if (!bz.fertig && bz.beginn !== null) {
          bz.fertig = true;
          bz.ende = t;
          bz.stoppIndex = this.ctx.welt.bezirke[teil.bezirkId].stopps.length - 1;
          bz.briefeAnteil = 1;
          const b = this.beh.get(teil.behaelterId!);
          if (b) b.status = 'zugestellt';
        }
        continue;
      }
      if (s < teil.s0) continue;
      const stopps = f.route.stopps.filter((x) => x.behaelterId === teil.behaelterId && x.s >= teil.s0 - 1e-9 && x.s <= teil.s1 + 1e-9);
      let k = -1;
      for (const st of stopps) if (st.s <= s + 0.005) k = st.index;
      if (k > bz.stoppIndex) bz.stoppIndex = k;
      bz.briefeAnteil = Math.max(bz.briefeAnteil, this.briefeAnteil(teil.bezirkId, bz.stoppIndex));
    }
  }

  /** Geschätzter Anteil zugestellter Briefe, wenn das Fahrzeug an Stopp k steht */
  private briefeAnteil(bezirkId: string, k: number): number {
    if (k < 0) return 0;
    const stopps = this.ctx.welt.bezirke[bezirkId].stopps;
    let a = 0;
    for (let j = 0; j < k && j < stopps.length; j++) a += stoppAnteil(this.ctx.welt, stopps[j]);
    if (k < stopps.length) a += 0.5 * stoppAnteil(this.ctx.welt, stopps[k]);
    return Math.min(1, a);
  }

  // -------------------------------------------------------------------------------------
  // Abfragen
  // -------------------------------------------------------------------------------------

  fahrzeug(tourId: string): FahrzeugLage {
    return this.fz.get(tourId)!;
  }

  behaelter(id: string): BehaelterLage {
    return this.beh.get(id)!;
  }

  bezirk(id: string): BezirkLage {
    return this.bez.get(id)!;
  }

  /** Position zur Anzeige: zwischen den Meldungen entlang der Route interpoliert */
  pose(tourId: string, zeit: number): Pose {
    const f = this.fz.get(tourId)!;
    const anzeige = zeit - ANZEIGE_VERZOEGERUNG_MIN;
    const rampe: Pose = { x: NaN, y: NaN, richtung: 0, anRampe: true, uebergang: null };
    if (f.phase === 'rampe' || f.phase === 'laedt' || f.tourStart === null) return rampe;
    // Panne: nach dem Abmelden bleibt das Fahrzeug, wo es steht (wird abgeschleppt)
    if (f.defekt && f.phase === 'zurueck') return { ...punktBei(f.route, f.route.laenge), anRampe: false, uebergang: null };
    // Rückkehr: noch eine Minute vom Hof an die Rampe
    if (f.phase === 'zurueck' && f.tourEnde !== null && anzeige >= f.tourEnde) {
      const anteil = (anzeige - f.tourEnde) / ANZEIGE_VERZOEGERUNG_MIN;
      if (anteil >= 1) return rampe;
      return { ...punktBei(f.route, f.route.laenge), anRampe: false, uebergang: { art: 'ankunft', anteil } };
    }
    // Abfahrt: in der ersten Minute von der Rampe auf den Hof
    if (anzeige < f.tourStart) {
      const anteil = Math.max(0, Math.min(1, (zeit - f.tourStart) / ANZEIGE_VERZOEGERUNG_MIN));
      return { ...punktBei(f.route, 0), anRampe: false, uebergang: { art: 'abfahrt', anteil } };
    }
    const fx = f.fixes;
    if (fx.length === 0) return { ...punktBei(f.route, 0), anRampe: false, uebergang: null };
    let i = fx.length - 1;
    while (i > 0 && fx[i].t > anzeige) i--;
    const a = fx[i];
    const b = fx[i + 1];
    if (!b || anzeige <= a.t) {
      if (a.s !== null) return { ...punktBei(f.route, a.s), anRampe: false, uebergang: null };
      return { x: a.x, y: a.y, richtung: 0, anRampe: false, uebergang: null };
    }
    const u = Math.max(0, Math.min(1, (anzeige - a.t) / (b.t - a.t)));
    if (a.s !== null && b.s !== null) return { ...punktBei(f.route, a.s + (b.s - a.s) * u), anRampe: false, uebergang: null };
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, richtung: Math.atan2(b.y - a.y, b.x - a.x), anRampe: false, uebergang: null };
  }

  /** gefahrene Strecke laut Anzeige (für Spuren) */
  anzeigeS(tourId: string, zeit: number): number {
    const f = this.fz.get(tourId)!;
    if (f.phase === 'rampe' || f.phase === 'laedt') return 0;
    if (f.phase === 'zurueck' && f.tourEnde !== null && zeit - ANZEIGE_VERZOEGERUNG_MIN >= f.tourEnde) return f.route.laenge;
    const anzeige = zeit - ANZEIGE_VERZOEGERUNG_MIN;
    const fx = f.fixes;
    let i = fx.length - 1;
    while (i >= 0 && (fx[i].s === null || fx[i].t > anzeige)) i--;
    if (i < 0) return 0;
    const a = fx[i];
    let j = i + 1;
    while (j < fx.length && fx[j].s === null) j++;
    const b = fx[j];
    if (!b || anzeige <= a.t) return a.s!;
    return a.s! + (b.s! - a.s!) * Math.max(0, Math.min(1, (anzeige - a.t) / (b.t - a.t)));
  }

  /** Soll-Zeit an der bekannten Stelle, unter Berücksichtigung einer laufenden Haltezeit */
  private sollJetzt(f: FahrzeugLage): number {
    const ref = f.ref!;
    const z = zeitBeiS(f.soll, ref.s);
    const gestanden = Math.max(0, ref.t - (f.stehtSeit ?? ref.t));
    return Math.min(z.ankunft + gestanden, z.abfahrt);
  }

  private tempo(f: FahrzeugLage): number {
    if (!f.ref || f.tourStart === null) return 1;
    const ist = f.ref.t - f.tourStart;
    const soll = this.sollJetzt(f) - f.soll.t[0];
    if (ist < 20 || soll < 10) return 1;
    return Math.max(0.85, Math.min(1.3, ist / soll));
  }

  /** Erwartete Ankunft an Strecke s (für Prognosen) */
  ankunftBei(tourId: string, s: number): number {
    const f = this.fz.get(tourId)!;
    if (f.phase === 'rampe' || f.phase === 'laedt' || !f.ref) return zeitBeiS(f.soll, s).ankunft;
    if (f.phase === 'zurueck') return f.tourEnde!;
    const jetzt = this.sollJetzt(f);
    return f.ref.t + Math.max(0, zeitBeiS(f.soll, s).ankunft - jetzt) * this.tempo(f);
  }

  prognose(tourId: string, zeit: number): Prognose {
    const f = this.fz.get(tourId)!;
    const s = this.ctx.tag.start[tourId];
    const leer: Prognose = { phase: f.phase, statusText: '', abfahrt: f.tourStart ?? f.soll.t[0], naechster: null, rueckkehr: zeit, fortschritt: 0, tempo: 1 };
    if (!s.besetzt) return { ...leer, statusText: 'Unbesetzt' };
    if (f.defekt) {
      const steht = (f.ref?.s ?? 0) >= f.defekt.s - 0.02;
      const offen = f.route.teile.some((x) => x.art === 'treffpunkt' && x.uebergabeId && !this.uebergabenErledigt.has(x.uebergabeId));
      const text = f.phase === 'zurueck' ? `Panne – abgemeldet` : !steht ? `Panne gemeldet – fährt den ${G.bezirk} noch zu Ende` : offen ? `Panne – ${G.behaelterPlural} werden übergeben` : `Panne – steht seit ${fmtUhr(f.defekt.seit)}`;
      return { ...leer, phase: f.phase, statusText: text, abfahrt: f.tourStart ?? leer.abfahrt, rueckkehr: f.tourEnde ?? this.ankunftBei(tourId, f.route.laenge) };
    }
    if (f.route.teile.length <= 1 && f.phase === 'rampe') return { ...leer, statusText: `Ohne ${G.behaelterPlural}` };
    const ende = this.ankunftBei(tourId, f.route.laenge);
    const t0 = f.soll.t[0];
    const tEnde = f.soll.t[f.soll.t.length - 1];
    if (f.phase === 'zurueck') return { ...leer, statusText: `Zurück an der ${G.zustellbasis}`, rueckkehr: f.tourEnde!, fortschritt: 1 };
    const sRef = f.ref?.s ?? 0;
    const tempo = this.tempo(f);
    const fortschritt = f.ref ? Math.max(0, Math.min(1, (this.sollJetzt(f) - t0) / Math.max(1, tEnde - t0))) : 0;
    // nächster bzw. laufender Bezirk/Treffpunkt
    const aktuell = teilBei(f.route, sRef);
    let ziel: RoutenTeil | undefined;
    let vorOrt = false;
    if (f.phase === 'unterwegs' && aktuell?.art === 'bezirk' && sRef > aktuell.s0 + 0.005 && sRef < aktuell.s1 - 1e-6) {
      ziel = aktuell;
      vorOrt = true;
    } else ziel = f.route.teile.find((x) => x.art !== 'fahrt' && x.s0 > sRef + 0.005);
    const naechster = ziel
      ? { name: ziel.name, art: ziel.art, ankunft: this.ankunftBei(tourId, ziel.s0), ende: this.ankunftBei(tourId, ziel.s1), vorOrt }
      : { name: G.zustellbasis, art: 'basis' as const, ankunft: ende, ende, vorOrt: false };
    const amTreffpunkt = f.route.teile.find(
      (x) => x.art === 'treffpunkt' && x.uebergabeId && !this.uebergabenErledigt.has(x.uebergabeId) && Math.abs(x.s0 - sRef) < 0.02,
    );
    let statusText: string;
    if (f.phase === 'rampe') statusText = `An ${G.rampe}`;
    else if (f.phase === 'laedt') statusText = `Wird beladen (${f.behaelter.length} von ${ladungAus(this.plan.touren[tourId]?.schritte ?? []).length} ${G.behaelterPlural})`;
    else if (amTreffpunkt) statusText = `Übergabe am ${amTreffpunkt.name}`;
    else if (vorOrt) statusText = `Stellt zu in ${ziel!.name}`;
    else if (naechster.art === 'basis') statusText = `Rückfahrt zur ${G.zustellbasis}`;
    else statusText = `Fährt nach ${naechster.name}`;
    return { phase: f.phase, statusText, abfahrt: f.tourStart ?? f.soll.t[0], naechster, rueckkehr: ende, fortschritt, tempo };
  }

  // -------------------------------------------------------------------------------------
  // Startzustände für Rechenmodell und Optimierer (Umplanung ab jetzt)
  // -------------------------------------------------------------------------------------

  /** Sicherer Punkt, ab dem eine Umplanung gilt: Ende des laufenden Bezirks bzw. Kreuzung voraus */
  commitPunkt(tourId: string, zeit: number): { s: number; t: number } {
    const f = this.fz.get(tourId)!;
    const sRef = f.ref?.s ?? 0;
    const teil = teilBei(f.route, sRef);
    if (teil?.art === 'bezirk' && sRef < teil.s1 - 1e-6) return { s: teil.s1, t: this.ankunftBei(tourId, teil.s1) };
    // Fahrt: etwas voraus (Meldungen sind bis zu einer Minute alt), dann nächster Knoten
    const voraus = sRef + ((Math.max(0, zeit - (f.ref?.t ?? zeit)) + 1.5) / 60) * this.ctx.annahmen.tempoZwischenKmh * 1.2;
    const i = f.route.s.findIndex((x) => x >= Math.min(voraus, f.route.laenge));
    let s = i < 0 ? f.route.laenge : f.route.s[i];
    // nicht über einen Treffpunkt hinaus, an dem noch eine Übergabe ansteht
    const tp = f.route.teile.find((x) => x.art === 'treffpunkt' && x.uebergabeId && !this.uebergabenErledigt.has(x.uebergabeId) && x.s0 >= sRef - 1e-9 && x.s0 < s);
    if (tp) s = tp.s0;
    const t2 = teilBei(f.route, s);
    if (t2?.art === 'bezirk' && s > t2.s0 + 1e-6) return { s: t2.s1, t: this.ankunftBei(tourId, t2.s1) };
    return { s, t: this.ankunftBei(tourId, s) };
  }

  /** Startzustände aller Touren ab jetzt, nur aus dem Lagebild */
  startZustaende(zeit: number): Record<string, StartZustand> {
    const { tag, annahmen: a, welt } = this.ctx;
    const erg: Record<string, StartZustand> = {};
    for (const t of tag.touren) {
      const morgen = tag.start[t.id];
      const f = this.fz.get(t.id)!;
      if (f.phase === 'rampe' || f.phase === 'laedt') {
        erg[t.id] = morgen;
        continue;
      }
      const c = f.defekt
        ? { s: f.defekt.s, t: Math.max(zeit, this.ankunftBei(t.id, f.defekt.s)) }
        : f.phase === 'zurueck'
          ? { s: f.route.laenge, t: f.tourEnde! }
          : this.commitPunkt(t.id, zeit);
      const bisher = leeresBisher();
      for (const teil of f.route.teile) {
        const l = Math.max(0, Math.min(teil.s1, c.s) - teil.s0);
        if (teil.art === 'bezirk') bisher.kmInnen += l;
        else bisher.kmZwischen += l;
      }
      const erledigt = f.route.teile.filter((x) => x.art === 'bezirk' && x.s1 <= c.s + 1e-9).map((x) => x.behaelterId!);
      let menge: Inhalt = { pakete: 0, briefe: 0, zeitungen: 0 };
      for (const b of erledigt) menge = addInhalt(menge, tag.behaelter[b].inhalt);
      bisher.menge = menge;
      bisher.min.laden = f.tourStart! - morgen.schichtbeginn;
      bisher.min.fahrtZwischen = fahrMinuten(bisher.kmZwischen, a.tempoZwischenKmh);
      bisher.min.fahrtInnen = fahrMinuten(bisher.kmInnen, a.tempoImGebietKmh);
      bisher.min.zustellung = Math.max(0, c.t - f.tourStart! - bisher.min.fahrtZwischen - bisher.min.fahrtInnen);
      const zurueck = f.phase === 'zurueck' && !f.defekt;
      const knotenIdx = Math.max(0, f.route.s.findIndex((x) => x >= c.s - 1e-9));
      erg[t.id] = {
        ...morgen,
        zeit: c.t,
        knoten: zurueck ? welt.basis.knoten : f.route.knoten[knotenIdx],
        mussLaden: false,
        geladen: zurueck ? [] : f.behaelter.filter((b) => !erledigt.includes(b)),
        erledigt: zurueck ? [...new Set([...erledigt, ...f.behaelter])] : erledigt,
        defekt: !!f.defekt,
        bisher,
        // dasselbe Tempo wie in den Prognosen des Lagebilds (Rückkehr, Ankunft am Bezirk)
        tempo: zurueck || f.defekt ? 1 : this.tempo(f),
      };
    }
    return erg;
  }

  /** Nur noch die offenen Schritte des Tagesplans (für Rechenmodell und Optimierer ab jetzt) */
  restplan(start: Record<string, StartZustand>): Plan {
    const touren: Plan['touren'] = {};
    const liegen = new Set(this.plan.liegenLassen);
    for (const t of this.ctx.tag.touren) {
      const s = start[t.id];
      const fertig = new Set(s.erledigt);
      const kommt = new Set<string>();
      const schritte: Schritt[] = [];
      for (const x of this.plan.touren[t.id]?.schritte ?? []) {
        if (x.art === 'uebergabe') {
          if (this.uebergabenErledigt.has(x.id)) continue;
          schritte.push(x);
          for (const b of x.aufnehmen) kommt.add(b);
          continue;
        }
        if (fertig.has(x.behaelterId)) continue;
        // ohne Fahrer bzw. mit Panne kann die Tour nichts mehr zustellen: bleibt liegen, bis umgeplant wird
        if (!s.besetzt || s.defekt) {
          liegen.add(x.behaelterId);
          continue;
        }
        if (s.mussLaden || s.geladen.includes(x.behaelterId) || kommt.has(x.behaelterId)) schritte.push(x);
        else liegen.add(x.behaelterId); // unterwegs, aber nicht an Bord: bleibt heute liegen
      }
      touren[t.id] = { schritte };
    }
    const erledigtAlle = new Set(Object.values(start).flatMap((s) => s.erledigt));
    return { touren, liegenLassen: [...liegen].filter((b) => !erledigtAlle.has(b)) };
  }
}

/** Tagesplan = erledigte Schritte (Bezirke und Übergaben) + neuer Restplan */
export function zusammenfuehren(tagesplan: Plan, restplan: Plan, start: Record<string, StartZustand>, uebergabenErledigt: ReadonlySet<string> = new Set()): Plan {
  const touren: Plan['touren'] = {};
  for (const id of Object.keys(tagesplan.touren)) {
    const fertig = new Set(start[id]?.erledigt ?? []);
    const vorher = (tagesplan.touren[id]?.schritte ?? []).filter((x) => (x.art === 'bezirk' ? fertig.has(x.behaelterId) : uebergabenErledigt.has(x.id)));
    touren[id] = { schritte: [...vorher, ...(restplan.touren[id]?.schritte ?? [])] };
  }
  return { touren, liegenLassen: [...restplan.liegenLassen] };
}
