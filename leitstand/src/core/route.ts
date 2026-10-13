import type { Kontext, PlanAuswertung } from './modell';
import type { KnotenId } from './types';

/** Knotenfolge der ganzen Tour: Start → Bezirke (mit Weg im Bezirk) bzw. Treffpunkte → Basis */
export function tourWeg(ctx: Kontext, aus: PlanAuswertung, tourId: string): KnotenId[] {
  const t = aus.touren[tourId];
  if (!t?.aktiv) return [];
  const weg: KnotenId[] = [];
  const anhaengen = (teil: KnotenId[]) => {
    if (weg.length && teil.length && weg[weg.length - 1] === teil[0]) weg.push(...teil.slice(1));
    else weg.push(...teil);
  };
  for (const s of t.schritte) {
    anhaengen(ctx.wege.pfad(s.von, s.nach));
    if (s.schritt.art === 'bezirk') {
      const bz = ctx.welt.bezirke[ctx.tag.behaelter[s.schritt.behaelterId].zielbezirk];
      anhaengen(bz.innenWeg);
    }
  }
  if (t.rueckfahrt) anhaengen(ctx.wege.pfad(t.rueckfahrt.von, ctx.welt.basis.knoten));
  return weg;
}
