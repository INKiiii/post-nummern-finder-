/**
 * Regie für den Demo-Modus: führt ein Drehbuch Schritt für Schritt aus, zeigt Untertitel
 * und lässt sich anhalten, überspringen und beenden. Während der Pause steht auch die
 * Simulationsuhr.
 */
import { create } from 'zustand';
import { useAnsicht } from '../../state/ansicht';
import { useLeitstand } from '../../state/store';
import { useRechenwegDialog } from '../Rechenweg';

export interface DemoZustand {
  aktiv: boolean;
  pausiert: boolean;
  /** Drehbuch zu Ende (Untertitel bleibt mit „Nochmal“ und „Schließen“ stehen) */
  fertig: boolean;
  schritt: number;
  anzahl: number;
  titel: string;
  text: string;
  /** Fortschritt im aktuellen Schritt, 0…1 */
  anteil: number;
}

export const useDemo = create<DemoZustand>(() => ({ aktiv: false, pausiert: false, fertig: false, schritt: 0, anzahl: 0, titel: '', text: '', anteil: 0 }));

export interface Regie {
  /** ein Schritt: `fn` ausführen, danach warten, bis `dauerMs` (ohne Pausen) vergangen sind */
  schritt: (dauerMs: number, fn: () => Promise<void> | void) => Promise<void>;
  zeige: (titel: string, text: string) => void;
  /** warten (zählt zum Schritt; steht in der Pause; endet beim Überspringen sofort) */
  warte: (ms: number) => Promise<void>;
  /** warten, bis die Bedingung gilt (höchstens maxMs) */
  wartenAuf: (bedingung: () => boolean, maxMs: number) => Promise<boolean>;
  /** Simulationsuhr mit diesem Tempo laufen lassen */
  uhr: (tempo: number) => void;
  uhrStopp: () => void;
}

export interface Drehbuch {
  anzahl: number;
  ablauf: (r: Regie) => Promise<void>;
  ende: { titel: string; text: string };
}

class Abbruch extends Error {}

let lauf = 0;
let ueberspringen: (() => void) | null = null;
/** lief die Uhr, als die Demo angehalten wurde? */
let uhrNachPause = false;
let fahrerSimulierenVorher = true;

function uhrAnhalten(): void {
  const l = useLeitstand.getState();
  if (l.laeuft) l.startPause();
}

function regie(token: number): Regie {
  let nr = -1;
  let dauer = 1;
  let vergangen = 0;
  let uebersprungen = -1;
  const pruefen = () => {
    if (token !== lauf) throw new Abbruch();
  };

  /** Überspringen: der laufende Schritt endet, seine weiteren Wartezeiten entfallen */
  let warteEnde: (() => void) | null = null;
  const sprung = () => {
    uebersprungen = nr;
    warteEnde?.();
  };

  const warte = (ms: number) =>
    new Promise<void>((ok, fehler) => {
      if (token !== lauf) return fehler(new Abbruch());
      if (uebersprungen === nr || ms <= 0) return ok();
      let rest = ms;
      let letzte = performance.now();
      const fertig = () => {
        window.clearInterval(id);
        warteEnde = null;
      };
      const id = window.setInterval(() => {
        if (token !== lauf) {
          fertig();
          fehler(new Abbruch());
          return;
        }
        const jetzt = performance.now();
        if (!useDemo.getState().pausiert) {
          const dt = Math.min(jetzt - letzte, rest);
          rest -= dt;
          vergangen += dt;
          useDemo.setState({ anteil: Math.min(1, vergangen / dauer) });
        }
        letzte = jetzt;
        if (rest <= 0) {
          fertig();
          ok();
        }
      }, 50);
      warteEnde = () => {
        fertig();
        ok();
      };
    });

  return {
    schritt: async (dauerMs, fn) => {
      pruefen();
      nr++;
      dauer = dauerMs;
      vergangen = 0;
      ueberspringen = sprung;
      useDemo.setState({ schritt: nr, anteil: 0 });
      await fn();
      pruefen();
      await warte(dauer - vergangen);
    },
    zeige: (titel, text) => {
      pruefen();
      useDemo.setState({ titel, text });
    },
    warte,
    wartenAuf: async (bedingung, maxMs) => {
      const t0 = performance.now();
      let letzte = t0;
      while (!bedingung()) {
        pruefen();
        if (uebersprungen === nr || performance.now() - t0 > maxMs) return false;
        await new Promise((r) => setTimeout(r, 100));
        // zählt zur Dauer des Schritts (nicht in der Pause)
        const jetzt = performance.now();
        if (!useDemo.getState().pausiert) {
          vergangen += jetzt - letzte;
          useDemo.setState({ anteil: Math.min(1, vergangen / dauer) });
        }
        letzte = jetzt;
      }
      pruefen();
      return true;
    },
    uhr: (tempo) => {
      pruefen();
      const l = useLeitstand.getState();
      l.tempoSetzen(tempo);
      if (useDemo.getState().pausiert) uhrNachPause = true;
      else if (!l.laeuft) l.startPause();
    },
    uhrStopp: () => {
      pruefen();
      uhrNachPause = false;
      uhrAnhalten();
    },
  };
}

export async function demoStarten(d: Drehbuch): Promise<void> {
  const token = ++lauf;
  ueberspringen = null;
  uhrNachPause = false;
  if (!useDemo.getState().aktiv) fahrerSimulierenVorher = useLeitstand.getState().fahrerSimulieren;
  useDemo.setState({ aktiv: true, pausiert: false, fertig: false, schritt: 0, anzahl: d.anzahl, titel: 'Demo', text: 'Einen Moment …', anteil: 0 });
  if (window.location.hash && window.location.hash !== '#/') window.location.hash = '#/';
  try {
    await d.ablauf(regie(token));
    if (token !== lauf) return;
    uhrAnhalten();
    useDemo.setState({ fertig: true, schritt: d.anzahl - 1, anteil: 1, ...d.ende });
  } catch (e) {
    if (e instanceof Abbruch || token !== lauf) return;
    uhrAnhalten();
    useDemo.setState({ fertig: true, titel: 'Demo unterbrochen', text: e instanceof Error ? e.message : String(e) });
  }
}

export function demoPauseUmschalten(): void {
  const d = useDemo.getState();
  if (!d.aktiv || d.fertig) return;
  const l = useLeitstand.getState();
  if (!d.pausiert) {
    uhrNachPause = l.laeuft;
    uhrAnhalten();
    useDemo.setState({ pausiert: true });
  } else {
    useDemo.setState({ pausiert: false });
    if (uhrNachPause && !l.laeuft && !l.vorschau) l.startPause();
    uhrNachPause = false;
  }
}

/** zum nächsten Schritt */
export function demoWeiter(): void {
  const d = useDemo.getState();
  if (!d.aktiv || d.fertig) return;
  if (d.pausiert) demoPauseUmschalten();
  ueberspringen?.();
}

export function demoBeenden(): void {
  if (!useDemo.getState().aktiv) return;
  lauf++;
  ueberspringen = null;
  uhrAnhalten();
  useRechenwegDialog.getState().schliessen();
  useAnsicht.getState().folgenSetzen(null);
  useLeitstand.getState().fahrerSimulierenSetzen(fahrerSimulierenVorher);
  useDemo.setState({ aktiv: false, pausiert: false, fertig: false, titel: '', text: '', anteil: 0 });
}
