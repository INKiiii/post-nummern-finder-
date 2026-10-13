/**
 * Zentraler Zustand des Leitstands (zustand).
 *
 * Der Rechenkern bleibt UI-frei. Hier laufen zusammen:
 *  - Plan, Annahmen und Verlauf (Rückgängig/Wiederholen)
 *  - die Simulationsuhr und der Adapter „SimulierteScanner“ (erzeugt nur Scan-Ereignisse)
 *  - das Lagebild, das ausschließlich aus diesen Ereignissen berechnet wird
 *  - Prognose und Vorschläge ab jetzt (Startzustände aus dem Lagebild)
 *  - das Fahrergerät (Nachrichten und Bestätigungen)
 */
import { create } from 'zustand';
import { standardAnnahmen, type Annahmen, type AnnahmeSchluessel } from '../config';
import { DemoTourDataSource } from '../core/demoQuelle';
import { Lagebild, zusammenfuehren } from '../core/lagebild';
import { bewertePlan, erstelleKontext, vergleiche, type Delta, type Kontext, type PlanAuswertung } from '../core/modell';
import type { FahrerNachricht, TourDataSource } from '../core/quellen';
import type { ScanEreignis } from '../core/scan';
import { SimulierteScanner } from '../core/simulation';
import type { Plan, StartZustand, Tag, Welt } from '../core/types';
import { neueUebergaben, type UebergabeInfo } from '../core/uebergabe';
import { planDiff, type Aenderung, type Vorschlag, type VorschlagArt } from '../core/vorschlaege';
import { BroadcastFahrerGeraet } from '../geraet/kanal';
import { KernClient } from '../worker/kernClient';

export interface VerlaufEintrag {
  plan: Plan;
  label: string;
}

export const TAG_BEGINN = 6 * 60 + 40;
export const TAG_ENDE = 18 * 60;
export const TEMPI = [1, 5, 15, 60, 240] as const;

/** Uhr für die Szene: wird jedes Bild aktualisiert, ohne React neu zu rendern */
export const simUhr = { zeit: TAG_BEGINN };

export type LogEintrag =
  | { quelle: 'scan'; e: ScanEreignis }
  | { quelle: 'geraet'; nr: number; zeit: number; art: 'NACHRICHT' | 'BESTAETIGUNG' | 'GERAET'; tourId: string; text: string };

export interface GesendeteNachricht extends FahrerNachricht {
  bestaetigt: number | null;
}

/** Vorschau einer Umplanung: noch nicht übernommen, in 3D und als Karte sichtbar */
export interface Vorschau {
  titel: string;
  text?: string;
  art: VorschlagArt | 'andereTour' | 'tauschen';
  /** neuer Restplan (ab jetzt, zum Live-Kontext) */
  rest: Plan;
  /** Tagesplan nach dem Übernehmen */
  tagesplan: Plan;
  alt: PlanAuswertung;
  neu: PlanAuswertung;
  delta: Delta;
  aenderungen: Aenderung[];
  reihenfolge: string[];
  uebergaben: UebergabeInfo[];
  wiederkehrend: boolean;
  warnung?: string;
}

interface LeitstandZustand {
  welt: Welt | null;
  tag: Tag | null;
  startplan: Plan | null;
  plan: Plan | null;
  annahmen: Annahmen;
  ctx: Kontext | null;
  /** Bewertung des aktuellen Plans für einen ganzen Tag (Planung, Ersparnis) */
  auswertung: PlanAuswertung | null;
  startAuswertung: PlanAuswertung | null;
  verlauf: VerlaufEintrag[];
  verlaufIndex: number;
  vorschlaege: Vorschlag[];
  vorschlaegeLaden: boolean;
  fehler: string | null;

  // Simulation und Lage
  zeit: number;
  laeuft: boolean;
  tempo: number;
  lage: Lagebild | null;
  /** zählt hoch, wenn sich das Lagebild geändert hat (für React) */
  lageVersion: number;
  log: LogEintrag[];
  behaelterBarcode: boolean;
  /** Startzustände, Kontext und Restplan ab jetzt (aus dem Lagebild) */
  startLive: Record<string, StartZustand> | null;
  ctxLive: Kontext | null;
  restplan: Plan | null;
  /** Prognose für den Tag: Erledigtes + Restplan */
  prognose: PlanAuswertung | null;
  nachrichten: GesendeteNachricht[];
  /** zuletzt gemeldete Geräte (Tour → Zeitpunkt, Date.now) */
  geraete: Record<string, number>;
  vorschau: Vorschau | null;

  laden: (quelle?: TourDataSource) => Promise<void>;
  planSetzen: (plan: Plan, label: string) => void;
  vorschlagUebernehmen: (v: Vorschlag) => void;
  restplanUebernehmen: (rest: Plan, label: string) => void;
  rueckgaengig: () => void;
  wiederholen: () => void;
  zumStartplan: () => void;
  annahmeSetzen: (k: AnnahmeSchluessel, v: number) => void;
  annahmenZuruecksetzen: () => void;

  ticken: (dtSek: number) => void;
  startPause: () => void;
  tempoSetzen: (t: number) => void;
  zeitSetzen: (t: number) => void;
  tagNeuStarten: () => void;
  barcodeSetzen: (an: boolean) => void;
  nachrichtSenden: (tourId: string, titel: string, text: string) => void;
  /** Vorschau für einen neuen Restplan bauen (null, wenn ungültig) */
  vorschauBauen: (rest: Plan, titel: string, art: Vorschau['art'], text?: string) => Vorschau | null;
  vorschauAusVorschlag: (v: Vorschlag) => Vorschau | null;
  /** Vorschau zeigen (hält die Uhr an) bzw. schließen */
  vorschauSetzen: (v: Vorschau | null) => void;
  vorschauUebernehmen: () => void;
}

let kern: KernClient | null = null;
let vorschlagAnfrage = 0;
let vorschlagTimer: ReturnType<typeof setTimeout> | null = null;
let sim: SimulierteScanner | null = null;
let geraet: BroadcastFahrerGeraet | null = null;
/** Pläne mit Zeitpunkt (für das Zurückspulen) */
let chronik: Array<{ zeit: number; plan: Plan; label: string }> = [];
const scansJeTour = new Map<string, ScanEreignis[]>();
let letzteUi = 0;
let letzteZeitPost = 0;
let letzteLive = -Infinity;
let geraeteNr = 0;
let nachrichtNr = 0;
/** lief die Uhr, bevor die Vorschau sie angehalten hat? */
let laufVorVorschau = false;

export const useLeitstand = create<LeitstandZustand>((set, get) => {
  /** Kontext und Planbewertung (ganzer Tag) neu berechnen */
  const planBewerten = () => {
    const { welt, tag, plan, startplan, annahmen } = get();
    if (!welt || !tag || !plan || !startplan) return;
    const ctx = erstelleKontext(welt, tag, annahmen);
    set({ ctx, auswertung: bewertePlan(ctx, plan), startAuswertung: bewertePlan(ctx, startplan) });
  };

  /** Lage ab jetzt: Startzustände, Restplan, Prognose; Vorschläge im Worker */
  const liveAktualisieren = () => {
    const { ctx, lage } = get();
    if (!ctx || !lage) return;
    const start = lage.startZustaende(simUhr.zeit);
    const ctxLive: Kontext = { ...ctx, tag: { ...ctx.tag, start } };
    const rest = lage.restplan(start);
    set({ startLive: start, ctxLive, restplan: rest, prognose: bewertePlan(ctxLive, rest) });
    letzteLive = simUhr.zeit;
    vorschlaegeAnstossen();
  };

  const vorschlaegeAnstossen = () => {
    if (vorschlagTimer) clearTimeout(vorschlagTimer);
    set({ vorschlaegeLaden: true });
    vorschlagTimer = setTimeout(async () => {
      const { ctxLive, restplan, annahmen } = get();
      if (!kern || !ctxLive || !restplan) return;
      const nr = ++vorschlagAnfrage;
      try {
        const vorAbfahrt = Object.values(ctxLive.tag.start).every((s) => s.mussLaden);
        const liste = await kern.vorschlaege({ tag: ctxLive.tag, plan: restplan, annahmen }, vorAbfahrt);
        if (nr === vorschlagAnfrage) set({ vorschlaege: liste, vorschlaegeLaden: false });
      } catch (e) {
        if (nr === vorschlagAnfrage) set({ vorschlaegeLaden: false, fehler: String(e) });
      }
    }, 150);
  };

  const logAnhaengen = (eintraege: LogEintrag[]) => {
    if (!eintraege.length) return;
    const log = [...get().log, ...eintraege];
    set({ log: log.length > 400 ? log.slice(log.length - 400) : log });
  };

  /** Ereignisse bis t verarbeiten (ohne UI-Aktualisierung) */
  const verarbeitenBis = (t: number, spiegeln = true): ScanEreignis[] => {
    const { lage, ctx } = get();
    if (!sim || !lage || !ctx) return [];
    const neu = sim.vorspulen(t);
    for (const e of neu) {
      lage.anwenden(e);
      if (e.art === 'PAKET_EINGANG_BASIS') continue;
      const tourId = 'tour' in e ? e.tour : ctx.tag.touren.find((x) => x.fahrzeugId === (e as { fahrzeug: string }).fahrzeug)?.id;
      if (!tourId) continue;
      let l = scansJeTour.get(tourId);
      if (!l) scansJeTour.set(tourId, (l = []));
      l.push(e);
      if (spiegeln) geraet?.post({ typ: 'scan', tourId, e });
    }
    simUhr.zeit = t;
    return neu;
  };

  /** Simulation und Lagebild für den Tag neu aufbauen (Plan aus der Chronik) */
  const tagAufbauen = (bis: number) => {
    const { welt, tag, annahmen, behaelterBarcode } = get();
    if (!welt || !tag || !chronik.length) return;
    const ctx = erstelleKontext(welt, tag, annahmen);
    // die „Wirklichkeit“ hängt nicht von den Annahmen im UI ab
    const ctxWahr = erstelleKontext(welt, tag, standardAnnahmen());
    sim = new SimulierteScanner(ctxWahr, chronik[0].plan, { behaelterBarcode });
    const lage = new Lagebild(ctx, chronik[0].plan);
    scansJeTour.clear();
    set({ lage, log: [] });
    const gueltig = chronik.filter((c, i) => i === 0 || c.zeit <= bis);
    for (const c of gueltig.slice(1)) {
      verarbeitenBis(c.zeit, false);
      const commits = lage.planSetzen(ctx, c.plan, c.zeit);
      sim.planAktualisieren(ctxWahr, c.plan, c.zeit, commits);
    }
    chronik = gueltig;
    const neu = verarbeitenBis(bis, false);
    const ende = neu.slice(-150).map((e): LogEintrag => ({ quelle: 'scan', e }));
    const plan = gueltig[gueltig.length - 1].plan;
    set({ zeit: bis, plan, log: ende, lageVersion: get().lageVersion + 1 });
    geraet?.post({ typ: 'neustart' });
    planBewerten();
    liveAktualisieren();
  };

  const tourDatenSenden = () => {
    const { plan, tag } = get();
    if (!plan || !tag) return;
    for (const t of tag.touren) geraet?.post({ typ: 'tour', tourId: t.id, plan: plan.touren[t.id] ?? { schritte: [] } });
  };

  const geraetEinrichten = () => {
    if (geraet) return;
    geraet = new BroadcastFahrerGeraet();
    geraet.abonnieren((m) => {
      const { nachrichten, geraete } = get();
      if (m.art === 'bestaetigung') {
        set({ nachrichten: nachrichten.map((n) => (n.id === m.nachrichtId && n.bestaetigt === null ? { ...n, bestaetigt: m.zeit } : n)) });
        const n = nachrichten.find((x) => x.id === m.nachrichtId);
        logAnhaengen([{ quelle: 'geraet', nr: ++geraeteNr, zeit: simUhr.zeit, art: 'BESTAETIGUNG', tourId: m.tourId, text: `„${n?.titel ?? 'Nachricht'}“ verstanden` }]);
      }
      if (m.art === 'angemeldet') {
        set({ geraete: { ...geraete, [m.tourId]: Date.now() } });
        logAnhaengen([{ quelle: 'geraet', nr: ++geraeteNr, zeit: simUhr.zeit, art: 'GERAET', tourId: m.tourId, text: 'Gerät verbunden' }]);
      }
      if (m.art === 'abgemeldet') {
        const g = { ...geraete };
        delete g[m.tourId];
        set({ geraete: g });
      }
    });
    geraet.onGeraet = (m) => {
      const { plan, nachrichten, zeit, laeuft, tempo } = get();
      if (m.typ === 'lebenszeichen') set({ geraete: { ...get().geraete, [m.tourId]: Date.now() } });
      if (m.typ !== 'anmelden' || !plan) return;
      geraet!.post({ typ: 'tour', tourId: m.tourId, plan: plan.touren[m.tourId] ?? { schritte: [] } });
      geraet!.post({
        typ: 'verlauf',
        tourId: m.tourId,
        scans: scansJeTour.get(m.tourId) ?? [],
        nachrichten: nachrichten.filter((n) => n.tourId === m.tourId),
        bestaetigt: nachrichten.filter((n) => n.tourId === m.tourId && n.bestaetigt !== null).map((n) => n.id),
      });
      geraet!.post({ typ: 'zeit', zeit, laeuft, tempo });
    };
  };

  return {
    welt: null,
    tag: null,
    startplan: null,
    plan: null,
    annahmen: standardAnnahmen(),
    ctx: null,
    auswertung: null,
    startAuswertung: null,
    verlauf: [],
    verlaufIndex: 0,
    vorschlaege: [],
    vorschlaegeLaden: false,
    fehler: null,
    zeit: TAG_BEGINN,
    laeuft: false,
    tempo: 15,
    lage: null,
    lageVersion: 0,
    log: [],
    behaelterBarcode: true,
    startLive: null,
    ctxLive: null,
    restplan: null,
    prognose: null,
    nachrichten: [],
    geraete: {},
    vorschau: null,

    laden: async (quelle = new DemoTourDataSource()) => {
      const { welt, tag, plan } = await quelle.ladeTag();
      kern ??= new KernClient();
      await kern.setzeWelt(welt);
      geraetEinrichten();
      chronik = [{ zeit: -Infinity, plan, label: 'Startplan' }];
      set({ welt, tag, startplan: plan, plan, verlauf: [{ plan, label: 'Startplan' }], verlaufIndex: 0 });
      planBewerten();
      tagAufbauen(TAG_BEGINN);
      tourDatenSenden();
    },

    planSetzen: (plan, label) => {
      get().vorschauSetzen(null);
      const { verlauf, verlaufIndex, lage, ctx } = get();
      const neu = [...verlauf.slice(0, verlaufIndex + 1), { plan, label }];
      set({ plan, verlauf: neu, verlaufIndex: neu.length - 1 });
      planAnwenden(plan, label, lage, ctx);
    },

    vorschlagUebernehmen: (v) => {
      get().restplanUebernehmen(v.plan, v.titel);
    },

    restplanUebernehmen: (rest, label) => {
      const { plan, startLive, lage } = get();
      if (!plan || !startLive) return;
      get().planSetzen(zusammenfuehren(plan, rest, startLive, lage?.uebergabenErledigt), label);
    },

    vorschauBauen: (rest, titel, art, text) => {
      const { ctxLive, restplan, prognose, plan, startLive, lage, annahmen } = get();
      if (!ctxLive || !restplan || !prognose || !plan || !startLive) return null;
      const neu = bewertePlan(ctxLive, rest);
      if (!neu.gueltig) return null;
      const diff = planDiff(ctxLive, restplan, rest);
      return {
        titel,
        text,
        art,
        rest,
        tagesplan: zusammenfuehren(plan, rest, startLive, lage?.uebergabenErledigt),
        alt: prognose,
        neu,
        delta: vergleiche(prognose, neu, annahmen),
        aenderungen: diff.aenderungen,
        reihenfolge: diff.reihenfolge,
        uebergaben: neueUebergaben(ctxLive, restplan, rest, neu),
        wiederkehrend: Object.values(startLive).every((x) => x.mussLaden),
      };
    },

    vorschauAusVorschlag: (v) => {
      const x = get().vorschauBauen(v.plan, v.titel, v.art, v.text);
      return x ? { ...x, warnung: v.warnung, wiederkehrend: v.wiederkehrend } : null;
    },

    vorschauSetzen: (v) => {
      const { vorschau, laeuft } = get();
      if (v && !vorschau) {
        laufVorVorschau = laeuft;
        set({ vorschau: v, laeuft: false });
        geraet?.post({ typ: 'zeit', zeit: simUhr.zeit, laeuft: false, tempo: get().tempo });
      } else if (v) set({ vorschau: v });
      else if (vorschau) {
        set({ vorschau: null, laeuft: laufVorVorschau && simUhr.zeit < TAG_ENDE });
        laufVorVorschau = false;
      }
    },

    vorschauUebernehmen: () => {
      const v = get().vorschau;
      if (!v) return;
      get().restplanUebernehmen(v.rest, v.titel);
      get().vorschauSetzen(null);
    },

    rueckgaengig: () => {
      get().vorschauSetzen(null);
      const { verlauf, verlaufIndex, lage, ctx } = get();
      if (verlaufIndex <= 0) return;
      const e = verlauf[verlaufIndex - 1];
      set({ plan: e.plan, verlaufIndex: verlaufIndex - 1 });
      planAnwenden(e.plan, `Rückgängig: ${verlauf[verlaufIndex].label}`, lage, ctx);
    },

    wiederholen: () => {
      get().vorschauSetzen(null);
      const { verlauf, verlaufIndex, lage, ctx } = get();
      if (verlaufIndex >= verlauf.length - 1) return;
      const e = verlauf[verlaufIndex + 1];
      set({ plan: e.plan, verlaufIndex: verlaufIndex + 1 });
      planAnwenden(e.plan, e.label, lage, ctx);
    },

    zumStartplan: () => {
      const { startplan, plan } = get();
      if (!startplan || plan === startplan) return;
      get().planSetzen(startplan, 'Zurück zum Startplan');
    },

    annahmeSetzen: (k, v) => {
      if (!Number.isFinite(v)) return;
      set({ annahmen: { ...get().annahmen, [k]: v } });
      planBewerten();
      const { ctx, lage } = get();
      if (ctx && lage) lage.annahmenSetzen(ctx);
      liveAktualisieren();
    },

    annahmenZuruecksetzen: () => {
      set({ annahmen: standardAnnahmen() });
      planBewerten();
      const { ctx, lage } = get();
      if (ctx && lage) lage.annahmenSetzen(ctx);
      liveAktualisieren();
    },

    ticken: (dtSek) => {
      const { laeuft, tempo } = get();
      if (!laeuft || !sim) return;
      const t = Math.min(TAG_ENDE, simUhr.zeit + (dtSek * tempo) / 60);
      const neu = verarbeitenBis(t);
      const wichtig = neu.some((e) => e.art === 'TOUR_START' || e.art === 'TOUR_ENDE' || e.art === 'BEHAELTER_VERLADEN');
      const jetzt = performance.now();
      if (neu.length) logAnhaengen(neu.slice(-200).map((e): LogEintrag => ({ quelle: 'scan', e })));
      if (jetzt - letzteUi > 100 || wichtig) {
        letzteUi = jetzt;
        set({ zeit: t, lageVersion: get().lageVersion + 1, laeuft: t < TAG_ENDE });
      }
      if (jetzt - letzteZeitPost > 500) {
        letzteZeitPost = jetzt;
        geraet?.post({ typ: 'zeit', zeit: t, laeuft: true, tempo });
      }
      if (wichtig || t - letzteLive >= 5) liveAktualisieren();
    },

    startPause: () => {
      // mit offener Vorschau: Start heißt Vorschau verwerfen
      if (get().vorschau) {
        laufVorVorschau = false;
        set({ vorschau: null });
      }
      const laeuft = !get().laeuft && simUhr.zeit < TAG_ENDE;
      set({ laeuft });
      geraet?.post({ typ: 'zeit', zeit: simUhr.zeit, laeuft, tempo: get().tempo });
    },

    tempoSetzen: (tempo) => set({ tempo }),

    zeitSetzen: (t) => {
      if (get().vorschau) get().vorschauSetzen(null);
      const ziel = Math.max(TAG_BEGINN, Math.min(TAG_ENDE, t));
      if (ziel >= simUhr.zeit) {
        const neu = verarbeitenBis(ziel, false);
        logAnhaengen(neu.slice(-150).map((e): LogEintrag => ({ quelle: 'scan', e })));
        set({ zeit: ziel, lageVersion: get().lageVersion + 1 });
        geraet?.post({ typ: 'neustart' });
        liveAktualisieren();
      } else {
        // zurück: Tag aus den Ereignissen neu abspielen (spätere Umplanungen entfallen)
        tagAufbauen(ziel);
        const plaene = chronik.map((c) => ({ plan: c.plan, label: c.label }));
        set({ verlauf: plaene, verlaufIndex: plaene.length - 1 });
      }
    },

    tagNeuStarten: () => {
      get().vorschauSetzen(null);
      const { startplan } = get();
      if (!startplan) return;
      chronik = [{ zeit: -Infinity, plan: startplan, label: 'Startplan' }];
      set({ laeuft: false, nachrichten: [], verlauf: [{ plan: startplan, label: 'Startplan' }], verlaufIndex: 0 });
      tagAufbauen(TAG_BEGINN);
    },

    barcodeSetzen: (an) => {
      get().vorschauSetzen(null);
      set({ behaelterBarcode: an });
      tagAufbauen(simUhr.zeit);
    },

    nachrichtSenden: (tourId, titel, text) => {
      const n: GesendeteNachricht = { id: `N${++nachrichtNr}`, tourId, zeit: simUhr.zeit, titel, text, bestaetigungNoetig: true, bestaetigt: null };
      set({ nachrichten: [...get().nachrichten, n] });
      geraet?.senden(n);
      logAnhaengen([{ quelle: 'geraet', nr: ++geraeteNr, zeit: simUhr.zeit, art: 'NACHRICHT', tourId, text: `${titel}: ${text}` }]);
    },
  };

  /** neuen Plan in Lagebild und Simulation übernehmen (gilt ab jetzt) */
  function planAnwenden(plan: Plan, label: string, lage: Lagebild | null, ctx: Kontext | null) {
    planBewerten();
    if (lage && ctx && sim) {
      const t = simUhr.zeit;
      const beginn = Math.min(...ctx.tag.touren.map((x) => ctx.tag.start[x.id].schichtbeginn));
      if (t < beginn) {
        // vor Schichtbeginn: gilt als Plan des Tages
        chronik = [{ zeit: -Infinity, plan, label }];
        tagAufbauen(t);
      } else {
        const ctxWahr = erstelleKontext(ctx.welt, ctx.tag, standardAnnahmen());
        const commits = lage.planSetzen(ctx, plan, t);
        sim.planAktualisieren(ctxWahr, plan, t, commits);
        chronik.push({ zeit: t, plan, label });
        set({ lageVersion: get().lageVersion + 1 });
        liveAktualisieren();
      }
    }
    tourDatenSenden();
  }
});
