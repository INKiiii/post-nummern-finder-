/**
 * Erzeugt die fiktive Demo-Welt „Musterhausen“: eine Zustellbasis, neun Ortsteile mit
 * 21 Zustellbezirken, ein Fluss mit drei Brücken, Hauptstraßen, Felder und Wäldchen.
 *
 * Alles ist erfunden. Gleicher Seed → exakt gleiche Welt.
 */
import { zufall, type Zufall } from './rng';
import { Wegenetz, wegLaenge } from './graph';
import type {
  Feld,
  FeldArt,
  Haus,
  Hauptstrasse,
  Kante,
  KantenId,
  Knoten,
  KnotenId,
  Ortsteil,
  Rampe,
  Stopp,
  StrassenTyp,
  Treffpunkt,
  Vec2,
  Welt,
  Zustellbezirk,
} from './types';

export const DEMO_SEED = 4711;

const SCHRITT_HAUPT = 0.25; // km zwischen Knoten auf Überlandstraßen
const SCHRITT_ORT = 0.1; // km zwischen Stopps im Ort
const HAUS_ABSTAND = 0.034; // km von der Straßenmitte

// ---------------------------------------------------------------------------------------
// Bauhelfer für das Straßennetz
// ---------------------------------------------------------------------------------------

class NetzBauer {
  knoten: Knoten[] = [];
  kanten: Kante[] = [];

  punkt(p: Vec2): KnotenId {
    const id = this.knoten.length;
    this.knoten.push({ id, x: rund(p.x), y: rund(p.y) });
    return id;
  }

  kante(a: KnotenId, b: KnotenId, typ: StrassenTyp, strasse: string): KantenId {
    const ka = this.knoten[a];
    const kb = this.knoten[b];
    const id = this.kanten.length;
    this.kanten.push({ id, a, b, laengeKm: Math.hypot(ka.x - kb.x, ka.y - kb.y), typ, strasse });
    return id;
  }

  /** Straße durch Punkte oder vorhandene Knoten; lange Abschnitte werden unterteilt. */
  linie(
    punkte: Array<Vec2 | KnotenId>,
    typ: StrassenTyp,
    strasse: string,
    schritt: number,
  ): { knoten: KnotenId[]; kanten: KantenId[] } {
    const ids = punkte.map((p) => (typeof p === 'number' ? p : this.punkt(p)));
    const knoten: KnotenId[] = [ids[0]];
    const kanten: KantenId[] = [];
    for (let i = 1; i < ids.length; i++) {
      const a = this.knoten[ids[i - 1]];
      const b = this.knoten[ids[i]];
      const n = Math.max(1, Math.round(Math.hypot(a.x - b.x, a.y - b.y) / schritt));
      let vorher = ids[i - 1];
      for (let j = 1; j <= n; j++) {
        const id = j === n ? ids[i] : this.punkt({ x: a.x + ((b.x - a.x) * j) / n, y: a.y + ((b.y - a.y) * j) / n });
        kanten.push(this.kante(vorher, id, typ, strasse));
        knoten.push(id);
        vorher = id;
      }
    }
    return { knoten, kanten };
  }

  naechsterKnoten(p: Vec2, kandidaten?: KnotenId[]): KnotenId {
    let best = -1;
    let bestD = Infinity;
    for (const id of kandidaten ?? this.knoten.map((k) => k.id)) {
      const k = this.knoten[id];
      const d = Math.hypot(k.x - p.x, k.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }
}

function rund(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

// ---------------------------------------------------------------------------------------
// Feste Anlage der Karte (km, x nach Osten, y nach Norden)
// ---------------------------------------------------------------------------------------

const FLUSS: Vec2[] = [
  { x: 8.35, y: 10.5 },
  { x: 7.95, y: 9.3 },
  { x: 8.35, y: 8.2 },
  { x: 8.0, y: 7.0 },
  { x: 7.55, y: 5.9 },
  { x: 7.75, y: 4.7 },
  { x: 8.25, y: 3.6 },
  { x: 7.85, y: 2.4 },
  { x: 7.6, y: 1.2 },
  { x: 8.0, y: -0.5 },
];

interface OrtsteilDef {
  id: string;
  name: string;
  zentrum: Vec2;
  winkelGrad: number;
  laenge: number;
  anzahlBezirke: 2 | 3;
  hauptstrasse: string;
  nebenstrassen: string[];
  /** Anbindung der beiden Enden der Ortsdurchfahrt (a = Anfang, b = Ende) */
  anbindungA?: string;
  anbindungB?: string;
}

const ORTSTEILE: OrtsteilDef[] = [
  {
    id: 'AL', name: 'Altdorf', zentrum: { x: 1.5, y: 8.2 }, winkelGrad: 75, laenge: 1.5, anzahlBezirke: 2,
    hauptstrasse: 'Dorfstraße', nebenstrassen: ['Am Anger', 'Kirchgasse', 'Schmiedeweg', 'Brunnenweg', 'Hofweg'],
    anbindungA: 'AL1', anbindungB: 'JNW',
  },
  {
    id: 'BI', name: 'Birkenhain', zentrum: { x: 5.4, y: 8.3 }, winkelGrad: 15, laenge: 1.7, anzahlBezirke: 3,
    hauptstrasse: 'Birkenallee', nebenstrassen: ['Ahornweg', 'Eschenring', 'Buchenweg', 'Erlenstraße', 'Ulmenweg', 'Waldblick', 'Lärchenweg'],
    anbindungA: 'JNW', anbindungB: 'JSP',
  },
  {
    id: 'KI', name: 'Kirchberg', zentrum: { x: 5.3, y: 6.7 }, winkelGrad: 95, laenge: 1.2, anzahlBezirke: 2,
    hauptstrasse: 'Kirchbergstraße', nebenstrassen: ['Pfarrweg', 'Glockengasse', 'Am Hang', 'Schulstraße', 'Turmweg'],
    anbindungA: 'JK', anbindungB: 'BI*',
  },
  {
    id: 'MB', name: 'Mühlbach', zentrum: { x: 1.6, y: 2.9 }, winkelGrad: 30, laenge: 1.5, anzahlBezirke: 2,
    hauptstrasse: 'Mühlenstraße', nebenstrassen: ['Bachweg', 'Am Wehr', 'Müllerstraße', 'Rädergasse', 'Steinweg'],
    anbindungA: 'L1', anbindungB: 'JSW',
  },
  {
    id: 'RO', name: 'Rosental', zentrum: { x: 5.4, y: 2.8 }, winkelGrad: -10, laenge: 1.6, anzahlBezirke: 2,
    hauptstrasse: 'Rosentaler Straße', nebenstrassen: ['Rosenweg', 'Tulpenweg', 'Nelkenstraße', 'Fliederweg', 'Asternring'],
    anbindungA: 'JSW', anbindungB: 'S2',
  },
  {
    id: 'LI', name: 'Lindenau', zentrum: { x: 9.9, y: 7.4 }, winkelGrad: 110, laenge: 1.6, anzahlBezirke: 3,
    hauptstrasse: 'Lindenauer Straße', nebenstrassen: ['Lindenweg', 'Am Deich', 'Fischerweg', 'Uferstraße', 'Fährgasse', 'Weidenweg', 'Kahnweg'],
    anbindungA: 'H2', anbindungB: 'D1',
  },
  {
    id: 'EI', name: 'Eichenfeld', zentrum: { x: 12.6, y: 8.1 }, winkelGrad: 60, laenge: 1.4, anzahlBezirke: 2,
    hauptstrasse: 'Eichenfelder Straße', nebenstrassen: ['Eichenweg', 'Feldstraße', 'Am Hain', 'Lerchenweg', 'Wachtelgasse'],
    anbindungA: 'K1', anbindungB: 'N5',
  },
  {
    id: 'SE', name: 'Seefeld', zentrum: { x: 12.5, y: 4.4 }, winkelGrad: 165, laenge: 1.7, anzahlBezirke: 3,
    hauptstrasse: 'Seestraße', nebenstrassen: ['Seeblick', 'Schilfweg', 'Am Steg', 'Reiherweg', 'Möwengasse', 'Strandweg', 'Bootsweg'],
    anbindungB: 'K2',
  },
  {
    id: 'WI', name: 'Wiesengrund', zentrum: { x: 10.2, y: 1.4 }, winkelGrad: 20, laenge: 1.5, anzahlBezirke: 2,
    hauptstrasse: 'Wiesenstraße', nebenstrassen: ['Kleeweg', 'Blumenwiese', 'Grasweg', 'Auenring', 'Heuweg'],
    anbindungA: 'S3', anbindungB: 'JWI',
  },
];

// ---------------------------------------------------------------------------------------
// Erzeugung
// ---------------------------------------------------------------------------------------

export function erzeugeDemoWelt(seed: number = DEMO_SEED): Welt {
  const rng = zufall(seed);
  const b = new NetzBauer();

  // Knotenpunkte der Überlandstraßen
  const P: Record<string, KnotenId> = {};
  const def = (name: string, x: number, y: number) => (P[name] = b.punkt({ x, y }));
  def('W0', 0.0, 5.45);
  def('JA', 1.2, 5.5);
  def('JB', 2.4, 5.55);
  def('JW', 3.3, 5.6);
  def('H1', 4.8, 5.45);
  def('JK', 5.5, 5.5);
  def('BMW', 7.42, 5.5);
  def('BMO', 7.82, 5.5);
  def('H2', 10.2, 5.7);
  def('JE', 11.6, 5.85);
  def('O0', 14.0, 6.0);
  def('N1', 3.5, 6.9);
  def('JNW', 3.9, 8.0);
  def('N2', 4.6, 8.9);
  def('JSP', 6.0, 9.15);
  def('N3', 7.0, 9.05);
  def('BNW', 7.85, 9.0);
  def('BNO', 8.25, 9.0);
  def('JNO', 8.7, 9.05);
  def('N4', 10.2, 9.25);
  def('JEI', 11.8, 9.15);
  def('N5', 13.2, 9.05);
  def('NO0', 14.0, 9.0);
  def('K1', 11.9, 7.4);
  def('K2', 11.4, 4.0);
  def('JWI', 11.2, 2.3);
  def('S1', 3.6, 4.4);
  def('JSW', 3.9, 3.0);
  def('JFK', 4.8, 2.0);
  def('S2', 6.4, 1.95);
  def('BSW', 7.59, 2.1);
  def('BSO', 7.99, 2.1);
  def('JSO', 8.6, 2.2);
  def('S3', 9.6, 2.25);
  def('SO0', 14.0, 2.7);
  def('D1', 8.75, 8.1);
  def('JDW', 8.4, 7.0);
  def('D2', 8.05, 6.2);
  def('D3', 8.05, 4.7);
  def('D4', 8.5, 3.6);
  def('D5', 8.25, 2.7);
  def('AL1', 1.15, 6.6);
  def('L1', 1.0, 4.3);
  def('G1', 2.36, 5.3);
  def('BASIS', 2.3, 5.06);

  const strassenKanten = new Map<string, KantenId[]>();
  const strasse = (punkte: Array<Vec2 | KnotenId>, typ: StrassenTyp, name: string, schritt = SCHRITT_HAUPT) => {
    const r = b.linie(punkte, typ, name, schritt);
    strassenKanten.set(name, [...(strassenKanten.get(name) ?? []), ...r.kanten]);
    return r;
  };

  strasse([P.W0, P.JA, P.JB, P.JW, P.H1, P.JK, P.BMW], 'haupt', 'Hauptstraße');
  strasse([P.BMW, P.BMO], 'bruecke', 'Mittelbrücke', 1);
  strasse([P.BMO, P.H2, P.JE, P.O0], 'haupt', 'Hauptstraße');
  strasse([P.JW, P.N1, P.JNW, P.N2, P.JSP, P.N3, P.BNW], 'land', 'Nordstraße');
  strasse([P.BNW, P.BNO], 'bruecke', 'Nordbrücke', 1);
  strasse([P.BNO, P.JNO, P.N4, P.JEI, P.N5, P.NO0], 'land', 'Nordstraße');
  strasse([P.JW, P.S1, P.JSW, P.JFK, P.S2, P.BSW], 'land', 'Südstraße');
  strasse([P.BSW, P.BSO], 'bruecke', 'Südbrücke', 1);
  strasse([P.BSO, P.JSO, P.S3, P.JWI, P.SO0], 'land', 'Südstraße');
  strasse([P.JNO, P.D1, P.JDW, P.D2, P.BMO, P.D3, P.D4, P.D5, P.BSO], 'deich', 'Deichweg');
  strasse([P.JEI, P.K1, P.JE, P.K2, P.JWI], 'land', 'Kreisstraße');
  strasse([P.JA, P.AL1], 'land', 'Alte Landstraße');
  strasse([P.JA, P.L1], 'land', 'Alte Landstraße');
  strasse([P.JB, P.G1, P.BASIS], 'gewerbe', 'Gewerbering', 0.15);

  // Ortsteile
  const ortsteile: Ortsteil[] = [];
  const bezirke: Record<string, Zustellbezirk> = {};
  const bezirkIds: string[] = [];
  const stopps: Stopp[] = [];
  const haeuser: Haus[] = [];
  const ortsSegmente: Array<[Vec2, Vec2]> = [];
  const hauptKnotenJeOrt = new Map<string, KnotenId[]>();

  for (const o of ORTSTEILE) {
    const r = baueOrtsteil(o, b, rng, P, hauptKnotenJeOrt, strasse);
    hauptKnotenJeOrt.set(o.id, r.hauptKnoten);
    ortsteile.push({ id: o.id, name: o.name, zentrum: o.zentrum, radius: o.laenge / 2 + 0.4, bezirke: r.bezirke.map((z) => z.id) });
    for (const z of r.bezirke) {
      bezirke[z.id] = z.bezirk;
      bezirkIds.push(z.id);
    }
    for (const s of r.stopps) {
      s.stopp.id = stopps.length;
      stopps.push(s.stopp);
    }
    ortsSegmente.push(...r.segmente);
  }

  // Stopps den Bezirken zuordnen (ids sind jetzt fest)
  for (const s of stopps) bezirke[s.bezirkId].stopps.push(s.id);

  const netz = { knoten: b.knoten, kanten: b.kanten };
  const wege = new Wegenetz(netz);

  // Gangfolge im Bezirk und Häuser
  for (const id of bezirkIds) {
    const z = bezirke[id];
    const folge = gangfolge(wege, z.anfahrpunkt, z.stopps.map((s) => stopps[s].knoten));
    z.stopps = folge.map((i) => z.stopps[i]);
    const weg: KnotenId[] = [z.anfahrpunkt];
    let vorher = z.anfahrpunkt;
    for (const s of z.stopps) {
      const k = stopps[s].knoten;
      weg.push(...wege.pfad(vorher, k).slice(1));
      vorher = k;
    }
    weg.push(...wege.pfad(vorher, z.anfahrpunkt).slice(1));
    z.innenWeg = weg;
    z.innenKm = wegLaenge(netz, weg);
    z.strassen = [...new Set(z.stopps.map((s) => stopps[s].strasse))];
  }

  const alleSegmente = netz.kanten.map((k): [Vec2, Vec2] => [netz.knoten[k.a], netz.knoten[k.b]]);
  const segIndex = new SegmentIndex(alleSegmente, 0.25);
  setzeHaeuser(stopps, netz, segIndex, rng, haeuser);

  // Basis
  const basis = baueBasis(P.BASIS);

  // Treffpunkte
  const treffpunkte: Treffpunkt[] = [
    { id: 'deichweg', name: 'Deichweg', knoten: P.JDW },
    { id: 'muehlenplatz', name: 'Mühlenplatz', knoten: P.JW },
    { id: 'sportplatz', name: 'Am Sportplatz', knoten: P.JSP },
    { id: 'kreisel-ost', name: 'Kreisel Ost', knoten: P.JE },
    { id: 'brueckenkopf-sued', name: 'Brückenkopf Süd', knoten: P.JSO },
    { id: 'feldkreuz', name: 'Feldkreuz', knoten: P.JFK },
    { id: 'eichenkreuz', name: 'Eichenkreuz', knoten: P.JEI },
  ];

  const hauptstrassen: Hauptstrasse[] = [];
  for (const [name, kanten] of strassenKanten) {
    const typ = netz.kanten[kanten[0]].typ;
    if (typ === 'haupt' || typ === 'land' || typ === 'deich' || typ === 'bruecke') hauptstrassen.push({ name, kanten });
  }

  const landschaft = {
    fluss: FLUSS,
    flussBreiteKm: 0.09,
    felder: [] as Feld[],
    baeume: [] as Array<Vec2 & { groesse: number }>,
  };
  setzeLandschaft(landschaft, ortsteile, basis.pos, segIndex, haeuser, rng);

  return {
    seed,
    name: 'Musterhausen',
    breiteKm: 14,
    hoeheKm: 10,
    netz,
    basis,
    ortsteile,
    bezirke,
    bezirkIds,
    stopps,
    haeuser,
    treffpunkte,
    hauptstrassen,
    landschaft,
  };
}

// ---------------------------------------------------------------------------------------
// Ortsteil
// ---------------------------------------------------------------------------------------

interface OrtsteilErgebnis {
  hauptKnoten: KnotenId[];
  bezirke: Array<{ id: string; bezirk: Zustellbezirk }>;
  stopps: Array<{ stopp: Stopp }>;
  segmente: Array<[Vec2, Vec2]>;
}

function baueOrtsteil(
  o: OrtsteilDef,
  b: NetzBauer,
  rng: Zufall,
  P: Record<string, KnotenId>,
  hauptKnotenJeOrt: Map<string, KnotenId[]>,
  strasse: (punkte: Array<Vec2 | KnotenId>, typ: StrassenTyp, name: string, schritt?: number) => { knoten: KnotenId[]; kanten: KantenId[] },
): OrtsteilErgebnis {
  const w = (o.winkelGrad * Math.PI) / 180;
  const u = { x: Math.cos(w), y: Math.sin(w) };
  const n = { x: -u.y, y: u.x };
  const L = o.laenge;
  const anzahl = Math.round(L / SCHRITT_ORT);
  const bogen = rng.zwischen(-0.07, 0.07);

  // Ortsdurchfahrt, leicht geschwungen
  const hauptPunkte: Vec2[] = [];
  const tWerte: number[] = [];
  for (let i = 0; i <= anzahl; i++) {
    const t = -L / 2 + (L * i) / anzahl;
    const quer = bogen * Math.sin(Math.PI * (t / L + 0.5)) * 2 - bogen;
    hauptPunkte.push({ x: o.zentrum.x + u.x * t + n.x * quer, y: o.zentrum.y + u.y * t + n.y * quer });
    tWerte.push(t);
  }
  const haupt = strasse(hauptPunkte, 'ort', o.hauptstrasse, 1);
  const hauptKnoten = haupt.knoten;

  // Anbindung an das Überlandnetz
  const anbinden = (ziel: string | undefined, ende: KnotenId) => {
    if (!ziel) return;
    let zielKnoten: KnotenId;
    if (ziel.endsWith('*')) {
      const kandidaten = hauptKnotenJeOrt.get(ziel.slice(0, -1)) ?? [];
      zielKnoten = b.naechsterKnoten(b.knoten[ende], kandidaten);
    } else zielKnoten = P[ziel];
    strasse([ende, zielKnoten], 'zufahrt', `Zufahrt ${o.name}`, SCHRITT_HAUPT);
  };
  anbinden(o.anbindungA, hauptKnoten[0]);
  anbinden(o.anbindungB, hauptKnoten[hauptKnoten.length - 1]);

  // Bezirke entlang der Achse: Kürzel nach Himmelsrichtung
  const ostWest = Math.abs(u.x) >= Math.abs(u.y);
  const steigend = ostWest ? u.x > 0 : u.y > 0; // wächst t nach Osten bzw. Norden?
  const kuerzel = o.anzahlBezirke === 3 ? (ostWest ? ['W', 'M', 'O'] : ['S', 'M', 'N']) : ostWest ? ['W', 'O'] : ['S', 'N'];
  const langname: Record<string, string> = { W: 'West', M: 'Mitte', O: 'Ost', N: 'Nord', S: 'Süd' };
  if (!steigend) kuerzel.reverse();
  const bezirkFuerT = (t: number) => {
    const i = Math.min(o.anzahlBezirke - 1, Math.max(0, Math.floor(((t + L / 2) / L) * o.anzahlBezirke)));
    return `${o.id}-${kuerzel[i]}`;
  };

  const bezirkListe: Array<{ id: string; bezirk: Zustellbezirk }> = [];
  for (let i = 0; i < o.anzahlBezirke; i++) {
    const id = `${o.id}-${kuerzel[i]}`;
    // Anfahrpunkt: Knoten der Durchfahrt nahe der Mitte des Abschnitts
    const tMitte = -L / 2 + (L * (i + 0.5)) / o.anzahlBezirke;
    let best = 0;
    for (let j = 0; j < tWerte.length; j++) if (Math.abs(tWerte[j] - tMitte) < Math.abs(tWerte[best] - tMitte)) best = j;
    bezirkListe.push({
      id,
      bezirk: {
        id,
        name: `${o.name} ${langname[kuerzel[i]]}`,
        ortsteilId: o.id,
        anfahrpunkt: hauptKnoten[best],
        stopps: [],
        innenWeg: [],
        innenKm: 0,
        strassen: [],
      },
    });
  }

  const segmente: Array<[Vec2, Vec2]> = [];
  for (let i = 1; i < hauptPunkte.length; i++) segmente.push([hauptPunkte[i - 1], hauptPunkte[i]]);

  // Nebenstraßen: gleichmäßig verteilt, abwechselnd links/rechts, manchmal als Querstraße
  const anzahlNeben = o.anzahlBezirke * 2 + (rng() < 0.5 ? 1 : 0);
  const abzweige: number[] = [];
  for (let i = 0; i < anzahlNeben; i++) {
    const idx = Math.round(1.5 + ((anzahl - 3) * (i + 0.5)) / anzahlNeben);
    if (!abzweige.includes(idx)) abzweige.push(idx);
  }
  const nebenKnoten: Array<{ knoten: KnotenId[]; strasse: string; t: number }> = [];
  let seite = rng() < 0.5 ? 1 : -1;
  abzweige.forEach((idx, i) => {
    const name = o.nebenstrassen[i % o.nebenstrassen.length];
    const quer = rng() < 0.3;
    const seiten = quer ? [1, -1] : [seite];
    seite = -seite;
    for (const s of seiten) {
      const laenge = rng.zwischen(0.28, 0.52);
      const knick = rng.zwischen(-0.25, 0.25);
      const start = b.knoten[hauptKnoten[idx]];
      const richtung = drehe({ x: n.x * s, y: n.y * s }, knick);
      const schritte = Math.max(2, Math.round(laenge / SCHRITT_ORT));
      const punkte: Array<Vec2 | KnotenId> = [hauptKnoten[idx]];
      let vorher: Vec2 = start;
      for (let j = 1; j <= schritte; j++) {
        const biegung = j > schritte / 2 ? rng.zwischen(-0.15, 0.15) : 0;
        const r = drehe(richtung, biegung * 0.5);
        const p = { x: vorher.x + (r.x * laenge) / schritte, y: vorher.y + (r.y * laenge) / schritte };
        punkte.push(p);
        segmente.push([vorher, p]);
        vorher = p;
      }
      const linie = strasse(punkte, 'ort', name, 1);
      nebenKnoten.push({ knoten: linie.knoten.slice(1), strasse: name, t: tWerte[idx] });
    }
  });

  // Stopps: alle Knoten der Durchfahrt außer Enden und Abzweigen, alle Knoten der Nebenstraßen
  const stopps: Array<{ stopp: Stopp }> = [];
  const neuerStopp = (knoten: KnotenId, t: number, strasseName: string) => {
    stopps.push({
      stopp: { id: -1, knoten, bezirkId: bezirkFuerT(t), strasse: strasseName, gewicht: rng.zwischen(0.55, 1.6), haeuser: [] },
    });
  };
  for (let i = 1; i < hauptKnoten.length - 1; i++) {
    if (abzweige.includes(i)) continue;
    neuerStopp(hauptKnoten[i], tWerte[i], o.hauptstrasse);
  }
  for (const nk of nebenKnoten) for (const k of nk.knoten) neuerStopp(k, nk.t, nk.strasse);

  return { hauptKnoten, bezirke: bezirkListe, stopps, segmente };
}

function drehe(v: Vec2, w: number): Vec2 {
  const c = Math.cos(w);
  const s = Math.sin(w);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/**
 * Gangfolge im Bezirk: Rundweg ab Anfahrpunkt über alle Stopps (nächster Nachbar + 2-opt).
 * Liefert die Indizes der Stopps in Reihenfolge.
 */
function gangfolge(wege: Wegenetz, start: KnotenId, ziele: KnotenId[]): number[] {
  const n = ziele.length;
  const d = (i: number, j: number) => wege.distanz(i < 0 ? start : ziele[i], j < 0 ? start : ziele[j]);
  const offen = new Set(ziele.map((_, i) => i));
  const folge: number[] = [];
  let aktuell = -1;
  while (offen.size > 0) {
    let best = -1;
    for (const j of offen) if (best < 0 || d(aktuell, j) < d(aktuell, best) - 1e-9) best = j;
    folge.push(best);
    offen.delete(best);
    aktuell = best;
  }
  // 2-opt auf dem geschlossenen Rundweg (Start fix)
  const rund = [-1, ...folge, -1];
  let besser = true;
  while (besser) {
    besser = false;
    for (let i = 1; i < n; i++) {
      for (let k = i + 1; k <= n; k++) {
        const vorher = d(rund[i - 1], rund[i]) + d(rund[k], rund[k + 1]);
        const nachher = d(rund[i - 1], rund[k]) + d(rund[i], rund[k + 1]);
        if (nachher < vorher - 1e-9) {
          rund.splice(i, k - i + 1, ...rund.slice(i, k + 1).reverse());
          besser = true;
        }
      }
    }
  }
  return rund.slice(1, -1);
}

// ---------------------------------------------------------------------------------------
// Häuser
// ---------------------------------------------------------------------------------------

function setzeHaeuser(
  stopps: Stopp[],
  netz: { knoten: Knoten[]; kanten: Kante[] },
  segIndex: SegmentIndex,
  rng: Zufall,
  haeuser: Haus[],
): void {
  // Straßenrichtung je Knoten aus den anliegenden Kanten
  const richtung = new Map<KnotenId, Vec2>();
  for (const k of netz.kanten) {
    const a = netz.knoten[k.a];
    const c = netz.knoten[k.b];
    const v = { x: c.x - a.x, y: c.y - a.y };
    for (const id of [k.a, k.b]) {
      const r = richtung.get(id);
      if (!r) richtung.set(id, v);
      else if (r.x * v.x + r.y * v.y >= 0) richtung.set(id, { x: r.x + v.x, y: r.y + v.y });
      else richtung.set(id, { x: r.x - v.x, y: r.y - v.y });
    }
  }
  const raster = new PunktRaster(0.05);
  for (const s of stopps) {
    const k = netz.knoten[s.knoten];
    const r = richtung.get(s.knoten) ?? { x: 1, y: 0 };
    const len = Math.hypot(r.x, r.y) || 1;
    const t = { x: r.x / len, y: r.y / len };
    const q = { x: -t.y, y: t.x };
    const jeSeite = s.gewicht > 1.25 ? 2 : 1;
    for (const seite of [1, -1]) {
      for (let j = 0; j < jeSeite; j++) {
        const entlang = jeSeite === 2 ? (j === 0 ? -0.024 : 0.024) : rng.zwischen(-0.012, 0.012);
        const abstand = HAUS_ABSTAND + rng.zwischen(-0.004, 0.006);
        const p = { x: k.x + q.x * seite * abstand + t.x * entlang, y: k.y + q.y * seite * abstand + t.y * entlang };
        if (segIndex.abstand(p) < 0.022) continue;
        if (raster.naechster(p) < 0.03) continue;
        raster.add(p);
        const art: 0 | 1 | 2 = s.gewicht > 1.45 ? 2 : s.gewicht > 1.1 ? 1 : 0;
        const id = haeuser.length;
        haeuser.push({ id, x: rund(p.x), y: rund(p.y), rot: Math.atan2(t.y, t.x), art, stoppId: s.id });
        s.haeuser.push(id);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------
// Basis
// ---------------------------------------------------------------------------------------

function baueBasis(knoten: KnotenId): Welt['basis'] {
  // Halle 120 m × 50 m, Rampen an der Nordseite, Hof davor
  const pos = { x: 2.3, y: 4.95 };
  const breite = 0.12;
  const tiefe = 0.05;
  const rampen: Rampe[] = [];
  for (let i = 0; i < 8; i++) {
    rampen.push({ nr: i + 1, pos: { x: pos.x - breite / 2 + 0.012 + i * 0.0137, y: pos.y + tiefe / 2 + 0.009 } });
  }
  const parkplaetze: Vec2[] = [];
  for (let i = 0; i < 8; i++) parkplaetze.push({ x: pos.x - breite / 2 - 0.035, y: pos.y - 0.03 + i * 0.009 });
  return {
    name: 'Zustellbasis Musterhausen',
    knoten,
    pos,
    rot: 0,
    halle: { breiteKm: breite, tiefeKm: tiefe },
    rampen,
    bereitstellflaeche: { x: pos.x, y: pos.y + 0.004 },
    parkplaetze,
  };
}

// ---------------------------------------------------------------------------------------
// Landschaft
// ---------------------------------------------------------------------------------------

function setzeLandschaft(
  l: Welt['landschaft'],
  ortsteile: Ortsteil[],
  basisPos: Vec2,
  segIndex: SegmentIndex,
  haeuser: Haus[],
  rng: Zufall,
): void {
  const flussAbstand = (p: Vec2) => {
    let d = Infinity;
    for (let i = 1; i < l.fluss.length; i++) d = Math.min(d, punktSegment(p, l.fluss[i - 1], l.fluss[i]));
    return d;
  };
  const imOrt = (p: Vec2, puffer: number) => ortsteile.some((o) => Math.hypot(p.x - o.zentrum.x, p.y - o.zentrum.y) < o.radius + puffer);
  const beiBasis = (p: Vec2, r: number) => Math.hypot(p.x - basisPos.x, p.y - basisPos.y) < r;

  // Wäldchen
  const waelder: Array<Vec2 & { r: number }> = [];
  for (let versuch = 0; versuch < 400 && waelder.length < 8; versuch++) {
    const p = { x: rng.zwischen(0.3, 13.7), y: rng.zwischen(0.3, 9.7) };
    const r = rng.zwischen(0.25, 0.45);
    if (imOrt(p, r + 0.2) || flussAbstand(p) < r + 0.25 || beiBasis(p, 1) || segIndex.abstand(p) < r * 0.6) continue;
    if (waelder.some((w) => Math.hypot(w.x - p.x, w.y - p.y) < w.r + r + 0.6)) continue;
    waelder.push({ ...p, r });
  }

  // Felder als Flickenteppich
  const zelleB = 0.62;
  const zelleH = 0.46;
  const arten: FeldArt[] = ['wiese', 'wiese', 'acker', 'acker', 'weizen', 'weizen', 'raps'];
  for (let y = 0; y < 10; y += zelleH) {
    for (let x = 0; x < 14; x += zelleB) {
      const m = { x: x + zelleB / 2, y: y + zelleH / 2 };
      if (imOrt(m, 0.05) || flussAbstand(m) < 0.25 || beiBasis(m, 0.35)) continue;
      if (waelder.some((w) => Math.hypot(w.x - m.x, w.y - m.y) < w.r)) continue;
      const j = () => rng.zwischen(-0.03, 0.03);
      const e = 0.015;
      l.felder.push({
        art: rng.wahl(arten),
        ecken: [
          { x: x + e + j(), y: y + e + j() },
          { x: x + zelleB - e + j(), y: y + e + j() },
          { x: x + zelleB - e + j(), y: y + zelleH - e + j() },
          { x: x + e + j(), y: y + zelleH - e + j() },
        ],
      });
    }
  }

  const hausRaster = new PunktRaster(0.05);
  for (const h of haeuser) hausRaster.add(h);
  const baum = (p: Vec2, groesse: number) => {
    if (segIndex.abstand(p) < 0.025 || flussAbstand(p) < 0.07 || hausRaster.naechster(p) < 0.025) return;
    if (beiBasis(p, 0.12)) return;
    l.baeume.push({ x: rund(p.x), y: rund(p.y), groesse });
  };
  for (const w of waelder) {
    const anzahl = Math.round(w.r * 160);
    for (let i = 0; i < anzahl; i++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * w.r;
      baum({ x: w.x + Math.cos(a) * r, y: w.y + Math.sin(a) * r }, rng.zwischen(0.8, 1.3));
    }
  }
  // Ufergehölz
  for (let i = 1; i < l.fluss.length; i++) {
    const a = l.fluss[i - 1];
    const c = l.fluss[i];
    const len = Math.hypot(c.x - a.x, c.y - a.y);
    const q = { x: -(c.y - a.y) / len, y: (c.x - a.x) / len };
    for (let s = 0; s < len; s += 0.09) {
      for (const seite of [1, -1]) {
        if (rng() > 0.55) continue;
        const off = rng.zwischen(0.08, 0.15) * seite;
        baum({ x: a.x + ((c.x - a.x) * s) / len + q.x * off, y: a.y + ((c.y - a.y) * s) / len + q.y * off }, rng.zwischen(0.7, 1.1));
      }
    }
  }
  // Bäume im Ort
  for (const o of ortsteile) {
    for (let i = 0; i < 26; i++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * o.radius;
      baum({ x: o.zentrum.x + Math.cos(a) * r, y: o.zentrum.y + Math.sin(a) * r }, rng.zwischen(0.6, 1.0));
    }
  }
}

// ---------------------------------------------------------------------------------------
// Geometrie-Hilfen
// ---------------------------------------------------------------------------------------

export function punktSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Rasterindex für Abstand Punkt → nächstes Straßenstück */
class SegmentIndex {
  private zellen = new Map<string, number[]>();
  constructor(
    private segmente: Array<[Vec2, Vec2]>,
    private groesse: number,
  ) {
    segmente.forEach(([a, b], i) => {
      const x0 = Math.floor(Math.min(a.x, b.x) / groesse);
      const x1 = Math.floor(Math.max(a.x, b.x) / groesse);
      const y0 = Math.floor(Math.min(a.y, b.y) / groesse);
      const y1 = Math.floor(Math.max(a.y, b.y) / groesse);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) this.liste(`${x},${y}`).push(i);
    });
  }
  private liste(k: string): number[] {
    let l = this.zellen.get(k);
    if (!l) this.zellen.set(k, (l = []));
    return l;
  }
  /** Abstand zum nächsten Segment (nur im Umkreis von einer Zelle genau, sonst ≥ Zellgröße) */
  abstand(p: Vec2): number {
    const cx = Math.floor(p.x / this.groesse);
    const cy = Math.floor(p.y / this.groesse);
    let d = this.groesse;
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let y = cy - 1; y <= cy + 1; y++)
        for (const i of this.zellen.get(`${x},${y}`) ?? []) d = Math.min(d, punktSegment(p, this.segmente[i][0], this.segmente[i][1]));
    return d;
  }
}

class PunktRaster {
  private zellen = new Map<string, Vec2[]>();
  constructor(private groesse: number) {}
  add(p: Vec2): void {
    const k = `${Math.floor(p.x / this.groesse)},${Math.floor(p.y / this.groesse)}`;
    let l = this.zellen.get(k);
    if (!l) this.zellen.set(k, (l = []));
    l.push(p);
  }
  naechster(p: Vec2): number {
    const cx = Math.floor(p.x / this.groesse);
    const cy = Math.floor(p.y / this.groesse);
    let d = Infinity;
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let y = cy - 1; y <= cy + 1; y++) for (const q of this.zellen.get(`${x},${y}`) ?? []) d = Math.min(d, Math.hypot(p.x - q.x, p.y - q.y));
    return d;
  }
}
