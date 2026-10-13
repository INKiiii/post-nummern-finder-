/**
 * Nachrichten an die Fahrer/innen bei einer Umplanung: je betroffener Tour, was sich für
 * sie ändert – kurz genug für das Display eines Handscanners.
 *
 *   Neu: Behälter LI-S, Übergabe 13:10 am Treffpunkt Deichweg (von Tour 2)
 *   Abgeben: Behälter BI-W, Übergabe 11:15 am Treffpunkt Mühlenplatz (an Tour 4)
 *   Entfällt: Behälter AL-S (übernimmt Tour 2)
 *   Neue Reihenfolge: LI-N → LI-M → LI-S
 */
import { G } from '../glossar';
import { fmtUhr } from './format';
import { behaelterFolge, type Kontext, type PlanAuswertung } from './modell';
import type { Plan, UebergabeSchritt } from './types';

export type PunktArt = 'neu' | 'abgeben' | 'entfaellt' | 'bleibt' | 'uebergabeEntfaellt' | 'reihenfolge' | 'tourEntfaellt' | 'tourNeu';

export interface NachrichtPunkt {
  art: PunktArt;
  text: string;
  behaelterId?: string;
  /** Uhrzeit der Übergabe */
  zeit?: number;
}

export interface UmplanungsNachricht {
  tourId: string;
  titel: string;
  text: string;
  punkte: NachrichtPunkt[];
}

/** Beginn jeder Übergabe laut Auswertung (Übergabe-ID → Uhrzeit) */
export function uebergabeZeiten(aus: PlanAuswertung | null | undefined): Map<string, number> {
  const m = new Map<string, number>();
  if (!aus) return m;
  for (const t of Object.values(aus.touren)) for (const s of t.schritte) if (s.schritt.art === 'uebergabe') m.set(s.schritt.id, s.beginn);
  return m;
}

function uebergaben(plan: Plan, tourId: string): UebergabeSchritt[] {
  return (plan.touren[tourId]?.schritte ?? []).filter((s): s is UebergabeSchritt => s.art === 'uebergabe');
}

/**
 * Nachrichten für alle Touren, für die sich zwischen `alt` und `neu` etwas ändert.
 * `ctx` liefert die Startzustände ab jetzt (was ist an Bord, was ist erledigt);
 * `aus`/`altAus` die Uhrzeiten der Übergaben im neuen bzw. alten Plan.
 */
export function umplanungsNachrichten(
  ctx: Kontext,
  alt: Plan,
  neu: Plan,
  aus: PlanAuswertung | null,
  opt: { altAus?: PlanAuswertung | null; uebergabenErledigt?: ReadonlySet<string>; rueckgaengig?: boolean } = {},
): UmplanungsNachricht[] {
  const { tag, welt } = ctx;
  const zeitNeu = uebergabeZeiten(aus);
  const zeitAlt = uebergabeZeiten(opt.altAus);
  const fertig = opt.uebergabenErledigt ?? new Set<string>();
  const erledigt = new Set(Object.values(tag.start).flatMap((s) => s.erledigt));
  const tourVon = (plan: Plan, b: string) => tag.touren.find((t) => behaelterFolge(plan, t.id).includes(b))?.id ?? null;
  const name = (id: string | null) => (id ? `${G.tour} ${tag.touren.find((t) => t.id === id)?.nr ?? id}` : G.halle);
  const uhr = (m: Map<string, number>, id: string) => (m.has(id) ? `${fmtUhr(m.get(id)!)} ` : '');
  const bezirk = (b: string) => welt.bezirke[tag.behaelter[b].zielbezirk]?.name ?? '';

  const erg: UmplanungsNachricht[] = [];
  for (const t of tag.touren) {
    const st = tag.start[t.id];
    if (!st?.besetzt) continue;
    const fa = behaelterFolge(alt, t.id).filter((b) => !erledigt.has(b));
    const fn = behaelterFolge(neu, t.id).filter((b) => !erledigt.has(b));
    const ua = uebergaben(alt, t.id).filter((u) => !fertig.has(u.id));
    const un = uebergaben(neu, t.id).filter((u) => !fertig.has(u.id));
    const uaIds = new Set(ua.map((u) => u.id));
    const unIds = new Set(un.map((u) => u.id));
    const punkte: NachrichtPunkt[] = [];

    if (fa.length === 0 && fn.length > 0 && st.mussLaden) punkte.push({ art: 'tourNeu', text: `${name(t.id)} fährt heute.` });
    if (fa.length > 0 && fn.length === 0 && un.length === 0 && st.mussLaden) punkte.push({ art: 'tourEntfaellt', text: `${name(t.id)} entfällt heute.` });

    // neue Übergaben, bei denen diese Tour etwas abgibt
    for (const u of un) {
      if (uaIds.has(u.id)) continue;
      for (const b of u.abgeben)
        punkte.push({
          art: 'abgeben',
          behaelterId: b,
          zeit: zeitNeu.get(u.id),
          text: `Abgeben: ${G.behaelter} ${b}, Übergabe ${uhr(zeitNeu, u.id)}am ${G.treffpunkt} ${u.treffpunktName} (an ${name(u.partner)})`,
        });
    }
    // neue Behälter: über eine Übergabe, aus der Halle oder schon an Bord
    for (const b of fn) {
      if (fa.includes(b)) continue;
      const u = un.find((x) => x.aufnehmen.includes(b));
      if (u)
        punkte.push({
          art: 'neu',
          behaelterId: b,
          zeit: zeitNeu.get(u.id),
          text: `Neu: ${G.behaelter} ${b}, Übergabe ${uhr(zeitNeu, u.id)}am ${G.treffpunkt} ${u.treffpunktName} (von ${name(u.partner)})`,
        });
      else if (st.geladen.includes(b)) punkte.push({ art: 'bleibt', behaelterId: b, text: `${G.behaelter} ${b} bleibt im ${G.fahrzeug} (${bezirk(b)}).` });
      else if (st.mussLaden) punkte.push({ art: 'neu', behaelterId: b, text: `Neu: ${G.behaelter} ${b} (${bezirk(b)}), an ${G.rampe} ${t.rampe} laden` });
      else punkte.push({ art: 'neu', behaelterId: b, text: `Neu: ${G.behaelter} ${b} (${bezirk(b)})` });
    }
    // Behälter, die wegfallen (ohne die, die per Übergabe abgegeben werden)
    for (const b of fa) {
      if (fn.includes(b) || punkte.some((p) => p.art === 'abgeben' && p.behaelterId === b)) continue;
      const jetzt = tourVon(neu, b);
      punkte.push({
        art: 'entfaellt',
        behaelterId: b,
        text: jetzt ? `Entfällt: ${G.behaelter} ${b} (übernimmt ${name(jetzt)})` : `Entfällt: ${G.behaelter} ${b} (bleibt heute liegen)`,
      });
    }
    // Übergaben, die nicht mehr stattfinden
    for (const u of ua) {
      if (unIds.has(u.id)) continue;
      punkte.push({ art: 'uebergabeEntfaellt', zeit: zeitAlt.get(u.id), text: `Übergabe ${uhr(zeitAlt, u.id)}am ${G.treffpunkt} ${u.treffpunktName} entfällt.` });
    }
    // nur die Reihenfolge ist anders
    const gleicheMenge = fa.length === fn.length && fa.every((b) => fn.includes(b));
    if (gleicheMenge && fa.join() !== fn.join()) punkte.push({ art: 'reihenfolge', text: `Neue Reihenfolge: ${fn.join(' → ')}` });

    if (punkte.length === 0) continue;
    const titel = opt.rueckgaengig ? 'Umplanung zurückgenommen' : 'Umplanung';
    erg.push({ tourId: t.id, titel, text: punkte.map((p) => p.text).join('\n'), punkte });
  }
  return erg;
}
