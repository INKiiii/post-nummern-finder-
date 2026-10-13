/**
 * Vorschläge des Leitstands. Jeder Vorschlag enthält den neuen Plan und die Änderung
 * gegenüber dem aktuellen Plan (Δ km, Δ Arbeitszeit, Δ €/Tag, Δ €/Jahr, betroffene Touren).
 *
 * Arten: Tour einsparen, Überlastung abbauen, Behälter umlegen, Reihenfolge ändern,
 * Ausfall auffangen und (als Zusammenfassung) Gesamtplan optimieren.
 */
import { G } from '../glossar';
import { fmtDauer, fmtKm, fmtUhr } from './format';
import { behaelterFolge, bewertePlan, vergleiche, type Delta, type Kontext, type PlanAuswertung } from './modell';
import { Loesung, Problem, einfuegen, loesungZuPlan, optimiere } from './optimierer';
import type { Plan } from './types';
import { anBordVon, defektAuffangen, ortName, neueUebergaben, tauschUebergaben, tourMitBehaelter, uebergabeZiele, type UebergabeErgebnis, type UebergabeInfo } from './uebergabe';

export type VorschlagArt = 'tourEinsparen' | 'ueberlastung' | 'umlegen' | 'reihenfolge' | 'ausfall' | 'gesamt';

export const VORSCHLAG_NAME: Record<VorschlagArt, string> = {
  tourEinsparen: `${G.tour} einsparen`,
  ueberlastung: 'Überlastung abbauen',
  umlegen: `${G.behaelter} umlegen`,
  reihenfolge: 'Reihenfolge ändern',
  ausfall: 'Ausfall auffangen',
  gesamt: 'Gesamtplan optimieren',
};

export interface Aenderung {
  behaelterId: string;
  /** null = Halle bzw. liegen gelassen */
  von: string | null;
  nach: string | null;
}

export interface Vorschlag {
  id: string;
  art: VorschlagArt;
  titel: string;
  text: string;
  plan: Plan;
  alt: PlanAuswertung;
  neu: PlanAuswertung;
  delta: Delta;
  aenderungen: Aenderung[];
  /** Touren mit geänderter Reihenfolge (ohne neue/entfernte Behälter) */
  reihenfolge: string[];
  /** Änderung wirkt jeden Tag (Planung) – sonst einmaliges Ereignis */
  wiederkehrend: boolean;
  /** z. B. „Überstunden drohen bei Tour 2 (+25 Min)“ */
  warnung?: string;
  /** neue Übergaben am Treffpunkt (nur im laufenden Tag) */
  uebergaben: UebergabeInfo[];
}

/** Was hat sich zwischen zwei Plänen geändert? */
export function planDiff(ctx: Kontext, alt: Plan, neu: Plan): { aenderungen: Aenderung[]; reihenfolge: string[] } {
  const wo = (plan: Plan) => {
    const m = new Map<string, string | null>();
    for (const t of ctx.tag.touren) for (const b of behaelterFolge(plan, t.id)) m.set(b, t.id);
    return m;
  };
  const a = wo(alt);
  const n = wo(neu);
  const aenderungen: Aenderung[] = [];
  for (const b of ctx.tag.behaelterIds) {
    const von = a.get(b) ?? null;
    const nach = n.get(b) ?? null;
    if (von !== nach) aenderungen.push({ behaelterId: b, von, nach });
  }
  const reihenfolge: string[] = [];
  for (const t of ctx.tag.touren) {
    const fa = behaelterFolge(alt, t.id);
    const fn = behaelterFolge(neu, t.id);
    const gleicheMenge = fa.length === fn.length && fa.every((b) => fn.includes(b));
    if (gleicheMenge && fa.join() !== fn.join()) reihenfolge.push(t.id);
  }
  return { aenderungen, reihenfolge };
}

export function tourName(ctx: Kontext, id: string | null): string {
  if (!id) return G.halle;
  const t = ctx.tag.touren.find((x) => x.id === id);
  return t ? `${G.tour} ${t.nr}` : id;
}

function ueberstundenWarnung(ctx: Kontext, aus: PlanAuswertung, nur: string[]): string | undefined {
  const liste = aus.tourIds
    .filter((id) => nur.includes(id) && aus.touren[id].ueberstundenMin > 0.5)
    .map((id) => `${tourName(ctx, id)} (+${fmtDauer(aus.touren[id].ueberstundenMin)})`);
  return liste.length ? `Überstunden drohen bei ${aufzaehlung(liste)}.` : undefined;
}

function aenderungsText(ctx: Kontext, aenderungen: Aenderung[]): string {
  const teile = aenderungen.map((x) =>
    x.nach === null
      ? `${G.behaelter} ${x.behaelterId} bleibt liegen`
      : x.von === null
        ? `${G.behaelter} ${x.behaelterId} → ${tourName(ctx, x.nach)}`
        : `${G.behaelter} ${x.behaelterId}: ${tourName(ctx, x.von)} → ${tourName(ctx, x.nach)}`,
  );
  return teile.join('; ');
}

function baue(
  ctx: Kontext,
  art: VorschlagArt,
  planAlt: Plan,
  alt: PlanAuswertung,
  planNeu: Plan,
  titel: string,
  text: (neu: PlanAuswertung, d: Delta, diff: ReturnType<typeof planDiff>) => string,
  wiederkehrend: boolean,
): Vorschlag | null {
  const neu = bewertePlan(ctx, planNeu);
  if (!neu.gueltig) return null;
  const delta = vergleiche(alt, neu, ctx.annahmen);
  const diff = planDiff(ctx, planAlt, planNeu);
  if (diff.aenderungen.length === 0 && diff.reihenfolge.length === 0) return null;
  return {
    id: planSignatur(planNeu),
    art,
    titel,
    text: text(neu, delta, diff),
    plan: planNeu,
    alt,
    neu,
    delta,
    aenderungen: diff.aenderungen,
    reihenfolge: diff.reihenfolge,
    wiederkehrend,
    warnung: ueberstundenWarnung(ctx, neu, delta.betroffen),
    uebergaben: neueUebergaben(ctx, planAlt, planNeu, neu),
  };
}

/** Kurzform eines Plans; gleiche Signatur = gleicher Plan */
export function planSignatur(plan: Plan): string {
  return Object.entries(plan.touren)
    .map(([id, t]) => `${id}:${t.schritte.map((s) => (s.art === 'bezirk' ? s.behaelterId : `Ü${s.id}`)).join('>')}`)
    .join('|') + `|liegen:${[...plan.liegenLassen].sort().join(',')}`;
}

export interface VorschlagOptionen {
  /** Planung für künftige Tage (true) oder Umplanung im laufenden Tag (false) */
  wiederkehrend?: boolean;
}

/** Alle sinnvollen Vorschläge für den aktuellen Plan, beste zuerst */
export function erzeugeVorschlaege(ctx: Kontext, plan: Plan, opt: VorschlagOptionen = {}): Vorschlag[] {
  const wiederkehrend = opt.wiederkehrend ?? true;
  const alt = bewertePlan(ctx, plan);
  const liste: Vorschlag[] = [];
  const p = new Problem(ctx, plan);

  // Ausfall auffangen: unbesetzte Touren, deren Behälter noch eingeplant sind oder liegen bleiben würden
  const unbesetzt = ctx.tag.touren.filter((t) => !ctx.tag.start[t.id].besetzt);
  const ausfall = unbesetzt.filter((t) => behaelterFolge(plan, t.id).length > 0);
  if (ausfall.length > 0 || (unbesetzt.length > 0 && plan.liegenLassen.some((b) => p.beweglich.has(b)))) {
    const namen = (ausfall.length ? ausfall : unbesetzt).map((t) => tourName(ctx, t.id));
    const neu = optimiere(ctx, plan, { liegenLassenErlaubt: true, tourenAufloesen: false });
    const v = baue(
      ctx,
      'ausfall',
      plan,
      alt,
      neu,
      `Ausfall ${aufzaehlung(namen)} auffangen`,
      (n, _d, diff) => {
        const verteilt = diff.aenderungen.filter((x) => x.nach !== null).length;
        const liegen = n.liegen.behaelter.length;
        return `${verteilt} ${G.behaelterPlural} auf andere ${G.touren} verteilt${liegen ? `, ${liegen} bleiben liegen` : ', alles wird zugestellt'}. ${aenderungsText(ctx, diff.aenderungen)}.`;
      },
      false,
    );
    if (v) liste.push(v);
  }

  // Panne auffangen: die anderen holen die Behälter am Standort ab
  for (const t of ctx.tag.touren) {
    const st = ctx.tag.start[t.id];
    if (!st.defekt) continue;
    const offen = st.geladen.filter((b) => !st.erledigt.includes(b) && (plan.liegenLassen.includes(b) || behaelterFolge(plan, t.id).includes(b)));
    if (!offen.length) continue;
    const fz = t.fahrzeugId;
    const neuPlan = defektAuffangen(ctx, plan, t.id);
    const v = baue(
      ctx,
      'ausfall',
      plan,
      alt,
      neuPlan,
      `Panne ${tourName(ctx, t.id)} auffangen`,
      (n) => {
        const ueb = neueUebergaben(ctx, plan, neuPlan, n);
        const liste = ueb.map((u) => `${u.abgeben.join(', ')} → ${tourName(ctx, u.nach === t.id ? u.von : u.nach)} (${fmtUhr(u.zeit)})`);
        const bleiben = offen.filter((b) => n.liegen.behaelter.includes(b)).length;
        return (
          `${ueb.length} von ${offen.length} ${offen.length === 1 ? G.behaelter : G.behaelterPlural} ${ueb.length === 1 ? 'wird' : 'werden'} am Standort von ${fz} übergeben: ${liste.join(', ')}.` +
          (bleiben ? ` ${bleiben} ${bleiben === 1 ? 'bleibt' : 'bleiben'} heute liegen.` : ' Alles wird noch zugestellt.')
        );
      },
      false,
    );
    if (v) liste.push(v);
  }

  // Tour einsparen: zuerst nur die Behälter der Tour verteilen (kleinste Änderung),
  // wenn das nicht ohne neue Überstunden geht, mit dem Optimierer
  if (alt.gueltig) {
    let best: { v: Vorschlag; rang: number } | null = null;
    const kandidaten = ctx.tag.touren
      .filter((t) => alt.touren[t.id].aktiv && p.ziele.has(t.id) && behaelterFolge(plan, t.id).every((b) => p.beweglich.has(b)))
      .sort((x, y) => alt.touren[x.id].dauer - alt.touren[y.id].dauer);
    for (const t of kandidaten) {
      const l = new Loesung(p, Object.fromEntries(p.tourIds.map((id) => [id, behaelterFolge(plan, id)])), plan.liegenLassen);
      const offen = l.folgen[t.id];
      l.setze(t.id, []);
      const vorher = Object.fromEntries(p.tourIds.map((id) => [id, (l.folgen[id] ?? []).join()]));
      einfuegen(l, offen, false, [t.id]);
      // nur die aufnehmenden Touren neu ordnen
      for (const id of p.tourIds) if ((l.folgen[id] ?? []).join() !== vorher[id] && id !== t.id) l.setze(id, p.ordne(id, l.folgen[id]));
      let neu = loesungZuPlan(l, plan);
      const minimal = bewertePlan(ctx, neu);
      const keineNeuenUeberstunden = alt.tourIds.every((id) => minimal.touren[id].ueberstundenMin <= alt.touren[id].ueberstundenMin + 0.5);
      if (!minimal.gueltig || !keineNeuenUeberstunden || behaelterFolge(neu, t.id).length > 0) {
        neu = optimiere(ctx, plan, { gesperrteTouren: [t.id], tourenAufloesen: false });
      }
      const v = baue(
        ctx,
        'tourEinsparen',
        plan,
        alt,
        neu,
        `${tourName(ctx, t.id)} einsparen`,
        (n, _d, diff) => {
          const weg = diff.aenderungen.filter((x) => x.von === t.id);
          const ziele = [...new Set(weg.map((x) => tourName(ctx, x.nach)))];
          const sonst = diff.aenderungen.length - weg.length;
          return (
            `Die ${weg.length} ${G.behaelterPlural} von ${tourName(ctx, t.id)} passen ohne zusätzliche Überstunden in ${aufzaehlung(ziele)}. ` +
            `${tourName(ctx, t.id)} entfällt (${n.summe.aktiveTouren} statt ${alt.summe.aktiveTouren} ${G.touren}).` +
            (sonst > 0 ? ` Dazu ${sonst} weitere Umstellung${sonst === 1 ? '' : 'en'}.` : '')
          );
        },
        wiederkehrend,
      );
      if (!v || v.delta.aktiveTouren >= 0 || v.neu.liegen.behaelter.length > alt.liegen.behaelter.length) continue;
      if (alt.tourIds.some((id) => v.neu.touren[id].ueberstundenMin > alt.touren[id].ueberstundenMin + 0.5)) continue;
      // Rangfolge: Ersparnis, aber jede Nebenänderung zählt 10 € weniger (kleine Vorschläge bevorzugt)
      const rang = (x: Vorschlag) => x.delta.euroTag - 10 * x.aenderungen.filter((a) => a.von !== t.id).length;
      if (!best || rang(v) > best.rang + 1e-6) best = { v, rang: rang(v) };
    }
    if (best) liste.push(best.v);
  }

  // Überlastung abbauen: wenige Züge, die Überstunden senken
  if (alt.gueltig && alt.summe.ueberstundenMin > 0.5) {
    const ueberlastet = alt.tourIds.filter((id) => alt.touren[id].ueberstundenMin > 0.5);
    const l = new Loesung(p, Object.fromEntries(p.tourIds.map((id) => [id, behaelterFolge(plan, id)])), plan.liegenLassen);
    for (let i = 0; i < 3; i++) {
      const zug = besterEinzelzug(l, { nurAus: ueberlastet });
      if (!zug || zug.delta >= -1e-6) break;
      zug.ausfuehren();
      if (ueberlastet.every((id) => p.tour(id, l.folgen[id]).ueber <= 0.5)) break;
    }
    const neu = loesungZuPlan(l, plan);
    const v = baue(
      ctx,
      'ueberlastung',
      plan,
      alt,
      neu,
      `Überlastung ${aufzaehlung(ueberlastet.map((id) => tourName(ctx, id)))} abbauen`,
      (n, _d, diff) => {
        const enden = ueberlastet
          .map((id) => `${tourName(ctx, id)} endet ${fmtUhr(n.touren[id].ende)} statt ${fmtUhr(alt.touren[id].ende)}`)
          .join(', ');
        return `${aenderungsText(ctx, diff.aenderungen)}. ${enden}.`;
      },
      wiederkehrend,
    );
    if (v && v.delta.ueberstundenMin < -0.5) liste.push(v);
  }

  // Überlastung abbauen per Übergabe (unterwegs, wenn kein Fahrzeug mehr an der Rampe helfen kann)
  if (alt.gueltig && alt.summe.ueberstundenMin > 0.5 && !liste.some((v) => v.art === 'ueberlastung')) {
    const ueberlastet = alt.tourIds.filter((id) => alt.touren[id].ueberstundenMin > 0.5 && !ctx.tag.start[id].mussLaden);
    let best: { u: UebergabeErgebnis; o: string } | null = null;
    for (const o of ueberlastet) {
      for (const x of ctx.tag.start[o].geladen) {
        if (!behaelterFolge(plan, o).includes(x)) continue;
        for (const u of uebergabeZiele(ctx, plan, x, alt)) {
          const n = u.info.nach;
          if (u.auswertung.touren[n].ueberstundenMin > alt.touren[n].ueberstundenMin + 0.5) continue;
          if (u.delta.ueberstundenMin >= -0.5) continue;
          if (!best || u.delta.euroTag > best.u.delta.euroTag + 1e-6) best = { u, o };
        }
      }
    }
    if (best) {
      const { u, o } = best;
      const v = baue(
        ctx,
        'ueberlastung',
        plan,
        alt,
        u.plan,
        `Überlastung ${tourName(ctx, o)} abbauen`,
        (n) =>
          `${G.behaelter} ${u.info.abgeben.join(', ')}: ${tourName(ctx, u.info.von)} → ${tourName(ctx, u.info.nach)}, ` +
          `Übergabe ${fmtUhr(u.info.zeit)} am ${ortName(u.info.treffpunkt.name)}. ` +
          `${tourName(ctx, o)} endet ${fmtUhr(n.touren[o].ende)} statt ${fmtUhr(alt.touren[o].ende)}.`,
        false,
      );
      if (v) liste.push(v);
    }
  }

  // Behälter umlegen: bester einzelner Zug, der Kosten spart (ohne Tour aufzulösen)
  if (alt.gueltig) {
    const l = new Loesung(p, Object.fromEntries(p.tourIds.map((id) => [id, behaelterFolge(plan, id)])), plan.liegenLassen);
    const zug = besterEinzelzug(l, { nurAus: null });
    if (zug && zug.delta < -0.5) {
      zug.ausfuehren();
      const neu = loesungZuPlan(l, plan);
      const v = baue(
        ctx,
        'umlegen',
        plan,
        alt,
        neu,
        zug.titel,
        (_n, d, diff) => `${aenderungsText(ctx, diff.aenderungen)}. ${d.km < 0 ? `Spart ${fmtKm(-d.km)} Fahrstrecke.` : ''}`.trim(),
        wiederkehrend,
      );
      if (v && v.delta.euroTag > 0.5 && !liste.some((x) => x.id === v.id)) liste.push(v);
    }
  }

  // Reihenfolge ändern: je Tour, wenn sich spürbar Strecke sparen lässt
  if (alt.gueltig) {
    for (const t of ctx.tag.touren) {
      if (p.fest.has(t.id) || ctx.tag.start[t.id].defekt) continue;
      const f = behaelterFolge(plan, t.id);
      const neuFolge = p.ordne(t.id, f);
      if (p.kmZwischen(t.id, f) - p.kmZwischen(t.id, neuFolge) < 0.2) continue;
      const neu: Plan = structuredClone(plan);
      neu.touren[t.id] = { schritte: neuFolge.map((b) => ({ art: 'bezirk' as const, behaelterId: b })) };
      const v = baue(
        ctx,
        'reihenfolge',
        plan,
        alt,
        neu,
        `Reihenfolge ${tourName(ctx, t.id)} ändern`,
        (_n, d) => `Neue ${G.gangfolge}: ${neuFolge.join(' → ')}. Spart ${fmtKm(-d.km)} und ${fmtDauer(-d.arbeitMin)}.`,
        wiederkehrend,
      );
      if (v) liste.push(v);
    }
  }

  // Gesamtplan optimieren
  if (alt.gueltig) {
    const neu = optimiere(ctx, plan);
    const v = baue(
      ctx,
      'gesamt',
      plan,
      alt,
      neu,
      VORSCHLAG_NAME.gesamt,
      (n, d, diff) => {
        const teile = [
          `${n.summe.aktiveTouren} ${G.touren}${d.aktiveTouren !== 0 ? ` statt ${alt.summe.aktiveTouren}` : ''}`,
          `${diff.aenderungen.length} ${G.behaelterPlural} wechseln die ${G.tour}`,
          diff.reihenfolge.length ? `${diff.reihenfolge.length} ${G.touren} mit neuer Reihenfolge` : '',
          n.summe.ueberstundenMin > 0.5 ? `noch ${fmtDauer(n.summe.ueberstundenMin)} Überstunden` : 'keine Überstunden',
        ].filter(Boolean);
        return teile.join(', ') + '.';
      },
      wiederkehrend,
    );
    const bisherBest = Math.max(0, ...liste.map((x) => x.delta.euroTag));
    if (v && v.delta.euroTag > bisherBest + 0.5 && !liste.some((x) => x.id === v.id)) liste.push(v);
  }

  // Ausfall zuerst, Gesamtplan als Zusammenfassung zuletzt, sonst nach Ersparnis
  const prio = (v: Vorschlag) => (v.art === 'ausfall' ? 0 : v.art === 'gesamt' ? 2 : 1);
  return liste.sort((x, y) => prio(x) - prio(y) || y.delta.euroTag - x.delta.euroTag);
}

/** [a, b, c] → „a, b und c“ */
export function aufzaehlung(liste: string[]): string {
  if (liste.length <= 1) return liste.join('');
  return `${liste.slice(0, -1).join(', ')} und ${liste[liste.length - 1]}`;
}

interface Einzelzug {
  delta: number;
  titel: string;
  ausfuehren: () => void;
}

/** Bester einzelner Zug (Verschieben oder Tauschen). nurAus: nur Züge, die eine dieser Touren entlasten. */
function besterEinzelzug(l: Loesung, opt: { nurAus: string[] | null }): Einzelzug | null {
  const p = l.p;
  const ctx = p.ctx;
  let best: Einzelzug | null = null;
  const nimm = (z: Einzelzug) => {
    if (!best || z.delta < best.delta - 1e-6) best = z;
  };
  const ziele = p.tourIds.filter((t) => p.ziele.has(t));
  const quellen = opt.nurAus ?? ziele;
  for (const a of quellen) {
    if (!p.ziele.has(a)) continue;
    const fa = l.folgen[a] ?? [];
    for (let i = 0; i < fa.length; i++) {
      const b = fa[i];
      if (!p.beweglich.has(b)) continue;
      const ohne = p.ordne(a, [...fa.slice(0, i), ...fa.slice(i + 1)]);
      const dA = p.tour(a, ohne).wert - l.wert(a);
      for (const z of ziele) {
        if (z === a) continue;
        // keine leere Tour öffnen, das wäre eine zusätzliche Tour
        if ((l.folgen[z]?.length ?? 0) === 0) continue;
        const e = l.einfuegung(z, b);
        const neuZ = p.ordne(z, e.folge);
        const delta = dA + p.tour(z, neuZ).wert - l.wert(z);
        nimm({
          delta,
          titel: `${G.behaelter} ${b} zu ${tourName(ctx, z)} umlegen`,
          ausfuehren: () => {
            l.setze(a, ohne);
            l.setze(z, neuZ);
          },
        });
      }
      // Tauschen
      for (const z of ziele) {
        if (z === a) continue;
        const fz = l.folgen[z] ?? [];
        for (let j = 0; j < fz.length; j++) {
          const c = fz[j];
          if (!p.beweglich.has(c)) continue;
          const neuA = p.ordne(a, [...ohne, c]);
          const neuZ = p.ordne(z, [...fz.slice(0, j), ...fz.slice(j + 1), b]);
          const delta = p.tour(a, neuA).wert - l.wert(a) + p.tour(z, neuZ).wert - l.wert(z);
          nimm({
            delta,
            titel: `${G.behaelter} ${b} und ${c} tauschen`,
            ausfuehren: () => {
              l.setze(a, neuA);
              l.setze(z, neuZ);
            },
          });
        }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------
// „Andere Tour“ für einen Behälter
// ---------------------------------------------------------------------------------------

export interface TourOption {
  tourId: string;
  aktuell: boolean;
  plan: Plan;
  auswertung: PlanAuswertung;
  delta: Delta;
  /** Dauer der Zieltour danach */
  dauerDanach: number;
  endeDanach: number;
  ueberstundenDanach: number;
  /** ohne neue Überstunden möglich */
  machbar: boolean;
  beste: boolean;
}

/**
 * Alle Touren als Ziel für einen Behälter aus der Halle, mit Dauer danach, Δ km und Δ €.
 * Für Behälter an Bord eines abgefahrenen Fahrzeugs gibt es Übergaben (uebergabe.ts).
 */
export function optionenFuerBehaelter(ctx: Kontext, plan: Plan, behaelterId: string): TourOption[] {
  const p = new Problem(ctx, plan);
  if (!p.beweglich.has(behaelterId)) return [];
  const alt = bewertePlan(ctx, plan);
  const l = new Loesung(p, Object.fromEntries(p.tourIds.map((id) => [id, behaelterFolge(plan, id)])), plan.liegenLassen);
  const von = l.tourVon(behaelterId);
  const optionen: TourOption[] = [];
  for (const t of ctx.tag.touren) {
    if (t.id === von) {
      optionen.push({
        tourId: t.id,
        aktuell: true,
        plan,
        auswertung: alt,
        delta: vergleiche(alt, alt, ctx.annahmen),
        dauerDanach: alt.touren[t.id].dauer,
        endeDanach: alt.touren[t.id].ende,
        ueberstundenDanach: alt.touren[t.id].ueberstundenMin,
        machbar: true,
        beste: false,
      });
      continue;
    }
    if (!p.ziele.has(t.id)) continue;
    const v = l.kopie();
    if (von) v.setze(von, p.ordne(von, v.folgen[von].filter((b) => b !== behaelterId)));
    else v.liegen = v.liegen.filter((b) => b !== behaelterId);
    const e = v.einfuegung(t.id, behaelterId);
    v.setze(t.id, p.ordne(t.id, e.folge));
    const neuPlan = loesungZuPlan(v, plan);
    const aus = bewertePlan(ctx, neuPlan);
    const ziel = aus.touren[t.id];
    optionen.push({
      tourId: t.id,
      aktuell: false,
      plan: neuPlan,
      auswertung: aus,
      delta: vergleiche(alt, aus, ctx.annahmen),
      dauerDanach: ziel.dauer,
      endeDanach: ziel.ende,
      ueberstundenDanach: ziel.ueberstundenMin,
      machbar: ziel.ueberstundenMin <= alt.touren[t.id].ueberstundenMin + 0.5 && aus.gueltig,
      beste: false,
    });
  }
  // Beste Wahl: größte Ersparnis unter den machbaren (auch die aktuelle Tour kann die beste sein)
  let beste: TourOption | null = null;
  for (const o of optionen) if (o.machbar && (!beste || o.delta.euroTag > beste.delta.euroTag + 1e-6)) beste = o;
  if (beste) beste.beste = true;
  return optionen;
}

/** Schneller Plan ohne Optimierung: offene Behälter per Cheapest Insertion verteilen */
export function verteileOffene(ctx: Kontext, plan: Plan, liegenErlaubt = false): Plan {
  const p = new Problem(ctx, plan);
  const l = new Loesung(p, Object.fromEntries(p.tourIds.map((id) => [id, behaelterFolge(plan, id).filter((b) => !p.beweglich.has(b) || p.ziele.has(id))])), []);
  const offen = ctx.tag.behaelterIds.filter((b) => p.beweglich.has(b) && !l.tourVon(b));
  einfuegen(l, offen, liegenErlaubt);
  return loesungZuPlan(l, plan);
}

// ---------------------------------------------------------------------------------------
// Umplanen eines Behälters: andere Tour (aus der Halle oder per Übergabe) und Tauschen
// ---------------------------------------------------------------------------------------

export interface UmplanOption extends TourOption {
  /** null: Behälter steht in der Halle und wird einfach anders verladen */
  uebergabe: UebergabeInfo | null;
}

/** „Andere Tour“ für einen Behälter, egal ob in der Halle oder schon an Bord */
export function umplanOptionen(ctx: Kontext, plan: Plan, behaelterId: string): UmplanOption[] {
  const p = new Problem(ctx, plan);
  if (p.beweglich.has(behaelterId)) return optionenFuerBehaelter(ctx, plan, behaelterId).map((o) => ({ ...o, uebergabe: null }));
  const von = tourMitBehaelter(plan, behaelterId);
  if (!von || anBordVon(ctx, behaelterId) !== von) return [];
  const alt = bewertePlan(ctx, plan);
  const optionen: UmplanOption[] = [
    {
      tourId: von,
      aktuell: true,
      plan,
      auswertung: alt,
      delta: vergleiche(alt, alt, ctx.annahmen),
      dauerDanach: alt.touren[von].dauer,
      endeDanach: alt.touren[von].ende,
      ueberstundenDanach: alt.touren[von].ueberstundenMin,
      machbar: true,
      beste: false,
      uebergabe: null,
    },
  ];
  for (const u of uebergabeZiele(ctx, plan, behaelterId, alt)) {
    const z = u.auswertung.touren[u.info.nach];
    optionen.push({
      tourId: u.info.nach,
      aktuell: false,
      plan: u.plan,
      auswertung: u.auswertung,
      delta: u.delta,
      dauerDanach: z.dauer,
      endeDanach: z.ende,
      ueberstundenDanach: z.ueberstundenMin,
      machbar: z.ueberstundenMin <= alt.touren[u.info.nach].ueberstundenMin + 0.5,
      beste: false,
      uebergabe: u.info,
    });
  }
  let beste: UmplanOption | null = null;
  for (const o of optionen) if (o.machbar && (!beste || o.delta.euroTag > beste.delta.euroTag + 1e-6)) beste = o;
  if (beste) beste.beste = true;
  return optionen;
}

export interface TauschOption {
  tourId: string;
  /** Behälter der anderen Tour */
  partner: string;
  plan: Plan;
  auswertung: PlanAuswertung;
  delta: Delta;
  uebergabe: UebergabeInfo | null;
  /** keine neuen Überstunden */
  machbar: boolean;
}

/** „Gebiet tauschen“: Behälter gegen einen Behälter einer anderen Tour, beste zuerst */
export function tauschOptionen(ctx: Kontext, plan: Plan, behaelterId: string): TauschOption[] {
  const p = new Problem(ctx, plan);
  const alt = bewertePlan(ctx, plan);
  const machbar = (aus: PlanAuswertung) => aus.gueltig && alt.tourIds.every((id) => aus.touren[id].ueberstundenMin <= alt.touren[id].ueberstundenMin + 0.5);
  const erg: TauschOption[] = [];
  const von = tourMitBehaelter(plan, behaelterId);
  if (!von) return [];
  if (p.beweglich.has(behaelterId) && p.ziele.has(von)) {
    // beide noch in der Halle: einfach tauschen und die Reihenfolge neu ordnen
    const fa = behaelterFolge(plan, von);
    for (const t of p.tourIds) {
      if (t === von || !p.ziele.has(t)) continue;
      for (const y of behaelterFolge(plan, t)) {
        if (!p.beweglich.has(y)) continue;
        const neu: Plan = structuredClone(plan);
        const na = p.ordne(von, fa.map((b) => (b === behaelterId ? y : b)));
        const nb = p.ordne(t, behaelterFolge(plan, t).map((b) => (b === y ? behaelterId : b)));
        neu.touren[von] = { schritte: na.map((b) => ({ art: 'bezirk' as const, behaelterId: b })) };
        neu.touren[t] = { schritte: nb.map((b) => ({ art: 'bezirk' as const, behaelterId: b })) };
        const aus = bewertePlan(ctx, neu);
        if (!aus.gueltig) continue;
        erg.push({ tourId: t, partner: y, plan: neu, auswertung: aus, delta: vergleiche(alt, aus, ctx.annahmen), uebergabe: null, machbar: machbar(aus) });
      }
    }
  } else if (anBordVon(ctx, behaelterId) === von) {
    for (const u of tauschUebergaben(ctx, plan, behaelterId, alt)) {
      erg.push({ tourId: u.info.nach, partner: u.info.aufnehmen[0], plan: u.plan, auswertung: u.auswertung, delta: u.delta, uebergabe: u.info, machbar: machbar(u.auswertung) });
    }
  }
  return erg.sort((x, y) => Number(y.machbar) - Number(x.machbar) || y.delta.euroTag - x.delta.euroTag);
}
