/**
 * Zustand der Ansicht: Auswahl, Hover, Kamera (Flug, 3D/Draufsicht), Grafikqualität.
 */
import { create } from 'zustand';

export type Auswahl =
  | { art: 'behaelter'; id: string }
  | { art: 'fahrzeug'; id: string }
  | { art: 'bezirk'; id: string }
  | { art: 'basis'; id: 'basis' }
  | null;

export interface Flug {
  ziel: [number, number, number];
  distanz?: number;
  polar?: number;
  azimut?: number;
  /** false: Ziel nicht wegen des Handy-Blatts nach oben rücken */
  versatz?: boolean;
  nr: number;
}

export type Qualitaet = 'hoch' | 'niedrig';

function startQualitaet(): Qualitaet {
  if (typeof window === 'undefined') return 'hoch';
  const grob = window.matchMedia?.('(pointer: coarse)').matches;
  return grob || window.innerWidth < 820 ? 'niedrig' : 'hoch';
}

interface AnsichtZustand {
  auswahl: Auswahl;
  hover: Auswahl;
  draufsicht: boolean;
  flug: Flug | null;
  qualitaet: Qualitaet;
  /** Dächer der Bezirke in der Farbe ihrer Tour */
  tourDaecher: boolean;
  /** Kameraabstand zum Ziel (für Größen und Beschriftungen) */
  kameraAbstand: number;
  /** kurzer Hinweis am Mauszeiger (Ankerpunkt „tipp“) */
  tipp: string | null;

  waehlen: (a: Auswahl) => void;
  hovern: (a: Auswahl) => void;
  fliegen: (f: Omit<Flug, 'nr'>) => void;
  draufsichtSetzen: (an: boolean) => void;
  qualitaetSetzen: (q: Qualitaet) => void;
  tourDaecherSetzen: (an: boolean) => void;
  kameraAbstandSetzen: (d: number) => void;
  tippSetzen: (t: string | null) => void;
}

let flugNr = 0;

export const useAnsicht = create<AnsichtZustand>((set, get) => ({
  auswahl: null,
  hover: null,
  draufsicht: false,
  flug: null,
  qualitaet: startQualitaet(),
  tourDaecher: true,
  kameraAbstand: 1200,
  tipp: null,

  waehlen: (auswahl) => set({ auswahl }),
  hovern: (hover) => {
    const h = get().hover;
    if (h?.art === hover?.art && h?.id === hover?.id) return;
    set({ hover });
  },
  fliegen: (f) => set({ flug: { ...f, nr: ++flugNr } }),
  draufsichtSetzen: (draufsicht) => set({ draufsicht }),
  qualitaetSetzen: (qualitaet) => set({ qualitaet }),
  tourDaecherSetzen: (tourDaecher) => set({ tourDaecher }),
  kameraAbstandSetzen: (d) => {
    // nur spürbare Änderungen melden, damit React nicht jedes Bild neu rendert
    const alt = get().kameraAbstand;
    if (Math.abs(Math.log(d / alt)) > 0.08) set({ kameraAbstand: d });
  },
  tippSetzen: (tipp) => {
    if (get().tipp !== tipp) set({ tipp });
  },
}));

export function gleicheAuswahl(a: Auswahl, b: Auswahl): boolean {
  return !!a && !!b && a.art === b.art && a.id === b.id;
}
