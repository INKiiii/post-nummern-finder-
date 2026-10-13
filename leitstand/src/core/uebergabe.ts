/**
 * Übergaben im Tagesverlauf: Ein Fahrzeug gibt Behälter an einem Treffpunkt an ein anderes
 * ab, oder zwei Fahrzeuge tauschen Behälter. Beide fahren zum Treffpunkt; wer zuerst da ist,
 * wartet (das Rechenmodell rechnet die Wartezeit ein).
 *
 * Gesucht wird über alle Treffpunkte und alle Stellen in beiden Touren: erst grob geschätzt
 * (Umweg und Wartezeit in Euro), dann die besten Kandidaten genau mit dem Rechenmodell.
 */
import { bewertePlan, fahrMinuten, vergleiche, type Delta, type Kontext, type PlanAuswertung } from './modell';
import type { KnotenId, Plan, Schritt, Treffpunkt, UebergabeSchritt } from './types';

export interface UebergabeInfo {
  id: string;
  treffpunkt: Treffpunkt;
  /** Beginn der Übergabe (nach dem Warten) */
  zeit: number;
  /** Tour, die abgibt (bzw. erster Tauschpartner) */
  von: string;
  nach: string;
  /** von → nach */
  abgeben: string[];
  /** nach → von */
  aufnehmen: string[];
  wartenMin: Record<string, number>;
}

export interface UebergabeErgebnis {
  plan: Plan;
  auswertung: PlanAuswertung;
  delta: Delta;
  info: UebergabeInfo;
}

/** Wie viele Kandidaten genau bewertet werden */
const GENAU = 8;

export function uebergabeId(von: string, nach: string, abgeben: string[], aufnehmen: string[], treffpunkt: Treffpunkt): string {
  return `Ü:${von}>${nach}:${abgeben.join('+')}/${aufnehmen.join('+')}@${treffpunkt.id}`;
}

/** Tour, die den Behälter laut Startzustand an Bord hat (unterwegs), sonst null */
export function anBordVon(ctx: Kontext, behaelterId: string): string | null {
  for (const t of ctx.tag.touren) if (ctx.tag.start[t.id].geladen.includes(behaelterId)) return t.id;
  return null;
}

/** Kann diese Tour an einer Übergabe teilnehmen? (besetzt, fährt) */
export function kannUebergeben(ctx: Kontext, tourId: string): boolean {
  const s = ctx.tag.start[tourId];
  return !!s && s.besetzt && !s.defekt;
}

function knotenVon(ctx: Kontext, x: Schritt): KnotenId {
  return x.art === 'bezirk' ? ctx.welt.bezirke[ctx.tag.behaelter[x.behaelterId].zielbezirk].anfahrpunkt : x.treffpunkt;
}

/** Übergabe einfügen und die übernommenen Behälter an der günstigsten Stelle danach zustellen */
function einbauen(ctx: Kontext, liste: Schritt[], pos: number, u: UebergabeSchritt, neu: string[]): Schritt[] {
  const l = [...liste.slice(0, pos), u, ...liste.slice(pos)];
  const basis = ctx.welt.basis.knoten;
  const d = (x: KnotenId, y: KnotenId) => ctx.wege.distanz(x, y);
  for (const b of neu) {
    const ziel = ctx.welt.bezirke[ctx.tag.behaelter[b].zielbezirk].anfahrpunkt;
    let best = { k: pos + 1, umweg: Infinity };
    for (let k = pos + 1; k <= l.length; k++) {
      const vor = knotenVon(ctx, l[k - 1]);
      const nach = k < l.length ? knotenVon(ctx, l[k]) : basis;
      const umweg = d(vor, ziel) + d(ziel, nach) - d(vor, nach);
      if (umweg < best.umweg - 1e-9) best = { k, umweg };
    }
    l.splice(best.k, 0, { art: 'bezirk', behaelterId: b });
  }
  return l;
}

/**
 * Beste Übergabe zwischen Tour a und Tour b: a gibt `aNachB` ab, b gibt `bNachA` ab.
 * Liefert null, wenn es keinen gültigen Plan gibt.
 */
export function planeUebergabe(
  ctx: Kontext,
  plan: Plan,
  a: string,
  b: string,
  aNachB: string[],
  bNachA: string[],
  alt: PlanAuswertung = bewertePlan(ctx, plan),
): UebergabeErgebnis | null {
  if (a === b || !kannUebergeben(ctx, a) || !kannUebergeben(ctx, b)) return null;
  if (aNachB.length === 0 && bNachA.length === 0) return null;
  const sa = plan.touren[a]?.schritte ?? [];
  const sb = plan.touren[b]?.schritte ?? [];
  const von = (liste: string[]) => (x: Schritt) => x.art === 'bezirk' && liste.includes(x.behaelterId);
  if (!aNachB.every((x) => sa.some((s) => s.art === 'bezirk' && s.behaelterId === x))) return null;
  if (!bNachA.every((x) => sb.some((s) => s.art === 'bezirk' && s.behaelterId === x))) return null;

  // Stellen: Übergabe vor der ersten Zustellung der abgegebenen Behälter
  const grenzen = (liste: Schritt[], ab: string[]) => {
    const ohne = liste.filter((x) => !von(ab)(x));
    const erste = ab.length ? liste.findIndex(von(ab)) : ohne.length;
    // erst nachdem ein unterwegs aufgenommener Behälter an Bord ist
    let min = 0;
    liste.forEach((x, i) => {
      if (i < erste && x.art === 'uebergabe' && x.aufnehmen.some((y) => ab.includes(y))) min = i + 1;
    });
    return { ohne, min, max: erste };
  };
  const ga = grenzen(sa, aNachB);
  const gb = grenzen(sb, bNachA);

  const an = ctx.annahmen;
  const basis = ctx.welt.basis.knoten;
  const d = (x: KnotenId, y: KnotenId) => ctx.wege.distanz(x, y);
  const euroMin = an.stundensatz / 60;
  const euroKm = an.euroProKm + fahrMinuten(1, an.tempoZwischenKmh) * euroMin;
  /** Ort und Zeit vor Stelle i (aus der bisherigen Auswertung) */
  const vor = (t: string, i: number): { k: KnotenId; t: number } => {
    const ta = alt.touren[t];
    const st = ctx.tag.start[t];
    const x = i > 0 ? ta?.schritte[i - 1] : undefined;
    if (x) return { k: x.nach, t: x.ende };
    return { k: st.knoten, t: ta?.abfahrt ?? st.zeit + (st.mussLaden ? an.ladezeitMin : 0) };
  };
  const danach = (liste: Schritt[], i: number) => (i < liste.length ? knotenVon(ctx, liste[i]) : basis);
  const ziel = (x: string) => ctx.welt.bezirke[ctx.tag.behaelter[x].zielbezirk].anfahrpunkt;

  // grobe Schätzung aller Kandidaten
  const kandidaten: Array<{ tp: Treffpunkt; i: number; j: number; schaetzung: number }> = [];
  for (const tp of ctx.welt.treffpunkte) {
    const k = tp.knoten;
    const seite = (t: string, g: ReturnType<typeof grenzen>, neu: string[]) => {
      const erg: Array<{ i: number; t: number; euro: number }> = [];
      for (let i = g.min; i <= g.max; i++) {
        const p = vor(t, i);
        const n = danach(g.ohne, i);
        const hin = d(p.k, k);
        let km = hin + d(k, n) - d(p.k, n);
        for (const x of neu) km += d(k, ziel(x)) + d(ziel(x), n) - d(k, n);
        erg.push({ i, t: p.t + fahrMinuten(hin, an.tempoZwischenKmh), euro: km * euroKm });
      }
      return erg;
    };
    const la = seite(a, ga, bNachA);
    const lb = seite(b, gb, aNachB);
    for (const x of la) for (const y of lb) kandidaten.push({ tp, i: x.i, j: y.i, schaetzung: x.euro + y.euro + Math.abs(x.t - y.t) * euroMin });
  }
  kandidaten.sort((x, y) => x.schaetzung - y.schaetzung);

  // die besten genau bewerten
  let best: UebergabeErgebnis | null = null;
  for (const c of kandidaten.slice(0, GENAU)) {
    const id = uebergabeId(a, b, aNachB, bNachA, c.tp);
    const ua: UebergabeSchritt = { art: 'uebergabe', id, treffpunkt: c.tp.knoten, treffpunktName: c.tp.name, partner: b, abgeben: [...aNachB], aufnehmen: [...bNachA] };
    const ub: UebergabeSchritt = { art: 'uebergabe', id, treffpunkt: c.tp.knoten, treffpunktName: c.tp.name, partner: a, abgeben: [...bNachA], aufnehmen: [...aNachB] };
    const neu: Plan = {
      touren: { ...plan.touren, [a]: { schritte: einbauen(ctx, ga.ohne, c.i, ua, bNachA) }, [b]: { schritte: einbauen(ctx, gb.ohne, c.j, ub, aNachB) } },
      liegenLassen: [...plan.liegenLassen],
    };
    const aus = bewertePlan(ctx, neu);
    if (!aus.gueltig) continue;
    const delta = vergleiche(alt, aus, an);
    if (best && delta.euroTag <= best.delta.euroTag + 1e-6) continue;
    const sA = aus.touren[a].schritte.find((x) => x.schritt.art === 'uebergabe' && x.schritt.id === id);
    const sB = aus.touren[b].schritte.find((x) => x.schritt.art === 'uebergabe' && x.schritt.id === id);
    best = {
      plan: neu,
      auswertung: aus,
      delta,
      info: {
        id,
        treffpunkt: c.tp,
        zeit: sA?.beginn ?? 0,
        von: a,
        nach: b,
        abgeben: [...aNachB],
        aufnehmen: [...bNachA],
        wartenMin: { [a]: sA?.wartenMin ?? 0, [b]: sB?.wartenMin ?? 0 },
      },
    };
  }
  return best;
}

/** Tour, die den Behälter laut Plan zustellt */
export function tourMitBehaelter(plan: Plan, behaelterId: string): string | null {
  for (const [id, t] of Object.entries(plan.touren)) if (t.schritte.some((s) => s.art === 'bezirk' && s.behaelterId === behaelterId)) return id;
  return null;
}

/** Alle Touren als Ziel für einen Behälter an Bord: je Tour die beste Übergabe */
export function uebergabeZiele(ctx: Kontext, plan: Plan, behaelterId: string, alt: PlanAuswertung = bewertePlan(ctx, plan)): UebergabeErgebnis[] {
  const von = tourMitBehaelter(plan, behaelterId);
  if (!von || anBordVon(ctx, behaelterId) !== von) return [];
  const erg: UebergabeErgebnis[] = [];
  for (const t of ctx.tag.touren) {
    if (t.id === von) continue;
    const u = planeUebergabe(ctx, plan, von, t.id, [behaelterId], [], alt);
    if (u) erg.push(u);
  }
  return erg;
}

/** Tauschpartner für einen Behälter an Bord: jeder Behälter einer anderen Tour, je die beste Übergabe */
export function tauschUebergaben(ctx: Kontext, plan: Plan, behaelterId: string, alt: PlanAuswertung = bewertePlan(ctx, plan)): UebergabeErgebnis[] {
  const von = tourMitBehaelter(plan, behaelterId);
  if (!von || anBordVon(ctx, behaelterId) !== von) return [];
  const erg: UebergabeErgebnis[] = [];
  for (const t of ctx.tag.touren) {
    if (t.id === von || !kannUebergeben(ctx, t.id)) continue;
    const st = ctx.tag.start[t.id];
    for (const s of plan.touren[t.id]?.schritte ?? []) {
      if (s.art !== 'bezirk') continue;
      // der Partner muss den Behälter haben: an Bord oder (noch an der Rampe) aus der Halle
      if (!st.geladen.includes(s.behaelterId) && !st.mussLaden) continue;
      const u = planeUebergabe(ctx, plan, von, t.id, [behaelterId], [s.behaelterId], alt);
      if (u) erg.push(u);
    }
  }
  return erg.sort((x, y) => y.delta.euroTag - x.delta.euroTag);
}

/** Übergaben, die in `neu` dazugekommen sind (für Anzeige und Nachrichten) */
export function neueUebergaben(ctx: Kontext, alt: Plan, neu: Plan, aus: PlanAuswertung): UebergabeInfo[] {
  const vorher = new Set<string>();
  for (const t of Object.values(alt.touren)) for (const s of t.schritte) if (s.art === 'uebergabe') vorher.add(s.id);
  const erg: UebergabeInfo[] = [];
  const gesehen = new Set<string>();
  for (const tour of ctx.tag.touren) {
    for (const s of neu.touren[tour.id]?.schritte ?? []) {
      if (s.art !== 'uebergabe' || vorher.has(s.id) || gesehen.has(s.id)) continue;
      gesehen.add(s.id);
      const tp = ctx.welt.treffpunkte.find((x) => x.knoten === s.treffpunkt) ?? { id: String(s.treffpunkt), name: s.treffpunktName, knoten: s.treffpunkt };
      const sA = aus.touren[tour.id]?.schritte.find((x) => x.schritt.art === 'uebergabe' && x.schritt.id === s.id);
      const sB = aus.touren[s.partner]?.schritte.find((x) => x.schritt.art === 'uebergabe' && x.schritt.id === s.id);
      erg.push({
        id: s.id,
        treffpunkt: tp,
        zeit: sA?.beginn ?? 0,
        von: tour.id,
        nach: s.partner,
        abgeben: [...s.abgeben],
        aufnehmen: [...s.aufnehmen],
        wartenMin: { [tour.id]: sA?.wartenMin ?? 0, [s.partner]: sB?.wartenMin ?? 0 },
      });
    }
  }
  return erg;
}
