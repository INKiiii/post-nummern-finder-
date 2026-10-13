/**
 * Schnittstellen zu den „Live“-Quellen. Im Prototyp ist alles simuliert; echte Quellen
 * (Telematik, Tourdaten, Messenger) können später dieselben Schnittstellen erfüllen.
 */
import type { Ereignis, Plan, Tag, Welt } from './types';

/** Fahrzeugpositionen (nur Fahrzeugebene, nur während der Schicht) */
export interface VehiclePositionSource {
  /** Positionsupdates abonnieren; gibt eine Abmeldefunktion zurück */
  abonnieren(cb: (e: Extract<Ereignis, { typ: 'position' }>) => void): () => void;
}

/** Tourdaten des Tages: Welt (Basis, Bezirke, Straßennetz), Behälter, Touren, Startplan */
export interface TourDataSource {
  ladeTag(optionen?: { mengenFaktor?: number }): Promise<{ welt: Welt; tag: Tag; plan: Plan }>;
}

/** Nachrichten an Fahrer und Bestätigungen zurück */
export interface NotificationSink {
  senden(e: Extract<Ereignis, { typ: 'nachricht' | 'bestaetigung' }>): void;
  abonnieren(cb: (e: Ereignis) => void): () => void;
  schliessen(): void;
}
