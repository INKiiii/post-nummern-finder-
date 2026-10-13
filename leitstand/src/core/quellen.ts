/**
 * Schnittstellen zu den Datenquellen. Im Prototyp ist alles simuliert; echte Quellen
 * können dieselben Schnittstellen erfüllen, ohne dass der Leitstand sich ändert.
 *
 *  - TourDataSource: Stamm- und Tagesdaten (Bezirke, Gangfolge, Touren, Behälter, Mengen)
 *  - ScanQuelle: Strom der Scan-Ereignisse (siehe scan.ts) – einzige Quelle für die Lage
 *  - VehiclePositionSource: die POSITION-Meldungen aus dem Scan-Strom
 *  - FahrerGeraet: Nachrichten an das Gerät der Tour und Bestätigungen zurück
 */
import type { ScanEreignis, ScanQuelle } from './scan';
import type { Plan, Tag, Welt } from './types';

export type { ScanQuelle };

export interface TourDataSource {
  ladeTag(optionen?: { mengenFaktor?: number }): Promise<{ welt: Welt; tag: Tag; plan: Plan }>;
}

export type PositionsMeldung = Extract<ScanEreignis, { art: 'POSITION' }>;

/** Fahrzeugpositionen: nur Fahrzeugebene, nur während der Tour (Teil des Scan-Stroms) */
export interface VehiclePositionSource {
  abonnieren(cb: (e: PositionsMeldung) => void): () => void;
}

export function positionenAus(q: ScanQuelle): VehiclePositionSource {
  return {
    abonnieren: (cb) => q.abonnieren((e) => e.art === 'POSITION' && cb(e)),
  };
}

export interface FahrerNachricht {
  id: string;
  tourId: string;
  /** Simulationszeit (Minuten) */
  zeit: number;
  titel: string;
  text: string;
  bestaetigungNoetig: boolean;
}

export type GeraeteMeldung =
  | { art: 'bestaetigung'; nachrichtId: string; tourId: string; zeit: number }
  | { art: 'angemeldet'; tourId: string; geraetId: string }
  | { art: 'abgemeldet'; tourId: string; geraetId: string };

/** Gerät der Tour (im Prototyp: Ansicht im Stil einer Scanner-App) */
export interface FahrerGeraet {
  senden(n: FahrerNachricht): void;
  abonnieren(cb: (m: GeraeteMeldung) => void): () => void;
  schliessen(): void;
}
