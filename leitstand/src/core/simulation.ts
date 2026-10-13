/**
 * Adapter „SimulierteScanner“: spielt einen erfundenen Tag ab und erzeugt daraus nur
 * Scan-Ereignisse. Der Ist-Ablauf (wo ein Fahrzeug wirklich ist) bleibt hier drin; der
 * Leitstand sieht ausschließlich die Ereignisse.
 *
 * Damit die Simulation nicht einfach den Plan nachspielt, weicht der Ist-Ablauf leicht ab:
 * jede Tour hat ihr eigenes Tempo, Haltezeiten und Fahrzeiten streuen, und ein kleiner Teil
 * der Pakete wird nicht zugestellt.
 */
import { zufall, type Zufall } from './rng';
import { behaelterFolge, type Kontext } from './modell';
import { baueRoute, naechstesS, punktBei, sBeiZeit, teilBei, verketteRoute, verketteZeitplan, zeitBeiS, zeitplan, type Route, type RoutenSchritt, type Zeitplan } from './route';
import type { NeuesScanEreignis, ScanEreignis, ScanQuelle } from './scan';
import { paketeFuer, stoppMengen } from './sendungen';
import type { Plan, Vec2 } from './types';

export interface SimOptionen {
  seed?: number;
  /** Rollbehälter tragen ein Barcode-Etikett (sonst kein BEHAELTER_VERLADEN) */
  behaelterBarcode?: boolean;
  /** Takt der Positionsmeldungen in Minuten */
  positionTaktMin?: number;
  /** Abweichungen vom Plan (aus = Ist entspricht genau dem Rechenmodell) */
  streuung?: boolean;
  /** Anteil nicht zustellbarer Pakete */
  quoteNichtZugestellt?: number;
}

const GRUENDE = ['Empfänger nicht angetroffen', 'Annahme verweigert', 'Adresse nicht auffindbar'];
const UNGENAUIGKEIT_KM = 0.012;

interface Ablauf {
  tourId: string;
  fahrzeugId: string;
  rng: Zufall;
  tempo: number;
  beladenAb: number;
  abfahrt: number;
  ende: number;
  route: Route;
  zp: Zeitplan;
  /** Behälter, die wirklich im Fahrzeug sind */
  anBord: Set<string>;
  /** Behälter, deren Bezirk fertig zugestellt ist */
  erledigt: Set<string>;
}

type Geplant = NeuesScanEreignis & { _tour: string | null; _seq: number };

export class SimulierteScanner implements ScanQuelle {
  private abos = new Set<(e: ScanEreignis) => void>();
  private ablaeufe = new Map<string, Ablauf>();
  private offen: Geplant[] = [];
  private zeiger = 0;
  private nr = 0;
  private seq = 0;
  private ctx: Kontext;
  private opt: Required<SimOptionen>;
  zeit: number;

  constructor(ctx: Kontext, plan: Plan, opt: SimOptionen = {}, startZeit = 6 * 60 + 40) {
    this.ctx = ctx;
    this.opt = {
      seed: opt.seed ?? ctx.welt.seed + 99,
      behaelterBarcode: opt.behaelterBarcode ?? true,
      positionTaktMin: opt.positionTaktMin ?? 1,
      streuung: opt.streuung ?? true,
      quoteNichtZugestellt: opt.quoteNichtZugestellt ?? 0.035,
    };
    this.zeit = startZeit;
    const rng = zufall(this.opt.seed);
    // Paketeingang in der Basis (vor Schichtbeginn)
    const eingang: Geplant[] = [];
    for (const b of ctx.tag.behaelterIds) {
      for (const p of paketeFuer(ctx.welt, ctx.tag, b)) {
        eingang.push(this.geplant(null, { art: 'PAKET_EINGANG_BASIS', zeit: rng.zwischen(5 * 60 + 10, 6 * 60 + 35), sendung: p.id, behaelter: b, stopp: p.stoppId }));
      }
    }
    this.offen = eingang;
    ctx.tag.touren.forEach((t, i) => {
      const a = this.neuerAblauf(t.id, plan, zufall(this.opt.seed * 7 + i * 101));
      if (a) this.ablaeufe.set(t.id, a);
    });
    this.sortieren();
  }

  abonnieren(cb: (e: ScanEreignis) => void): () => void {
    this.abos.add(cb);
    return () => this.abos.delete(cb);
  }

  /** Simulationsuhr vorstellen; liefert alle neuen Ereignisse in zeitlicher Reihenfolge */
  vorspulen(bis: number): ScanEreignis[] {
    const neu: ScanEreignis[] = [];
    while (this.zeiger < this.offen.length && this.offen[this.zeiger].zeit <= bis) {
      const g = this.offen[this.zeiger++];
      const { _tour, _seq, ...rest } = g;
      void _tour;
      void _seq;
      const e = { ...rest, nr: ++this.nr } as ScanEreignis;
      neu.push(e);
      for (const cb of this.abos) cb(e);
    }
    this.zeit = Math.max(this.zeit, bis);
    return neu;
  }

  /** nächstes anstehendes Ereignis (für schnelles Vorspulen) */
  naechsteZeit(): number | null {
    return this.zeiger < this.offen.length ? this.offen[this.zeiger].zeit : null;
  }

  /**
   * Plan hat sich geändert (Umplanung). Touren an der Rampe übernehmen den neuen Plan ganz,
   * Touren unterwegs ab dem nächsten sicheren Punkt (Bezirk wird fertig zugestellt bzw.
   * nächste Kreuzung). Behälter, die nicht an Bord sind, können unterwegs nicht dazukommen.
   */
  planAktualisieren(ctx: Kontext, plan: Plan, ab: number, vorgabe?: Map<string, number>): void {
    this.ctx = ctx;
    for (const t of ctx.tag.touren) {
      const a = this.ablaeufe.get(t.id);
      if (!a || ab < a.abfahrt) {
        // noch an der Rampe: neu planen; schon Gescanntes bleibt, der Rest folgt dem neuen Plan
        this.entferneOffene(t.id, ab);
        const neu = this.neuerAblauf(t.id, plan, a?.rng ?? zufall(this.opt.seed + t.nr * 13), ab);
        if (neu) this.ablaeufe.set(t.id, neu);
        else this.ablaeufe.delete(t.id);
        continue;
      }
      if (ab >= a.ende) continue; // Tour schon beendet
      const folge = behaelterFolge(plan, t.id);
      const sJetzt = sBeiZeit(a.zp, ab);
      const teil = teilBei(a.route, sJetzt);
      let sCommit: number;
      const v = vorgabe?.get(t.id);
      if (v !== undefined && v >= sJetzt - 1e-9) sCommit = v; // Punkt, den der Leitstand vorgibt
      else if (teil?.art === 'bezirk') sCommit = teil.s1;
      else {
        const i = a.route.s.findIndex((x) => x > sJetzt + 1e-9);
        sCommit = i < 0 ? a.route.laenge : a.route.s[i];
      }
      const tCommit = zeitBeiS(a.zp, sCommit).abfahrt;
      // was ist bis zum Commit-Punkt erledigt?
      for (const tt of a.route.teile) if (tt.art === 'bezirk' && tt.s1 <= sCommit + 1e-9 && tt.behaelterId) a.erledigt.add(tt.behaelterId);
      const rest = folge.filter((b) => a.anBord.has(b) && !a.erledigt.has(b));
      const knoten = a.route.knoten[Math.min(a.route.knoten.length - 1, Math.max(0, a.route.s.findIndex((x) => x >= sCommit - 1e-9)))];
      const neueRoute = baueRoute(ctx, knoten, rest.map((b): RoutenSchritt => ({ art: 'bezirk', behaelterId: b })), true);
      const neuerZp = this.istZeitplan(neueRoute, tCommit, a);
      const route = verketteRoute(a.route, sCommit, neueRoute);
      const zp = verketteZeitplan(a.zp, sCommit, tCommit, neuerZp);
      this.entferneOffene(t.id, tCommit);
      const vorher = { ...a, route, zp };
      vorher.ende = zp.t[zp.t.length - 1];
      this.ablaeufe.set(t.id, vorher);
      this.unterwegsEreignisse(vorher, tCommit, neueRoute, neuerZp);
    }
    this.sortieren();
  }

  /** Ist-Position (nur für Tests und Fehlersuche, nie für den Leitstand) */
  wahrePosition(tourId: string, t: number): { x: number; y: number; s: number } | null {
    const a = this.ablaeufe.get(tourId);
    if (!a || t < a.abfahrt || t > a.ende) return null;
    const s = sBeiZeit(a.zp, t);
    const p = punktBei(a.route, s);
    return { x: p.x, y: p.y, s };
  }

  istAblauf(tourId: string): { abfahrt: number; ende: number; route: Route; zp: Zeitplan } | null {
    const a = this.ablaeufe.get(tourId);
    return a ? { abfahrt: a.abfahrt, ende: a.ende, route: a.route, zp: a.zp } : null;
  }

  // -------------------------------------------------------------------------------------

  private geplant(tour: string | null, e: NeuesScanEreignis): Geplant {
    return { ...e, _tour: tour, _seq: this.seq++ } as Geplant;
  }

  private sortieren(): void {
    const rest = this.offen.slice(this.zeiger).sort((a, b) => a.zeit - b.zeit || a._seq - b._seq);
    this.offen = rest;
    this.zeiger = 0;
  }

  private entferneOffene(tourId: string, nach: number): void {
    const vorher = this.offen.slice(0, this.zeiger);
    const rest = this.offen.slice(this.zeiger).filter((e) => e._tour !== tourId || e.zeit <= nach);
    this.offen = [...vorher, ...rest];
  }

  private faktor(rng: Zufall, a: number, b: number): number {
    return this.opt.streuung ? rng.zwischen(a, b) : 1;
  }

  private istZeitplan(route: Route, start: number, a: Pick<Ablauf, 'rng' | 'tempo'>): Zeitplan {
    const ann = this.ctx.annahmen;
    const mengen = new Map<string, Map<number, { pakete: number; briefe: number; zeitungen: number }>>();
    return zeitplan(route, start, {
      kmhFahrt: () => ann.tempoZwischenKmh / this.faktor(a.rng, 0.95, 1.12),
      kmhInnen: () => ann.tempoImGebietKmh / this.faktor(a.rng, 0.95, 1.08),
      halt: (st) => {
        let m = mengen.get(st.behaelterId);
        if (!m) mengen.set(st.behaelterId, (m = stoppMengen(this.ctx.welt, this.ctx.tag, st.behaelterId)));
        const x = m.get(st.stoppId)!;
        const min = x.pakete * ann.minProPaket + (x.briefe * ann.sekProBrief) / 60 + (x.zeitungen * ann.sekProZeitung) / 60;
        return min * a.tempo * this.faktor(a.rng, 0.75, 1.3);
      },
      treffpunkt: () => ann.uebergabeMin,
    });
  }

  /** Ist-Ablauf einer Tour; Ereignisse bis `nurNach` gelten als schon geschehen */
  private neuerAblauf(tourId: string, plan: Plan, rng: Zufall, nurNach = -Infinity): Ablauf | null {
    const { ctx } = this;
    const tour = ctx.tag.touren.find((t) => t.id === tourId)!;
    const start = ctx.tag.start[tourId];
    const folge = behaelterFolge(plan, tourId);
    if (!start.besetzt || folge.length === 0) return null;
    const tempo = this.faktor(rng, 0.96, 1.07);
    const beladenAb = start.schichtbeginn;
    const ladezeit = ctx.annahmen.ladezeitMin * this.faktor(rng, 0.92, 1.08);
    const abfahrt = beladenAb + ladezeit;
    const route = baueRoute(ctx, ctx.welt.basis.knoten, folge.map((b): RoutenSchritt => ({ art: 'bezirk', behaelterId: b })), true);
    const a: Ablauf = {
      tourId,
      fahrzeugId: tour.fahrzeugId,
      rng,
      tempo,
      beladenAb,
      abfahrt,
      ende: abfahrt,
      route,
      zp: { s: [0], t: [abfahrt] },
      anBord: new Set(folge),
      erledigt: new Set(),
    };
    a.zp = this.istZeitplan(route, abfahrt, a);
    a.ende = a.zp.t[a.zp.t.length - 1];

    const vorher = this.offen.length;
    // Beladen: der zuletzt zuzustellende Behälter zuerst
    const ladung = [...folge].reverse();
    ladung.forEach((b, i) => {
      const t = beladenAb + (ladezeit * (i + 0.4)) / ladung.length;
      if (this.opt.behaelterBarcode) this.offen.push(this.geplant(tourId, { art: 'BEHAELTER_VERLADEN', zeit: t, behaelter: b, fahrzeug: a.fahrzeugId }));
      const pakete = paketeFuer(ctx.welt, ctx.tag, b);
      pakete.forEach((p, j) => {
        this.offen.push(this.geplant(tourId, { art: 'PAKET_IN_FAHRZEUG', zeit: t + 0.05 + ((ladezeit / ladung.length) * 0.5 * j) / Math.max(1, pakete.length), sendung: p.id, fahrzeug: a.fahrzeugId }));
      });
    });
    this.offen.push(this.geplant(tourId, { art: 'TOUR_START', zeit: abfahrt, fahrzeug: a.fahrzeugId, tour: tourId }));
    this.unterwegsEreignisse(a, abfahrt, route, a.zp);
    if (nurNach > -Infinity) {
      const neu = this.offen.slice(vorher).filter((e) => e.zeit > nurNach);
      this.offen.length = vorher;
      this.offen.push(...neu);
    }
    return a;
  }

  /** Positionen, Zustellungen und Tourende für einen Routenabschnitt ab Zeit t0 */
  private unterwegsEreignisse(a: Ablauf, t0: number, route: Route, zp: Zeitplan): void {
    const { ctx } = this;
    const takt = this.opt.positionTaktMin;
    const ende = zp.t[zp.t.length - 1];
    // Positionen im festen Minutentakt ab Tourstart
    const ersteMinute = a.abfahrt + Math.ceil((t0 - a.abfahrt) / takt - 1e-9) * takt;
    for (let t = ersteMinute; t <= ende + 1e-9; t += takt) {
      const s = sBeiZeit(zp, t);
      const p = punktBei(route, s);
      this.offen.push(
        this.geplant(a.tourId, {
          art: 'POSITION',
          zeit: t,
          fahrzeug: a.fahrzeugId,
          x: runde(p.x + a.rng.zwischen(-UNGENAUIGKEIT_KM, UNGENAUIGKEIT_KM)),
          y: runde(p.y + a.rng.zwischen(-UNGENAUIGKEIT_KM, UNGENAUIGKEIT_KM)),
          genauigkeitM: 15,
        }),
      );
    }
    // Zustellungen an den Stopps
    const paketeJeStopp = new Map<string, Map<number, string[]>>();
    for (const st of route.stopps) {
      let m = paketeJeStopp.get(st.behaelterId);
      if (!m) {
        m = new Map();
        for (const p of paketeFuer(ctx.welt, ctx.tag, st.behaelterId)) {
          const l = m.get(p.stoppId) ?? [];
          l.push(p.id);
          m.set(p.stoppId, l);
        }
        paketeJeStopp.set(st.behaelterId, m);
      }
      const ids = m.get(st.stoppId) ?? [];
      const { ankunft, abfahrt } = zeitBeiS(zp, st.s);
      const stopp = ctx.welt.stopps[st.stoppId];
      ids.forEach((id, k) => {
        const t = ankunft + ((abfahrt - ankunft) * (k + 1)) / (ids.length + 1);
        const haus = stopp.haeuser.length ? ctx.welt.haeuser[stopp.haeuser[k % stopp.haeuser.length]] : ctx.welt.netz.knoten[stopp.knoten];
        const pos: Vec2 = { x: runde(haus.x + a.rng.zwischen(-0.008, 0.008)), y: runde(haus.y + a.rng.zwischen(-0.008, 0.008)) };
        if (this.opt.streuung && a.rng() < this.opt.quoteNichtZugestellt) {
          this.offen.push(this.geplant(a.tourId, { art: 'NICHT_ZUGESTELLT', zeit: t, sendung: id, fahrzeug: a.fahrzeugId, grund: a.rng.wahl(GRUENDE), ...pos }));
        } else {
          this.offen.push(this.geplant(a.tourId, { art: 'ZUSTELLUNG', zeit: t, sendung: id, fahrzeug: a.fahrzeugId, ...pos }));
        }
      });
    }
    this.offen.push(this.geplant(a.tourId, { art: 'TOUR_ENDE', zeit: ende, fahrzeug: a.fahrzeugId, tour: a.tourId }));
    a.ende = Math.max(a.ende, ende);
  }
}

function runde(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** Hilfe für Tests: wie weit liegt eine Meldung neben der Ist-Route? */
export function abstandZurRoute(route: Route, p: Vec2): number {
  return naechstesS(route, p).abstand;
}
