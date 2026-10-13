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
  /** Kamera folgt diesem Fahrzeug (Tour-ID) */
  folgen: string | null;
  /** Handy: das nächste angetippte Fahrzeug übernimmt diesen Behälter */
  zielWahl: { behaelterId: string } | null;
  /** Laptop: dieser Behälter wird gerade auf ein Fahrzeug gezogen (Ziel unter dem Mauszeiger) */
  ziehen: { behaelterId: string; ziel: Auswahl } | null;
  /** kurze Meldung unten in der Mitte */
  hinweis: { text: string; nr: number } | null;
  /** Wunsch von außen (Demo): Blatt am Handy ein- oder ausklappen */
  blattWunsch: { offen: boolean; nr: number } | null;
  /** Zoom per Knopf (Handy): Abstand × faktor */
  zoom: { faktor: number; nr: number } | null;
  /** Wunsch von außen (Demo): Vorschläge bzw. Szenarien rechts (Handy: im Blatt) zeigen */
  seitenWunsch: { ansicht: SeitenAnsicht; nr: number } | null;

  waehlen: (a: Auswahl) => void;
  hovern: (a: Auswahl) => void;
  fliegen: (f: Omit<Flug, 'nr'>) => void;
  draufsichtSetzen: (an: boolean) => void;
  qualitaetSetzen: (q: Qualitaet) => void;
  tourDaecherSetzen: (an: boolean) => void;
  kameraAbstandSetzen: (d: number) => void;
  tippSetzen: (t: string | null) => void;
  folgenSetzen: (tourId: string | null) => void;
  zielWahlSetzen: (z: { behaelterId: string } | null) => void;
  ziehenSetzen: (z: { behaelterId: string; ziel: Auswahl } | null) => void;
  hinweisSetzen: (text: string | null) => void;
  seiteZeigen: (ansicht: SeitenAnsicht) => void;
  zoomen: (faktor: number) => void;
  blattSetzen: (offen: boolean) => void;
}

export type SeitenAnsicht = 'vorschlaege' | 'szenarien';

let flugNr = 0;
let hinweisNr = 0;
let seitenNr = 0;
let zoomNr = 0;

export const useAnsicht = create<AnsichtZustand>((set, get) => ({
  auswahl: null,
  hover: null,
  draufsicht: false,
  flug: null,
  qualitaet: startQualitaet(),
  tourDaecher: true,
  kameraAbstand: 1200,
  tipp: null,
  folgen: null,
  zielWahl: null,
  ziehen: null,
  hinweis: null,
  seitenWunsch: null,
  zoom: null,
  blattWunsch: null,

  waehlen: (auswahl) => set({ auswahl, folgen: auswahl?.art === 'fahrzeug' && auswahl.id === get().folgen ? get().folgen : null }),
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
  folgenSetzen: (folgen) => set({ folgen }),
  zielWahlSetzen: (zielWahl) => set({ zielWahl }),
  ziehenSetzen: (ziehen) => {
    const alt = get().ziehen;
    if (alt && ziehen && alt.behaelterId === ziehen.behaelterId && gleicheAuswahl(alt.ziel, ziehen.ziel)) return;
    set({ ziehen });
  },
  hinweisSetzen: (text) => set({ hinweis: text ? { text, nr: ++hinweisNr } : null }),
  seiteZeigen: (ansicht) => set({ auswahl: null, seitenWunsch: { ansicht, nr: ++seitenNr } }),
  zoomen: (faktor) => set({ zoom: { faktor, nr: ++zoomNr } }),
  blattSetzen: (offen) => set({ blattWunsch: { offen, nr: ++zoomNr } }),
  tippSetzen: (tipp) => {
    if (get().tipp !== tipp) set({ tipp });
  },
}));

export function gleicheAuswahl(a: Auswahl, b: Auswahl): boolean {
  return !!a && !!b && a.art === b.art && a.id === b.id;
}
