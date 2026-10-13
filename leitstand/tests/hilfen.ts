import { standardAnnahmen } from '../src/config';
import { erzeugeDemoTag } from '../src/core/demo';
import { erstelleKontext, morgenStart } from '../src/core/modell';
import type { Tag, Welt } from '../src/core/types';
import { erzeugeDemoWelt } from '../src/core/welt';

let welt: Welt | null = null;

/** Demo-Welt nur einmal je Testdatei erzeugen */
export function demoWelt(): Welt {
  return (welt ??= erzeugeDemoWelt());
}

export function demo(mengenFaktor = 1) {
  const w = demoWelt();
  const { tag, plan } = erzeugeDemoTag(w, { mengenFaktor });
  const a = standardAnnahmen();
  return { welt: w, tag, plan, a, ctx: erstelleKontext(w, tag, a) };
}

/**
 * Mini-Welt für exakte Handrechnungen:
 *
 *   Basis(0) ──9 km── A(1) ──3 km── B(2)
 *                       └──6 km── T(3)   (Treffpunkt)
 *
 * Bezirk X: Anfahrpunkt A, innen 3 km.  Bezirk Y: Anfahrpunkt B, innen 1,8 km.
 */
export function miniWelt(): Welt {
  const knoten = [
    { id: 0, x: 0, y: 0 },
    { id: 1, x: 9, y: 0 },
    { id: 2, x: 12, y: 0 },
    { id: 3, x: 9, y: 6 },
  ];
  const kanten = [
    { id: 0, a: 0, b: 1, laengeKm: 9, typ: 'haupt' as const, strasse: 'Hauptstraße' },
    { id: 1, a: 1, b: 2, laengeKm: 3, typ: 'haupt' as const, strasse: 'Hauptstraße' },
    { id: 2, a: 1, b: 3, laengeKm: 6, typ: 'land' as const, strasse: 'Landstraße' },
  ];
  const bezirk = (id: string, anfahrpunkt: number, innenKm: number) => ({
    id,
    name: `Bezirk ${id}`,
    ortsteilId: 'O',
    anfahrpunkt,
    stopps: [],
    innenWeg: [anfahrpunkt],
    innenKm,
    strassen: [],
  });
  return {
    seed: 1,
    name: 'Mini',
    breiteKm: 12,
    hoeheKm: 6,
    netz: { knoten, kanten },
    basis: {
      name: 'Basis',
      knoten: 0,
      pos: { x: 0, y: 0 },
      rot: 0,
      halle: { breiteKm: 0.1, tiefeKm: 0.05 },
      rampen: [{ nr: 1, pos: { x: 0, y: 0 } }, { nr: 2, pos: { x: 0, y: 0 } }],
      bereitstellflaeche: { x: 0, y: 0 },
      parkplaetze: [],
    },
    ortsteile: [{ id: 'O', name: 'Ort', zentrum: { x: 10, y: 0 }, radius: 2, bezirke: ['X', 'Y'] }],
    bezirke: { X: bezirk('X', 1, 3), Y: bezirk('Y', 2, 1.8) },
    bezirkIds: ['X', 'Y'],
    stopps: [],
    haeuser: [],
    treffpunkte: [{ id: 't', name: 'Treffpunkt T', knoten: 3 }],
    hauptstrassen: [],
    landschaft: { fluss: [], flussBreiteKm: 0, felder: [], baeume: [] },
  };
}

export function miniTag(inhaltX = { pakete: 10, briefe: 100, zeitungen: 20 }, inhaltY = { pakete: 5, briefe: 50, zeitungen: 0 }): Tag {
  return {
    datum: 'Test',
    touren: [
      { id: 'T1', nr: 1, fahrzeugId: 'E-01', pseudonym: 'Zusteller A', rampe: 1, schichtbeginn: 420, farbe: '#000' },
      { id: 'T2', nr: 2, fahrzeugId: 'E-02', pseudonym: 'Zusteller B', rampe: 2, schichtbeginn: 420, farbe: '#000' },
    ],
    fahrzeuge: [
      { id: 'E-01', typ: 'E-Transporter' },
      { id: 'E-02', typ: 'E-Transporter' },
    ],
    behaelter: {
      X: { id: 'X', zielbezirk: 'X', inhalt: inhaltX },
      Y: { id: 'Y', zielbezirk: 'Y', inhalt: inhaltY },
    },
    behaelterIds: ['X', 'Y'],
    start: { T1: morgenStart(0, 420), T2: morgenStart(0, 420) },
    sperrungen: [],
    mengenFaktor: 1,
  };
}
