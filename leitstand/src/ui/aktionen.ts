/** Auswahl aus Listen und Panels: auswählen und hinfliegen; Umplanen mit Vorschau */
import { G } from '../glossar';
import { fmtUhr } from '../core/format';
import type { Kontext } from '../core/modell';
import { ortName, tourMitBehaelter } from '../core/uebergabe';
import { tauschOptionen, tourName, umplanOptionen, type TauschOption, type UmplanOption } from '../core/vorschlaege';
import { basisPosition, behaelterPosition, bezirkMitte, fahrzeugPosition } from '../szene/auswahl';
import { uebersichtsAbstand, uebersichtsPolar } from '../szene/Kamera';
import { S } from '../szene/koord';
import { useAnsicht, type Auswahl } from '../state/ansicht';
import { simUhr, useLeitstand, type Vorschau } from '../state/store';

export function waehleUndZeige(a: Auswahl): void {
  const { welt, tag, plan, lage } = useLeitstand.getState();
  const { waehlen, fliegen, folgenSetzen } = useAnsicht.getState();
  waehlen(a);
  if (!a || !welt || !tag || !plan) return;
  if (a.art === 'fahrzeug') {
    const p = fahrzeugPosition(welt, tag, a.id, lage, simUhr.zeit);
    fliegen({ ziel: [p.x, 0.3, p.z], distanz: p.unterwegs ? 70 : 14 });
    // fahrende Fahrzeuge behält die Kamera im Blick
    folgenSetzen(p.unterwegs ? a.id : null);
  } else if (a.art === 'behaelter') {
    const p = behaelterPosition(welt, tag, plan, a.id);
    fliegen({ ziel: [p.x, 0.3, p.z], distanz: 9 });
  } else if (a.art === 'bezirk') {
    const p = bezirkMitte(welt, a.id);
    fliegen({ ziel: [p.x, 0, p.z], distanz: 55 });
  } else if (a.art === 'basis') {
    basisZeigen();
  }
}

export function basisZeigen(): void {
  const { welt } = useLeitstand.getState();
  if (!welt) return;
  const p = basisPosition(welt);
  // von Nordosten auf die Rampen schauen
  useAnsicht.getState().fliegen({ ziel: [p.x, 0, p.z - 1.5], distanz: 22, polar: 0.92, azimut: Math.PI - 0.55 });
}

export function ganzeKarte(): void {
  const { welt } = useLeitstand.getState();
  if (!welt) return;
  useAnsicht.getState().fliegen({ ziel: [welt.breiteKm * 50, 0, -welt.hoeheKm * 50], distanz: uebersichtsAbstand(), polar: uebersichtsPolar(), azimut: 0 });
}

// ---------------------------------------------------------------------------------------
// Umplanen: Vorschau bauen und zeigen
// ---------------------------------------------------------------------------------------

/** Kamera so stellen, dass alle Beteiligten einer Vorschau zu sehen sind */
export function vorschauZeigen(v: Vorschau): void {
  const { welt, tag, lage } = useLeitstand.getState();
  if (!welt || !tag) return;
  const punkte: Array<{ x: number; z: number }> = [];
  for (const id of new Set([...v.delta.betroffen, ...v.aenderungen.flatMap((a) => [a.von, a.nach]).filter((x): x is string => !!x)])) {
    punkte.push(fahrzeugPosition(welt, tag, id, lage, simUhr.zeit));
  }
  for (const a of v.aenderungen) punkte.push(bezirkMitte(welt, tag.behaelter[a.behaelterId].zielbezirk));
  for (const u of v.uebergaben) {
    const k = welt.netz.knoten[u.treffpunkt.knoten];
    punkte.push({ x: k.x * S, z: -k.y * S });
  }
  if (!punkte.length) return;
  const xs = punkte.map((p) => p.x);
  const zs = punkte.map((p) => p.z);
  const mitte = { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 };
  const ausdehnung = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  const distanz = Math.min(uebersichtsAbstand(), Math.max(80, ausdehnung * 1.5 + 60));
  // breiter Bildschirm: die Vorschau-Karte liegt unten in der Mitte, also das Bild nach oben schieben
  const breit = typeof window !== 'undefined' && window.innerWidth >= 820;
  useAnsicht.getState().folgenSetzen(null);
  useAnsicht.getState().fliegen({ ziel: [mitte.x, 0, mitte.z + (breit ? distanz * 0.22 : 0)], distanz, azimut: 0 });
}

/** Vorschau öffnen (Uhr hält an) und hinfliegen */
export function vorschauOeffnen(v: Vorschau | null): void {
  if (!v) {
    useAnsicht.getState().hinweisSetzen('Dieser Plan ist so nicht möglich.');
    return;
  }
  useLeitstand.getState().vorschauSetzen(v);
  vorschauZeigen(v);
}

export function behaelterText(ctx: Kontext, id: string): string {
  return `${G.behaelter} ${id} (${ctx.welt.bezirke[ctx.tag.behaelter[id].zielbezirk].name})`;
}

/** Vorschau für „Andere Tour“ */
export function optionVorschau(o: UmplanOption, behaelterId: string): Vorschau | null {
  const s = useLeitstand.getState();
  const ctx = s.ctxLive;
  if (!ctx) return null;
  const von = tourMitBehaelter(s.restplan!, behaelterId);
  const u = o.uebergabe;
  const titel = `${G.behaelter} ${behaelterId}: ${tourName(ctx, von)} → ${tourName(ctx, o.tourId)}`;
  const text = u
    ? `Übergabe ${fmtUhr(u.zeit)} am ${ortName(u.treffpunkt.name)}. ${tourName(ctx, o.tourId)} endet ${fmtUhr(o.endeDanach)}.`
    : `${tourName(ctx, o.tourId)} lädt den ${G.behaelter} an ${G.rampe} ${ctx.tag.touren.find((t) => t.id === o.tourId)?.rampe} und endet ${fmtUhr(o.endeDanach)}.`;
  return s.vorschauBauen(o.plan, titel, 'andereTour', text);
}

/** Vorschau für „Gebiet tauschen“ */
export function tauschVorschau(o: TauschOption, behaelterId: string): Vorschau | null {
  const s = useLeitstand.getState();
  const ctx = s.ctxLive;
  if (!ctx) return null;
  const von = tourMitBehaelter(s.restplan!, behaelterId);
  const u = o.uebergabe;
  const titel = `${behaelterId} ⇄ ${o.partner} tauschen (${tourName(ctx, von)} ⇄ ${tourName(ctx, o.tourId)})`;
  const text = u
    ? `Übergabe ${fmtUhr(u.zeit)} am ${ortName(u.treffpunkt.name)}: beide ${G.behaelterPlural} wechseln das ${G.fahrzeug}.`
    : `Beide ${G.behaelterPlural} werden an der anderen ${G.rampe} verladen.`;
  return s.vorschauBauen(o.plan, titel, 'tauschen', text);
}

/** Ziehen bzw. Antippen: Behälter soll zu dieser Tour */
export function umplanenAuf(behaelterId: string, tourId: string): void {
  const s = useLeitstand.getState();
  const ctx = s.ctxLive;
  if (!ctx || !s.restplan) return;
  const optionen = umplanOptionen(ctx, s.restplan, behaelterId);
  const o = optionen.find((x) => x.tourId === tourId);
  if (!o) {
    useAnsicht.getState().hinweisSetzen(
      optionen.length === 0 ? `${G.behaelter} ${behaelterId} lässt sich gerade nicht umplanen.` : `${tourName(ctx, tourId)} kann ${G.behaelter} ${behaelterId} nicht übernehmen.`,
    );
    return;
  }
  if (o.aktuell) {
    useAnsicht.getState().hinweisSetzen(`${G.behaelter} ${behaelterId} gehört schon zu ${tourName(ctx, tourId)}.`);
    return;
  }
  vorschauOeffnen(optionVorschau(o, behaelterId));
}

/** Ziehen auf einen anderen Behälter: Gebiete tauschen */
export function tauschenMit(behaelterId: string, partner: string): void {
  const s = useLeitstand.getState();
  const ctx = s.ctxLive;
  if (!ctx || !s.restplan) return;
  const o = tauschOptionen(ctx, s.restplan, behaelterId).find((x) => x.partner === partner);
  if (!o) {
    useAnsicht.getState().hinweisSetzen(`${G.behaelter} ${behaelterId} und ${partner} lassen sich nicht tauschen.`);
    return;
  }
  vorschauOeffnen(tauschVorschau(o, behaelterId));
}
