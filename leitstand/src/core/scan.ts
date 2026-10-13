/**
 * Scan-Ereignisse: der einzige Datenstrom, aus dem der Leitstand die Lage berechnet.
 * Alle Ereignisse entstehen heute schon bei der Arbeit (Scans am Handscanner, Anmeldung,
 * Standort des Geräts). Nur BEHAELTER_VERLADEN braucht optional ein Barcode-Etikett am
 * Rollbehälter; ohne Etikett wird die Zuordnung aus den Ladescans der Pakete abgeleitet.
 */

export type ScanArt =
  | 'PAKET_EINGANG_BASIS'
  | 'BEHAELTER_VERLADEN'
  | 'PAKET_IN_FAHRZEUG'
  | 'TOUR_START'
  | 'POSITION'
  | 'ZUSTELLUNG'
  | 'NICHT_ZUGESTELLT'
  | 'TOUR_ENDE';

interface Basis {
  /** laufende Nummer im Strom */
  nr: number;
  /** Minuten ab 0:00 */
  zeit: number;
}

export type ScanEreignis =
  | (Basis & { art: 'PAKET_EINGANG_BASIS'; sendung: string; behaelter: string; stopp: number })
  | (Basis & { art: 'BEHAELTER_VERLADEN'; behaelter: string; fahrzeug: string })
  | (Basis & { art: 'PAKET_IN_FAHRZEUG'; sendung: string; fahrzeug: string })
  | (Basis & { art: 'TOUR_START'; fahrzeug: string; tour: string })
  | (Basis & { art: 'POSITION'; fahrzeug: string; x: number; y: number; genauigkeitM: number })
  | (Basis & { art: 'ZUSTELLUNG'; sendung: string; fahrzeug: string; x: number; y: number })
  | (Basis & { art: 'NICHT_ZUGESTELLT'; sendung: string; fahrzeug: string; grund: string; x: number; y: number })
  | (Basis & { art: 'TOUR_ENDE'; fahrzeug: string; tour: string });

/** Ereignis ohne Nummer (vergibt die Quelle) */
export type NeuesScanEreignis = ScanEreignis extends infer E ? (E extends ScanEreignis ? Omit<E, 'nr'> : never) : never;

export const SCAN_ARTEN: ScanArt[] = [
  'PAKET_EINGANG_BASIS',
  'BEHAELTER_VERLADEN',
  'PAKET_IN_FAHRZEUG',
  'TOUR_START',
  'POSITION',
  'ZUSTELLUNG',
  'NICHT_ZUGESTELLT',
  'TOUR_ENDE',
];

export interface ScanInfo {
  /** Wo entsteht das Ereignis heute? */
  quelle: string;
  /** Kurzbeschreibung */
  text: string;
  farbe: string;
  /** braucht etwas Neues? */
  neu?: string;
}

export const SCAN_INFO: Record<ScanArt, ScanInfo> = {
  PAKET_EINGANG_BASIS: { quelle: 'Eingangsscan in der Basis', text: 'Paket kommt an und wird einem Behälter zugeordnet', farbe: '#64748b' },
  BEHAELTER_VERLADEN: {
    quelle: 'Verladescan an der Rampe',
    text: 'Rollbehälter wird in ein Fahrzeug geladen',
    farbe: '#7c3aed',
    neu: 'optional: Barcode-Etikett am Rollbehälter',
  },
  PAKET_IN_FAHRZEUG: { quelle: 'Beladescan am Handscanner', text: 'Paket ist im Fahrzeug', farbe: '#0f766e' },
  TOUR_START: { quelle: 'Anmeldung am Handscanner', text: 'Tour beginnt', farbe: '#2563eb' },
  POSITION: { quelle: 'Standort des fahrzeuggebundenen Handscanners', text: 'ungefähre Position, alle 60 Sekunden, nur während der Tour', farbe: '#94a3b8' },
  ZUSTELLUNG: { quelle: 'Zustellscan', text: 'Paket zugestellt', farbe: '#15803d' },
  NICHT_ZUGESTELLT: { quelle: 'Zustellscan mit Grund', text: 'Paket nicht zugestellt', farbe: '#b45309' },
  TOUR_ENDE: { quelle: 'Abmeldung am Handscanner', text: 'Tour beendet', farbe: '#1e3a8a' },
};

/** Schnittstelle: Strom von Scan-Ereignissen (simuliert oder echt) */
export interface ScanQuelle {
  abonnieren(cb: (e: ScanEreignis) => void): () => void;
}

/** Uhrzeit mit Sekunden, z. B. „07:12:30“ */
export function fmtUhrSek(min: number): string {
  const s = Math.max(0, Math.round(min * 60));
  const h = Math.floor(s / 3600) % 24;
  const m = Math.floor(s / 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
