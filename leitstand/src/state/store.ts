/**
 * Zentraler Zustand des Leitstands (zustand).
 * Der Rechenkern bleibt UI-frei; hier werden Plan, Annahmen und Verlauf (Rückgängig/Wiederholen)
 * verwaltet und Auswertung bzw. Vorschläge aktuell gehalten.
 */
import { create } from 'zustand';
import { standardAnnahmen, type Annahmen, type AnnahmeSchluessel } from '../config';
import { DemoTourDataSource } from '../core/demoQuelle';
import { bewertePlan, erstelleKontext, type Kontext, type PlanAuswertung } from '../core/modell';
import type { TourDataSource } from '../core/quellen';
import type { Plan, Tag, Welt } from '../core/types';
import type { Vorschlag } from '../core/vorschlaege';
import { KernClient } from '../worker/kernClient';

export interface VerlaufEintrag {
  plan: Plan;
  label: string;
}

interface LeitstandZustand {
  welt: Welt | null;
  tag: Tag | null;
  startplan: Plan | null;
  plan: Plan | null;
  annahmen: Annahmen;
  ctx: Kontext | null;
  auswertung: PlanAuswertung | null;
  /** Auswertung des Startplans (Vergleichsbasis „seit Start“) */
  startAuswertung: PlanAuswertung | null;
  verlauf: VerlaufEintrag[];
  verlaufIndex: number;
  vorschlaege: Vorschlag[];
  vorschlaegeLaden: boolean;
  fehler: string | null;

  laden: (quelle?: TourDataSource) => Promise<void>;
  planSetzen: (plan: Plan, label: string) => void;
  rueckgaengig: () => void;
  wiederholen: () => void;
  zumStartplan: () => void;
  annahmeSetzen: (k: AnnahmeSchluessel, v: number) => void;
  annahmenZuruecksetzen: () => void;
}

let kern: KernClient | null = null;
let vorschlagAnfrage = 0;
let vorschlagTimer: ReturnType<typeof setTimeout> | null = null;

export const useLeitstand = create<LeitstandZustand>((set, get) => {
  /** Kontext und Auswertung neu berechnen, Vorschläge im Worker anstoßen */
  const aktualisieren = () => {
    const { welt, tag, plan, startplan, annahmen } = get();
    if (!welt || !tag || !plan || !startplan) return;
    const ctx = erstelleKontext(welt, tag, annahmen);
    set({ ctx, auswertung: bewertePlan(ctx, plan), startAuswertung: bewertePlan(ctx, startplan) });
    vorschlaegeAnstossen();
  };

  const vorschlaegeAnstossen = () => {
    if (vorschlagTimer) clearTimeout(vorschlagTimer);
    set({ vorschlaegeLaden: true });
    vorschlagTimer = setTimeout(async () => {
      const { tag, plan, annahmen } = get();
      if (!kern || !tag || !plan) return;
      const nr = ++vorschlagAnfrage;
      try {
        const liste = await kern.vorschlaege({ tag, plan, annahmen }, true);
        if (nr === vorschlagAnfrage) set({ vorschlaege: liste, vorschlaegeLaden: false });
      } catch (e) {
        if (nr === vorschlagAnfrage) set({ vorschlaegeLaden: false, fehler: String(e) });
      }
    }, 120);
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

    laden: async (quelle = new DemoTourDataSource()) => {
      const { welt, tag, plan } = await quelle.ladeTag();
      kern ??= new KernClient();
      await kern.setzeWelt(welt);
      set({ welt, tag, startplan: plan, plan, verlauf: [{ plan, label: 'Startplan' }], verlaufIndex: 0 });
      aktualisieren();
    },

    planSetzen: (plan, label) => {
      const { verlauf, verlaufIndex } = get();
      const neu = [...verlauf.slice(0, verlaufIndex + 1), { plan, label }];
      set({ plan, verlauf: neu, verlaufIndex: neu.length - 1 });
      aktualisieren();
    },

    rueckgaengig: () => {
      const { verlauf, verlaufIndex } = get();
      if (verlaufIndex <= 0) return;
      set({ plan: verlauf[verlaufIndex - 1].plan, verlaufIndex: verlaufIndex - 1 });
      aktualisieren();
    },

    wiederholen: () => {
      const { verlauf, verlaufIndex } = get();
      if (verlaufIndex >= verlauf.length - 1) return;
      set({ plan: verlauf[verlaufIndex + 1].plan, verlaufIndex: verlaufIndex + 1 });
      aktualisieren();
    },

    zumStartplan: () => {
      const { startplan, plan } = get();
      if (!startplan || plan === startplan) return;
      get().planSetzen(startplan, 'Zurück zum Startplan');
    },

    annahmeSetzen: (k, v) => {
      if (!Number.isFinite(v)) return;
      set({ annahmen: { ...get().annahmen, [k]: v } });
      aktualisieren();
    },

    annahmenZuruecksetzen: () => {
      set({ annahmen: standardAnnahmen() });
      aktualisieren();
    },
  };
});
