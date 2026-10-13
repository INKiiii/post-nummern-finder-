/**
 * Sicht auf Behälter und Fahrzeuge zu einer Uhrzeit, abgeleitet aus Plan und Auswertung.
 * (Status, Gangfolge-Position, nächster Stopp, Restzeit, Fortschritt, Auslastung)
 */
import { schichtMin } from '../config';
import { G } from '../glossar';
import { behaelterFolge, type Kontext, type PlanAuswertung, type SchrittAuswertung } from './modell';
import type { Behaelter, Plan, TourStatus } from './types';

/**
 * Lade-Reihenfolge: zuletzt zuzustellen = zuerst geladen (hinten im Fahrzeug).
 * Liefert für jeden geladenen Behälter den Zeitpunkt, zu dem er im Fahrzeug ist.
 */
export function ladeZeiten(aus: PlanAuswertung, tourId: string): Map<string, number> {
  const t = aus.touren[tourId];
  const m = new Map<string, number>();
  if (!t?.aktiv || t.abfahrt === null || t.ladung.length === 0) return m;
  const reihenfolge = [...t.ladung].reverse();
  const dauer = t.abfahrt - t.start;
  reihenfolge.forEach((b, i) => m.set(b, t.start + (dauer * (i + 1)) / (reihenfolge.length + 1)));
  return m;
}

/** Status, Tour und Gangfolge-Position aller Behälter zur Zeit `zeit` */
export function behaelterSicht(ctx: Kontext, plan: Plan, aus: PlanAuswertung, zeit: number): Record<string, Behaelter> {
  const { tag } = ctx;
  const erg: Record<string, Behaelter> = {};
  for (const id of tag.behaelterIds) {
    erg[id] = { ...tag.behaelter[id], status: 'halle', tourId: null, gangfolgePos: null };
  }
  for (const t of tag.touren) {
    const s = tag.start[t.id];
    for (const b of s.erledigt) erg[b] = { ...erg[b], status: 'zugestellt', tourId: t.id };
    const folge = behaelterFolge(plan, t.id);
    folge.forEach((b, i) => {
      erg[b] = { ...erg[b], tourId: t.id, gangfolgePos: i + 1 };
    });
    const a = aus.touren[t.id];
    if (!a?.aktiv) continue;
    const geladen = ladeZeiten(aus, t.id);
    for (const b of s.geladen) erg[b] = { ...erg[b], status: 'unterwegs', tourId: erg[b].tourId ?? t.id };
    for (const [b, tLaden] of geladen) {
      if (zeit >= tLaden) erg[b] = { ...erg[b], status: 'verladen' };
    }
    if (a.abfahrt !== null && zeit >= a.abfahrt) for (const b of a.ladung) erg[b] = { ...erg[b], status: 'unterwegs' };
    for (const sa of a.schritte) {
      if (sa.schritt.art === 'bezirk' && zeit >= sa.ende) erg[sa.schritt.behaelterId] = { ...erg[sa.schritt.behaelterId], status: 'zugestellt' };
    }
  }
  return erg;
}

export interface NaechsterStopp {
  /** z. B. „Lindenau Süd“, „Treffpunkt Deichweg“, „Zustellbasis“ */
  name: string;
  art: 'bezirk' | 'uebergabe' | 'basis';
  ankunft: number;
  /** Minuten bis Ankunft (0, wenn schon dort) */
  restMin: number;
  /** schon dort und bei der Arbeit */
  vorOrt: boolean;
  /** Ende der Arbeit dort */
  ende: number;
}

export interface FahrzeugSicht {
  tourId: string;
  status: TourStatus;
  statusText: string;
  /** Behälter an Bord */
  ladung: string[];
  naechster: NaechsterStopp | null;
  abfahrt: number | null;
  rueckkehr: number;
  /** Anteil der Arbeit ab Abfahrt, 0…1 */
  fortschritt: number;
  /** Arbeitszeit ÷ Schicht */
  auslastung: number;
  /** erledigte Schritte (Bezirke/Übergaben) */
  erledigt: number;
  schritte: number;
}

function schrittName(ctx: Kontext, s: SchrittAuswertung): string {
  if (s.schritt.art === 'bezirk') return ctx.welt.bezirke[ctx.tag.behaelter[s.schritt.behaelterId].zielbezirk].name;
  return `${G.treffpunkt} ${s.schritt.treffpunktName}`;
}

export function fahrzeugSicht(ctx: Kontext, plan: Plan, aus: PlanAuswertung, tourId: string, zeit: number): FahrzeugSicht {
  const a = aus.touren[tourId];
  const s = ctx.tag.start[tourId];
  const sichtB = behaelterSicht(ctx, plan, aus, zeit);
  const ladung = Object.values(sichtB)
    .filter((b) => (b.status === 'verladen' || b.status === 'unterwegs') && b.tourId === tourId)
    .map((b) => b.id);
  // Behälter, die per Übergabe an Bord kamen, stehen in der Gangfolge dieser Tour
  const basis: Omit<FahrzeugSicht, 'status' | 'statusText' | 'naechster' | 'fortschritt'> = {
    tourId,
    ladung,
    abfahrt: a.abfahrt,
    rueckkehr: a.ende,
    auslastung: a.aktiv ? a.dauer / schichtMin(ctx.annahmen) : 0,
    erledigt: a.schritte.filter((x) => x.ende <= zeit).length,
    schritte: a.schritte.length,
  };
  if (!s.besetzt) return { ...basis, status: 'unbesetzt', statusText: 'Unbesetzt', naechster: null, fortschritt: 0 };
  if (!a.aktiv) return { ...basis, status: 'bereit', statusText: `Ohne ${G.behaelterPlural}`, naechster: null, fortschritt: 0 };
  const beginn = a.abfahrt ?? a.start;
  const fortschritt = Math.max(0, Math.min(1, (zeit - beginn) / Math.max(1, a.ende - beginn)));
  if (s.defekt) return { ...basis, status: 'defekt', statusText: 'Fahrzeugdefekt', naechster: null, fortschritt };

  if (zeit < a.start) {
    return { ...basis, status: 'bereit', statusText: `An ${G.rampe}, ${G.beladen.toLowerCase()} ab Schichtbeginn`, naechster: ersterStopp(ctx, a.schritte, zeit), fortschritt: 0 };
  }
  if (a.abfahrt !== null && zeit < a.abfahrt) {
    return { ...basis, status: 'beladen', statusText: `Wird beladen (${ladung.length} von ${a.ladung.length})`, naechster: ersterStopp(ctx, a.schritte, zeit), fortschritt: 0 };
  }
  if (zeit >= a.ende) {
    return { ...basis, status: 'zurueck', statusText: `Zurück an der ${G.zustellbasis}`, naechster: null, fortschritt: 1 };
  }
  const naechster = ersterStopp(ctx, a.schritte, zeit);
  if (naechster) {
    const text = naechster.vorOrt
      ? naechster.art === 'bezirk'
        ? `Stellt zu in ${naechster.name}`
        : `${G.uebergabe} am ${naechster.name}`
      : `Fährt nach ${naechster.name}`;
    return { ...basis, status: 'unterwegs', statusText: text, naechster, fortschritt };
  }
  const rf = a.rueckfahrt!;
  return {
    ...basis,
    status: 'rueckfahrt',
    statusText: `Rückfahrt zur ${G.zustellbasis}`,
    naechster: { name: G.zustellbasis, art: 'basis', ankunft: rf.ankunft, restMin: Math.max(0, rf.ankunft - zeit), vorOrt: false, ende: rf.ankunft },
    fortschritt,
  };
}

function ersterStopp(ctx: Kontext, schritte: SchrittAuswertung[], zeit: number): NaechsterStopp | null {
  const s = schritte.find((x) => x.ende > zeit);
  if (!s) return null;
  return {
    name: schrittName(ctx, s),
    art: s.schritt.art,
    ankunft: s.ankunft,
    restMin: Math.max(0, s.ankunft - zeit),
    vorOrt: zeit >= s.ankunft,
    ende: s.ende,
  };
}
