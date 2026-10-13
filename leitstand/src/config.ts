/**
 * Annahmen des Rechenmodells.
 *
 * Alle Zahlen hier sind Annahmen für eine Beispielrechnung, keine Werte eines echten Betriebs.
 * Sie lassen sich im UI ändern; die Standardwerte stehen hier.
 */

export const STANDARD_ANNAHMEN = {
  // Zeit
  ladezeitMin: 30,
  tempoZwischenKmh: 45,
  tempoImGebietKmh: 18,
  minProPaket: 1.2,
  sekProBrief: 3.6,
  sekProZeitung: 3,
  // Kosten
  schichtStunden: 8,
  stundensatz: 28,
  ueberstundenZuschlagProzent: 25,
  euroProKm: 0.3,
  fahrzeugFixProTag: 25,
  // Hochrechnung
  zustelltageProJahr: 300,
  zustellbasen: 1,
  // Ablauf bei Umplanung und Szenarien
  uebergabeMin: 10,
  springerVorlaufMin: 60,
  spitzentagProzent: 40,
};

export type Annahmen = { [K in keyof typeof STANDARD_ANNAHMEN]: number };
export type AnnahmeSchluessel = keyof Annahmen;

export type AnnahmeGruppe = 'Zeit' | 'Kosten' | 'Hochrechnung' | 'Ablauf';

export interface AnnahmeInfo {
  label: string;
  einheit: string;
  gruppe: AnnahmeGruppe;
  min: number;
  max: number;
  schritt: number;
  hinweis?: string;
}

export const ANNAHMEN_INFO: Record<AnnahmeSchluessel, AnnahmeInfo> = {
  ladezeitMin: { label: 'Beladen je Tour', einheit: 'Min', gruppe: 'Zeit', min: 0, max: 90, schritt: 5 },
  tempoZwischenKmh: { label: 'Tempo zwischen den Gebieten', einheit: 'km/h', gruppe: 'Zeit', min: 10, max: 90, schritt: 1 },
  tempoImGebietKmh: { label: 'Tempo im Gebiet', einheit: 'km/h', gruppe: 'Zeit', min: 5, max: 50, schritt: 1 },
  minProPaket: { label: 'Zustellzeit je Paket', einheit: 'Min', gruppe: 'Zeit', min: 0.2, max: 5, schritt: 0.1 },
  sekProBrief: { label: 'Zustellzeit je Brief', einheit: 'Sek', gruppe: 'Zeit', min: 0.5, max: 20, schritt: 0.1 },
  sekProZeitung: { label: 'Zustellzeit je Zeitung', einheit: 'Sek', gruppe: 'Zeit', min: 0.5, max: 20, schritt: 0.5 },
  schichtStunden: {
    label: 'Schichtlänge',
    einheit: 'h',
    gruppe: 'Kosten',
    min: 4,
    max: 10,
    schritt: 0.5,
    hinweis: 'Die volle Schicht wird bezahlt. Darüber hinaus zählt jede Minute als Überstunde.',
  },
  stundensatz: { label: 'Stundensatz', einheit: '€/h', gruppe: 'Kosten', min: 10, max: 80, schritt: 0.5 },
  ueberstundenZuschlagProzent: { label: 'Überstundenzuschlag', einheit: '%', gruppe: 'Kosten', min: 0, max: 100, schritt: 5 },
  euroProKm: { label: 'Kosten je km', einheit: '€/km', gruppe: 'Kosten', min: 0, max: 2, schritt: 0.01 },
  fahrzeugFixProTag: { label: 'Fahrzeug fix je Tag', einheit: '€', gruppe: 'Kosten', min: 0, max: 200, schritt: 1 },
  zustelltageProJahr: { label: 'Zustelltage im Jahr', einheit: 'Tage', gruppe: 'Hochrechnung', min: 1, max: 366, schritt: 1 },
  zustellbasen: {
    label: 'Zustellbasen',
    einheit: 'Basen',
    gruppe: 'Hochrechnung',
    min: 1,
    max: 1000,
    schritt: 1,
    hinweis: 'Nur für die Hochrechnung auf der Seite „Idee in Zahlen“. Musterhausen ist erfunden; ob echte Basen ähnlich viel Spielraum haben, muss ein Pilot zeigen.',
  },
  uebergabeMin: { label: 'Dauer einer Übergabe', einheit: 'Min', gruppe: 'Ablauf', min: 0, max: 60, schritt: 1 },
  springerVorlaufMin: {
    label: 'Vorlauf Springer',
    einheit: 'Min',
    gruppe: 'Ablauf',
    min: 0,
    max: 180,
    schritt: 5,
    hinweis: 'So viel später als geplant kann ein Springer die Tour beginnen.',
  },
  spitzentagProzent: { label: 'Mehrmenge am Spitzentag', einheit: '%', gruppe: 'Ablauf', min: 0, max: 150, schritt: 5 },
};

export function standardAnnahmen(): Annahmen {
  return { ...STANDARD_ANNAHMEN };
}

/** Schichtlänge in Minuten */
export function schichtMin(a: Annahmen): number {
  return a.schichtStunden * 60;
}
