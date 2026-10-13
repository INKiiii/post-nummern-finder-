/**
 * Sendungen je Stopp: Pakete einzeln (mit erfundener Sendungsnummer), Briefe und Zeitungen
 * nur als Menge. Briefe werden nicht einzeln gescannt; ihre Verteilung auf die Stopps ist
 * eine Schätzung nach Haushalten (Gewicht der Stopps).
 */
import { zufall } from './rng';
import type { Inhalt, Tag, Welt } from './types';

export interface Paket {
  id: string;
  behaelterId: string;
  stoppId: number;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const paketCache = new WeakMap<Tag, Map<string, Paket[]>>();

/** Pakete eines Behälters, jedem Stopp des Bezirks zugeordnet (deterministisch) */
export function paketeFuer(welt: Welt, tag: Tag, behaelterId: string): Paket[] {
  let c = paketCache.get(tag);
  if (!c) paketCache.set(tag, (c = new Map()));
  const vorhanden = c.get(behaelterId);
  if (vorhanden) return vorhanden;
  const b = tag.behaelter[behaelterId];
  const bz = welt.bezirke[b.zielbezirk];
  const rng = zufall(welt.seed * 31 + hash(behaelterId));
  const nr = Math.max(0, tag.behaelterIds.indexOf(behaelterId));
  const gewichte = bz.stopps.map((s) => welt.stopps[s].gewicht);
  const summe = gewichte.reduce((a, x) => a + x, 0);
  const liste: Paket[] = [];
  for (let i = 0; i < b.inhalt.pakete; i++) {
    let r = rng() * summe;
    let k = 0;
    while (k < gewichte.length - 1 && r > gewichte[k]) {
      r -= gewichte[k];
      k++;
    }
    // erfundene, eindeutige Sendungsnummer: Behälternummer + laufende Nummer
    liste.push({ id: `PK${String(101 + nr).padStart(3, '0')}${String(i + 1).padStart(4, '0')}`, behaelterId, stoppId: bz.stopps[k] });
  }
  c.set(behaelterId, liste);
  return liste;
}

/** Anteil eines Stopps an den Haushalten seines Bezirks */
export function stoppAnteil(welt: Welt, stoppId: number): number {
  const s = welt.stopps[stoppId];
  const bz = welt.bezirke[s.bezirkId];
  let summe = 0;
  for (const x of bz.stopps) summe += welt.stopps[x].gewicht;
  return s.gewicht / summe;
}

/** Geschätzte Mengen je Stopp für einen Behälter (Pakete gezählt, Briefe/Zeitungen anteilig) */
export function stoppMengen(welt: Welt, tag: Tag, behaelterId: string): Map<number, Inhalt> {
  const b = tag.behaelter[behaelterId];
  const bz = welt.bezirke[b.zielbezirk];
  const m = new Map<number, Inhalt>();
  for (const s of bz.stopps) {
    const a = stoppAnteil(welt, s);
    m.set(s, { pakete: 0, briefe: b.inhalt.briefe * a, zeitungen: b.inhalt.zeitungen * a });
  }
  for (const p of paketeFuer(welt, tag, behaelterId)) m.get(p.stoppId)!.pakete++;
  return m;
}

const adressCache = new WeakMap<Welt, Map<number, string>>();

/** Erfundene Adresse eines Stopps, z. B. „Lindenweg 7“ */
export function stoppAdresse(welt: Welt, stoppId: number): string {
  let c = adressCache.get(welt);
  if (!c) {
    c = new Map();
    const zaehler = new Map<string, number>();
    for (const s of welt.stopps) {
      const key = `${welt.bezirke[s.bezirkId].ortsteilId}|${s.strasse}`;
      const n = (zaehler.get(key) ?? 0) + 1;
      zaehler.set(key, n);
      c.set(s.id, `${s.strasse} ${2 * n - 1}`);
    }
    adressCache.set(welt, c);
  }
  return c.get(stoppId) ?? `${G_STOPP} ${stoppId}`;
}

const G_STOPP = 'Stopp';
