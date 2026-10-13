/**
 * Datenmodell des Leitstands. Reines TypeScript, ohne UI-Abhängigkeit.
 *
 * Koordinaten der Welt in km (x nach Osten, y nach Norden). Zeiten in Minuten ab 0:00 Uhr.
 */

export interface Vec2 {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------------------
// Straßennetz
// ---------------------------------------------------------------------------------------

export type KnotenId = number;
export type KantenId = number;

export type StrassenTyp = 'haupt' | 'land' | 'deich' | 'bruecke' | 'zufahrt' | 'ort' | 'gewerbe';

export interface Knoten {
  id: KnotenId;
  x: number;
  y: number;
}

export interface Kante {
  id: KantenId;
  a: KnotenId;
  b: KnotenId;
  laengeKm: number;
  typ: StrassenTyp;
  /** Straßenname (fiktiv) */
  strasse: string;
}

export interface Strassennetz {
  knoten: Knoten[];
  kanten: Kante[];
}

// ---------------------------------------------------------------------------------------
// Welt (fest, ändert sich über den Tag nicht)
// ---------------------------------------------------------------------------------------

export interface Haus {
  id: number;
  x: number;
  y: number;
  /** Drehung in Radiant (Ausrichtung zur Straße) */
  rot: number;
  /** 0 = Einfamilienhaus, 1 = Doppelhaus, 2 = Mehrfamilienhaus */
  art: 0 | 1 | 2;
  stoppId: number;
}

export interface Stopp {
  id: number;
  knoten: KnotenId;
  bezirkId: string;
  strasse: string;
  /** relative Sendungsmenge (Haushalte) */
  gewicht: number;
  haeuser: number[];
}

export interface Zustellbezirk {
  /** z. B. „LI-S“ */
  id: string;
  /** z. B. „Lindenau Süd“ */
  name: string;
  ortsteilId: string;
  /** Knoten, an dem der Bezirk angefahren und wieder verlassen wird */
  anfahrpunkt: KnotenId;
  /** Stopps in Gangfolge */
  stopps: number[];
  /** Weg im Bezirk als Knotenfolge: Anfahrpunkt → alle Stopps → Anfahrpunkt */
  innenWeg: KnotenId[];
  innenKm: number;
  strassen: string[];
}

export interface Ortsteil {
  /** z. B. „LI“ */
  id: string;
  name: string;
  zentrum: Vec2;
  /** ungefährer Radius in km (für Landschaft und Beschriftung) */
  radius: number;
  bezirke: string[];
}

export interface Treffpunkt {
  id: string;
  name: string;
  knoten: KnotenId;
}

export interface Rampe {
  nr: number;
  /** Position vor der Rampe (Welt-km), dort steht das Fahrzeug */
  pos: Vec2;
}

export interface Zustellbasis {
  name: string;
  /** Knoten, an dem die Fahrzeuge ab- und anfahren */
  knoten: KnotenId;
  /** Mittelpunkt der Halle */
  pos: Vec2;
  /** Ausrichtung der Halle (Radiant), Rampen liegen auf der Seite in Richtung +x lokal */
  rot: number;
  halle: { breiteKm: number; tiefeKm: number };
  rampen: Rampe[];
  /** Mittelpunkt der Bereitstellfläche (in der Halle, hinter den Rampen) */
  bereitstellflaeche: Vec2;
  parkplaetze: Vec2[];
}

export type FeldArt = 'acker' | 'wiese' | 'raps' | 'weizen';

export interface Feld {
  art: FeldArt;
  /** Viereck (4 Punkte, gegen den Uhrzeigersinn) */
  ecken: Vec2[];
}

export interface Landschaft {
  fluss: Vec2[];
  flussBreiteKm: number;
  felder: Feld[];
  baeume: Array<Vec2 & { groesse: number }>;
}

export interface Hauptstrasse {
  name: string;
  kanten: KantenId[];
}

export interface Welt {
  seed: number;
  name: string;
  breiteKm: number;
  hoeheKm: number;
  netz: Strassennetz;
  basis: Zustellbasis;
  ortsteile: Ortsteil[];
  bezirke: Record<string, Zustellbezirk>;
  /** Reihenfolge der Bezirke (für Listen) */
  bezirkIds: string[];
  stopps: Stopp[];
  haeuser: Haus[];
  treffpunkte: Treffpunkt[];
  hauptstrassen: Hauptstrasse[];
  landschaft: Landschaft;
}

// ---------------------------------------------------------------------------------------
// Tagesdaten
// ---------------------------------------------------------------------------------------

export interface Inhalt {
  pakete: number;
  briefe: number;
  zeitungen: number;
}

export type BehaelterStatus = 'halle' | 'verladen' | 'unterwegs' | 'zugestellt';

/** Feste Angaben eines Behälters für den Tag */
export interface BehaelterStamm {
  id: string;
  zielbezirk: string;
  inhalt: Inhalt;
}

/** Sicht auf einen Behälter zu einem Zeitpunkt (aus Plan und Simulation abgeleitet) */
export interface Behaelter extends BehaelterStamm {
  status: BehaelterStatus;
  tourId: string | null;
  /** 1-basiert, Position in der Gangfolge der Tour */
  gangfolgePos: number | null;
}

export interface Fahrzeug {
  id: string;
  typ: string;
}

export interface Tour {
  id: string;
  nr: number;
  fahrzeugId: string;
  /** z. B. „Zusteller A“ – nie ein echter Name */
  pseudonym: string;
  rampe: number;
  /** Minuten ab 0:00 */
  schichtbeginn: number;
  farbe: string;
}

export type TourStatus = 'bereit' | 'beladen' | 'unterwegs' | 'rueckfahrt' | 'zurueck' | 'unbesetzt' | 'defekt';

export interface Minuten {
  laden: number;
  fahrtZwischen: number;
  fahrtInnen: number;
  zustellung: number;
  uebergabe: number;
  warten: number;
}

/** Was eine Tour bis zum Startpunkt einer (Um-)Planung schon geleistet hat */
export interface Bisher {
  kmZwischen: number;
  kmInnen: number;
  min: Minuten;
  menge: Inhalt;
}

/**
 * Zustand einer Tour zu Beginn der Planung. Morgens: an der Basis, muss noch laden.
 * Bei Umplanung im Tagesverlauf: dort, wo das Fahrzeug als Nächstes einen Knoten erreicht.
 */
export interface StartZustand {
  zeit: number;
  knoten: KnotenId;
  /** true: Fahrzeug steht noch an der Rampe und lädt die eingeplanten Behälter aus der Halle */
  mussLaden: boolean;
  /** Behälter an Bord (noch nicht zugestellt) */
  geladen: string[];
  /** bereits zugestellte Behälter */
  erledigt: string[];
  bisher: Bisher;
  /** false: Tour ist unbesetzt (Ausfall) */
  besetzt: boolean;
  /** true: Fahrzeug steht mit Defekt am Startknoten und kann nur noch übergeben */
  defekt: boolean;
  /** tatsächlicher Schichtbeginn (z. B. später bei einem Springer) */
  schichtbeginn: number;
  /** Tour wird von einem Springer gefahren */
  springer: boolean;
}

export interface Tag {
  datum: string;
  touren: Tour[];
  fahrzeuge: Fahrzeug[];
  behaelter: Record<string, BehaelterStamm>;
  behaelterIds: string[];
  start: Record<string, StartZustand>;
  /** gesperrte Kanten (z. B. Stau) */
  sperrungen: KantenId[];
  /** Mengenfaktor (1 = normal, 1,4 = Spitzentag) – bereits in den Behälterinhalten enthalten */
  mengenFaktor: number;
}

// ---------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------

export interface BezirkSchritt {
  art: 'bezirk';
  behaelterId: string;
}

export interface UebergabeSchritt {
  art: 'uebergabe';
  /** gleiche id bei beiden beteiligten Touren */
  id: string;
  treffpunkt: KnotenId;
  treffpunktName: string;
  partner: string;
  abgeben: string[];
  aufnehmen: string[];
}

export type Schritt = BezirkSchritt | UebergabeSchritt;

export interface TourPlan {
  schritte: Schritt[];
}

export interface Plan {
  touren: Record<string, TourPlan>;
  /** Behälter, die heute bewusst nicht zugestellt werden */
  liegenLassen: string[];
}

// ---------------------------------------------------------------------------------------
// Ereignisse (Simulation und später echte Quellen)
// ---------------------------------------------------------------------------------------

export type Ereignis =
  | { typ: 'position'; zeit: number; tourId: string; x: number; y: number; richtung: number }
  | { typ: 'stoppErledigt'; zeit: number; tourId: string; stoppId: number; bezirkId: string }
  | { typ: 'verzoegerung'; zeit: number; tourId: string; minuten: number; grund: string }
  | { typ: 'umleitung'; zeit: number; tourId: string; grund: string; strasse: string }
  | { typ: 'nachricht'; zeit: number; id: string; tourId: string; text: string; bestaetigungNoetig: boolean }
  | { typ: 'bestaetigung'; zeit: number; nachrichtId: string; tourId: string };
