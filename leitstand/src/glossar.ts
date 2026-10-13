/**
 * Glossar: alle Fachbegriffe an einer Stelle.
 *
 * Wer den Prototyp an die Begriffe im eigenen Betrieb anpassen will, ändert nur diese Datei.
 * Die Oberfläche, die Erklärungen („Wie kommt die Zahl zustande?“) und die Nachrichten an die
 * Fahrer-Ansicht setzen ihre Texte aus diesen Bausteinen zusammen.
 */
export const G = {
  // --- Begriffe aus dem Auftrag ---------------------------------------------------------
  zustellbasis: 'Zustellbasis',
  rampe: 'Rampe',
  rampen: 'Rampen',
  rollbehaelter: 'Rollbehälter',
  rollbehaelterPlural: 'Rollbehälter',
  /** Kurzform von Rollbehälter, im UI meist verwendet */
  behaelter: 'Behälter',
  behaelterPlural: 'Behälter',
  tour: 'Tour',
  touren: 'Touren',
  zustellbezirk: 'Zustellbezirk',
  zustellbezirke: 'Zustellbezirke',
  /** Kurzform von Zustellbezirk */
  bezirk: 'Bezirk',
  bezirke: 'Bezirke',
  gangfolge: 'Gangfolge',
  zustellerIn: 'Zusteller/in',
  zustellerInnen: 'Zusteller/innen',
  /** Vorsilbe der Pseudonyme: ergibt „Zusteller A“, „Zusteller B“, … */
  pseudonymVorsilbe: 'Zusteller',
  zustellfahrzeug: 'Zustellfahrzeug',
  zustellfahrzeuge: 'Zustellfahrzeuge',
  /** Kurzform im UI */
  fahrzeug: 'Fahrzeug',
  fahrzeuge: 'Fahrzeuge',
  fahrzeugTyp: 'E-Transporter',
  springer: 'Springer',
  leitstand: 'Leitstand',
  pakete: 'Pakete',
  paket: 'Paket',
  briefe: 'Briefe',
  brief: 'Brief',
  zeitungen: 'Zeitungen',
  zeitung: 'Zeitung',

  // --- Weitere Begriffe des Prototyps ----------------------------------------------------
  halle: 'Halle',
  bereitstellflaeche: 'Bereitstellfläche',
  parkplaetze: 'Parkplätze',
  ortsteil: 'Ortsteil',
  ortsteile: 'Ortsteile',
  stopp: 'Stopp',
  stopps: 'Stopps',
  treffpunkt: 'Treffpunkt',
  uebergabe: 'Übergabe',
  schicht: 'Schicht',
  beladen: 'Beladen',
  fahrerAnsicht: 'Fahrer-Ansicht',
} as const;

export type Begriff = keyof typeof G;

/** Kurze Erklärungen für die Info-Seite (gleiche Schlüssel wie oben, wo sinnvoll). */
export const ERKLAERUNG: Partial<Record<Begriff, string>> = {
  zustellbasis: 'Standort, an dem die Sendungen sortiert, in Behälter verteilt und auf die Fahrzeuge geladen werden.',
  rampe: 'Ladeplatz an der Halle. Jede Tour belädt ihr Fahrzeug an einer festen Rampe.',
  rollbehaelter: 'Rollbarer Behälter mit den Sendungen für einen Zustellbezirk. Kurz: Behälter.',
  tour: 'Ein Fahrzeug mit einer Zustellerin oder einem Zusteller für einen Tag, mit festgelegten Bezirken.',
  zustellbezirk: 'Gebiet mit festen Straßen und Häusern, die in einer festen Reihenfolge beliefert werden.',
  gangfolge: 'Reihenfolge, in der die Bezirke einer Tour (und die Stopps eines Bezirks) angefahren werden.',
  zustellerIn: 'Im Prototyp nur als Pseudonym („Zusteller A“), nie mit Namen.',
  zustellfahrzeug: 'Elektrisch betriebener Transporter, der vom Leitstand nur auf Fahrzeugebene geortet wird.',
  springer: 'Vertretungskraft, die eine unbesetzte Tour übernehmen kann (kommt mit Vorlauf).',
  leitstand: 'Arbeitsplatz, an dem der Tagesablauf der Basis überblickt und bei Bedarf umgeplant wird.',
  treffpunkt: 'Ort, an dem zwei Fahrzeuge Behälter übergeben können.',
};

/** Pseudonym für Tour Nr. 1, 2, 3 … → „Zusteller A“, „Zusteller B“, … */
export function pseudonym(nr: number): string {
  return `${G.pseudonymVorsilbe} ${String.fromCharCode(64 + nr)}`;
}

/** Singular/Plural nach Anzahl: anzahl(3, G.paket, G.pakete) → „3 Pakete“ */
export function anzahl(n: number, einzahl: string, mehrzahl: string): string {
  return `${n.toLocaleString('de-DE')} ${n === 1 ? einzahl : mehrzahl}`;
}
