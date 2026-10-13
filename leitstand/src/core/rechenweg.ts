/**
 * „Wie kommt die Zahl zustande?“ – Rechenwege mit den eingesetzten Werten.
 * Jede Zeile nennt Formel, eingesetzte Zahlen, Ergebnis und die verwendeten Annahmen.
 */
import { ANNAHMEN_INFO, schichtMin, type Annahmen, type AnnahmeSchluessel } from '../config';
import { G } from '../glossar';
import { fmtDauer, fmtEuro, fmtKm, fmtZahl } from './format';
import type { Delta, Kontext, PlanAuswertung, TourAuswertung } from './modell';

export interface RechenZeile {
  /** z. B. „Schicht“ */
  was: string;
  /** z. B. „8 h × 28,00 €/h“ */
  rechnung: string;
  /** z. B. „224,00 €“ */
  ergebnis: string;
  /** verwendete Annahmen (im UI änderbar) */
  annahmen: AnnahmeSchluessel[];
  /** Summenzeile */
  summe?: boolean;
}

export interface Rechenweg {
  titel: string;
  formel: string;
  zeilen: RechenZeile[];
  hinweise: string[];
}

function wert(a: Annahmen, k: AnnahmeSchluessel): string {
  const info = ANNAHMEN_INFO[k];
  const nachkomma = info.schritt < 0.1 ? 2 : info.schritt < 1 ? 1 : 0;
  const zahl = a[k].toLocaleString('de-DE', { maximumFractionDigits: nachkomma });
  const v = k === 'stundensatz' || k === 'fahrzeugFixProTag' ? fmtEuro(a[k]) : `${zahl} ${info.einheit}`;
  return k === 'stundensatz' ? `${v}/h` : v;
}

function tourName(ctx: Kontext, id: string): string {
  const t = ctx.tag.touren.find((x) => x.id === id);
  return t ? `${G.tour} ${t.nr}` : id;
}

/** Zeit einer Tour */
export function rechenwegTourZeit(ctx: Kontext, t: TourAuswertung): Rechenweg {
  const a = ctx.annahmen;
  const zeilen: RechenZeile[] = [];
  if (t.min.laden > 0) zeilen.push({ was: G.beladen, rechnung: wert(a, 'ladezeitMin'), ergebnis: fmtDauer(t.min.laden), annahmen: ['ladezeitMin'] });
  zeilen.push({
    was: 'Fahrt zwischen den Gebieten',
    rechnung: `${fmtKm(t.km.zwischen)} ÷ ${wert(a, 'tempoZwischenKmh')} × 60`,
    ergebnis: fmtDauer(t.min.fahrtZwischen),
    annahmen: ['tempoZwischenKmh'],
  });
  zeilen.push({
    was: 'Fahrt im Gebiet',
    rechnung: `${fmtKm(t.km.innen)} ÷ ${wert(a, 'tempoImGebietKmh')} × 60`,
    ergebnis: fmtDauer(t.min.fahrtInnen),
    annahmen: ['tempoImGebietKmh'],
  });
  zeilen.push({
    was: `Zustellung ${G.pakete}`,
    rechnung: `${fmtZahl(t.menge.pakete)} × ${wert(a, 'minProPaket')}`,
    ergebnis: fmtDauer(t.zustellung.pakete),
    annahmen: ['minProPaket'],
  });
  zeilen.push({
    was: `Zustellung ${G.briefe}`,
    rechnung: `${fmtZahl(t.menge.briefe)} × ${wert(a, 'sekProBrief')} ÷ 60`,
    ergebnis: fmtDauer(t.zustellung.briefe),
    annahmen: ['sekProBrief'],
  });
  zeilen.push({
    was: `Zustellung ${G.zeitungen}`,
    rechnung: `${fmtZahl(t.menge.zeitungen)} × ${wert(a, 'sekProZeitung')} ÷ 60`,
    ergebnis: fmtDauer(t.zustellung.zeitungen),
    annahmen: ['sekProZeitung'],
  });
  if (t.min.uebergabe > 0) zeilen.push({ was: G.uebergabe, rechnung: wert(a, 'uebergabeMin') + ' je Übergabe', ergebnis: fmtDauer(t.min.uebergabe), annahmen: ['uebergabeMin'] });
  if (t.min.warten > 0.5) zeilen.push({ was: 'Warten am Treffpunkt', rechnung: 'bis das andere Fahrzeug da ist', ergebnis: fmtDauer(t.min.warten), annahmen: [] });
  zeilen.push({ was: 'Arbeitszeit', rechnung: 'Summe', ergebnis: fmtDauer(t.dauer), annahmen: [], summe: true });
  const hinweise: string[] = [];
  if (t.ueberstundenMin > 0.5) hinweise.push(`Schicht ${wert(a, 'schichtStunden')} überschritten: ${fmtDauer(t.ueberstundenMin)} Überstunden.`);
  if (t.springer) hinweise.push(`Gefahren von einem ${G.springer}, Beginn später.`);
  return {
    titel: `Zeit ${tourName(ctx, t.tourId)}`,
    formel: 'Zeit = Beladen + Fahrzeit (zwischen Gebieten und im Gebiet) + Zustellzeit',
    zeilen,
    hinweise,
  };
}

/** Kosten einer Tour für einen Tag */
export function rechenwegTourKosten(ctx: Kontext, t: TourAuswertung): Rechenweg {
  const a = ctx.annahmen;
  if (!t.aktiv) {
    return {
      titel: `Kosten ${tourName(ctx, t.tourId)}`,
      formel: `Eine ${G.tour} ohne ${G.behaelterPlural} kostet 0 €.`,
      zeilen: [{ was: 'Kosten', rechnung: `keine ${G.behaelterPlural}`, ergebnis: fmtEuro(0), annahmen: [], summe: true }],
      hinweise: [],
    };
  }
  const zuschlag = 1 + a.ueberstundenZuschlagProzent / 100;
  const zeilen: RechenZeile[] = [
    {
      was: 'Schicht (voll bezahlt)',
      rechnung: `${wert(a, 'schichtStunden')} × ${wert(a, 'stundensatz')}`,
      ergebnis: fmtEuro(t.kosten.schicht),
      annahmen: ['schichtStunden', 'stundensatz'],
    },
    {
      was: 'Überstunden',
      rechnung: `${fmtZahl(t.ueberstundenMin / 60, 2)} h × ${wert(a, 'stundensatz')} × ${fmtZahl(zuschlag, 2)}`,
      ergebnis: fmtEuro(t.kosten.ueberstunden),
      annahmen: ['stundensatz', 'ueberstundenZuschlagProzent'],
    },
    {
      was: 'Kilometer',
      rechnung: `${fmtKm(t.km.gesamt)} × ${fmtEuro(a.euroProKm)}/km`,
      ergebnis: fmtEuro(t.kosten.km),
      annahmen: ['euroProKm'],
    },
    { was: `${G.fahrzeug} fix`, rechnung: 'je Tag', ergebnis: fmtEuro(t.kosten.fahrzeug), annahmen: ['fahrzeugFixProTag'] },
    { was: 'Kosten je Tag', rechnung: 'Summe', ergebnis: fmtEuro(t.kosten.summe), annahmen: [], summe: true },
  ];
  const hinweise = [
    `Arbeitszeit ${fmtDauer(t.dauer)} bei ${fmtDauer(schichtMin(a))} Schicht → ${t.ueberstundenMin > 0.5 ? `${fmtDauer(t.ueberstundenMin)} Überstunden` : 'keine Überstunden'}.`,
  ];
  return {
    titel: `Kosten ${tourName(ctx, t.tourId)}`,
    formel: 'Kosten = Schicht × Stundensatz + Überstunden × Stundensatz × (1 + Zuschlag) + km × €/km + Fahrzeug fix',
    zeilen,
    hinweise,
  };
}

/** Kosten des ganzen Plans (Summe der Touren) */
export function rechenwegPlanKosten(ctx: Kontext, p: PlanAuswertung): Rechenweg {
  const zeilen: RechenZeile[] = p.tourIds.map((id) => {
    const t = p.touren[id];
    return {
      was: tourName(ctx, id),
      rechnung: t.aktiv ? `${fmtDauer(t.dauer)}, ${fmtKm(t.km.gesamt)}` : `ohne ${G.behaelterPlural}`,
      ergebnis: fmtEuro(t.kosten.summe),
      annahmen: [],
    };
  });
  zeilen.push({ was: 'Summe je Tag', rechnung: `${p.summe.aktiveTouren} aktive ${G.touren}`, ergebnis: fmtEuro(p.summe.kosten.summe), annahmen: [], summe: true });
  return {
    titel: 'Kosten des Plans',
    formel: 'Summe der Kosten aller Touren',
    zeilen,
    hinweise: p.liegen.behaelter.length ? [`${p.liegen.behaelter.length} ${G.behaelterPlural} werden heute nicht zugestellt (in den Kosten nicht bewertet).`] : [],
  };
}

/** Ersparnis zwischen altem und neuem Plan */
export function rechenwegErsparnis(ctx: Kontext, alt: PlanAuswertung, neu: PlanAuswertung, d: Delta, wiederkehrend = true): Rechenweg {
  const a = ctx.annahmen;
  const zeilen: RechenZeile[] = [];
  for (const id of d.betroffen) {
    const x = alt.touren[id];
    const y = neu.touren[id];
    zeilen.push({
      was: tourName(ctx, id),
      rechnung: `${fmtEuro(x.kosten.summe)} → ${fmtEuro(y.kosten.summe)}`,
      ergebnis: fmtEuro(x.kosten.summe - y.kosten.summe),
      annahmen: [],
    });
  }
  zeilen.push({
    was: 'Ersparnis je Tag',
    rechnung: `${fmtEuro(alt.summe.kosten.summe)} − ${fmtEuro(neu.summe.kosten.summe)}`,
    ergebnis: fmtEuro(d.euroTag),
    annahmen: [],
    summe: true,
  });
  zeilen.push({
    was: 'Ersparnis je Jahr',
    rechnung: `${fmtEuro(d.euroTag)} × ${wert(a, 'zustelltageProJahr')}`,
    ergebnis: fmtEuro(d.euroJahr),
    annahmen: ['zustelltageProJahr'],
    summe: true,
  });
  const hinweise: string[] = [];
  if (d.aktiveTouren < 0) hinweise.push(`${-d.aktiveTouren} ${G.tour} weniger: Schicht, ${G.fahrzeug} fix und Strecke entfallen.`);
  if (Math.abs(d.km) > 0.05) hinweise.push(`Strecke ${d.km < 0 ? 'sinkt' : 'steigt'} um ${fmtKm(Math.abs(d.km))}.`);
  if (Math.abs(d.ueberstundenMin) > 0.5) hinweise.push(`Überstunden ${d.ueberstundenMin < 0 ? 'sinken' : 'steigen'} um ${fmtDauer(Math.abs(d.ueberstundenMin))}.`);
  if (!wiederkehrend) hinweise.push('Einmaliges Ereignis: Die Jahreszahl gilt nur, wenn die Lage jeden Tag so wäre.');
  hinweise.push('Beispielrechnung mit erfundenen Daten und den angezeigten Annahmen.');
  return {
    titel: 'Ersparnis',
    formel: `Ersparnis = Kosten alter Plan − Kosten neuer Plan; pro Jahr × Zustelltage`,
    zeilen,
    hinweise,
  };
}

export type Kostenart = 'schicht' | 'ueberstunden' | 'km' | 'fahrzeug';

export const KOSTENARTEN: Kostenart[] = ['schicht', 'ueberstunden', 'km', 'fahrzeug'];

export const KOSTENART_NAME: Record<Kostenart, string> = {
  schicht: 'Schichten (voll bezahlt)',
  ueberstunden: 'Überstunden',
  km: 'Kilometer',
  fahrzeug: `${G.fahrzeug} fix`,
};

const KOSTENART_FORMEL: Record<Kostenart, string> = {
  schicht: `Schichtkosten = aktive ${G.touren} × Schichtlänge × Stundensatz`,
  ueberstunden: 'Überstundenkosten = Überstunden × Stundensatz × (1 + Zuschlag)',
  km: 'Kilometerkosten = Strecke × Kosten je km',
  fahrzeug: `${G.fahrzeug}kosten = aktive ${G.touren} × Fixkosten je Tag`,
};

/** eine Kostenart eines Plans als Rechenzeile */
function kostenZeile(ctx: Kontext, art: Kostenart, name: string, p: PlanAuswertung): RechenZeile {
  const a = ctx.annahmen;
  const s = p.summe;
  switch (art) {
    case 'schicht':
      return { was: name, rechnung: `${s.aktiveTouren} × ${wert(a, 'schichtStunden')} × ${wert(a, 'stundensatz')}`, ergebnis: fmtEuro(s.kosten.schicht), annahmen: ['schichtStunden', 'stundensatz'] };
    case 'ueberstunden':
      return {
        was: name,
        rechnung: `${fmtZahl(s.ueberstundenMin / 60, 2)} h × ${wert(a, 'stundensatz')} × ${fmtZahl(1 + a.ueberstundenZuschlagProzent / 100, 2)}`,
        ergebnis: fmtEuro(s.kosten.ueberstunden),
        annahmen: ['stundensatz', 'ueberstundenZuschlagProzent'],
      };
    case 'km':
      return { was: name, rechnung: `${fmtKm(s.km)} × ${fmtEuro(a.euroProKm)}/km`, ergebnis: fmtEuro(s.kosten.km), annahmen: ['euroProKm'] };
    case 'fahrzeug':
      return { was: name, rechnung: `${s.aktiveTouren} × ${wert(a, 'fahrzeugFixProTag')}`, ergebnis: fmtEuro(s.kosten.fahrzeug), annahmen: ['fahrzeugFixProTag'] };
  }
}

function jahresZeilen(ctx: Kontext, tag: number, links: string): RechenZeile[] {
  const a = ctx.annahmen;
  return [
    { was: 'Ersparnis je Tag', rechnung: links, ergebnis: fmtEuro(tag), annahmen: [], summe: true },
    { was: 'Ersparnis je Jahr', rechnung: `${fmtEuro(tag)} × ${wert(a, 'zustelltageProJahr')}`, ergebnis: fmtEuro(tag * a.zustelltageProJahr), annahmen: ['zustelltageProJahr'], summe: true },
  ];
}

/** Ersparnis bei einer Kostenart (z. B. nur Kilometer) zwischen zwei Plänen */
export function rechenwegKostenart(ctx: Kontext, art: Kostenart, alt: PlanAuswertung, neu: PlanAuswertung, namen: [string, string]): Rechenweg {
  const x = alt.summe.kosten[art];
  const y = neu.summe.kosten[art];
  return {
    titel: `Ersparnis ${KOSTENART_NAME[art]}`,
    formel: KOSTENART_FORMEL[art],
    zeilen: [kostenZeile(ctx, art, namen[0], alt), kostenZeile(ctx, art, namen[1], neu), ...jahresZeilen(ctx, x - y, `${fmtEuro(x)} − ${fmtEuro(y)}`)],
    hinweise: ['Beispielrechnung mit erfundenen Daten und den angezeigten Annahmen.'],
  };
}

/** Ersparnis, wenn die frei gewordene Tour als Reserve im Dienst bleibt: nur Überstunden und Kilometer */
export function rechenwegOhneTourEinsparung(ctx: Kontext, alt: PlanAuswertung, neu: PlanAuswertung): Rechenweg {
  const ue = alt.summe.kosten.ueberstunden - neu.summe.kosten.ueberstunden;
  const km = alt.summe.kosten.km - neu.summe.kosten.km;
  return {
    titel: 'Ersparnis, wenn die freie Tour bleibt',
    formel: 'Ersparnis = weniger Überstunden + weniger Kilometer (Schicht und Fahrzeug bleiben)',
    zeilen: [
      { was: 'Überstunden', rechnung: `${fmtEuro(alt.summe.kosten.ueberstunden)} − ${fmtEuro(neu.summe.kosten.ueberstunden)}`, ergebnis: fmtEuro(ue), annahmen: ['stundensatz', 'ueberstundenZuschlagProzent'] },
      { was: 'Kilometer', rechnung: `${fmtEuro(alt.summe.kosten.km)} − ${fmtEuro(neu.summe.kosten.km)}`, ergebnis: fmtEuro(km), annahmen: ['euroProKm'] },
      ...jahresZeilen(ctx, ue + km, `${fmtEuro(ue)} + ${fmtEuro(km)}`),
    ],
    hinweise: [
      `Gilt, wenn die frei gewordene ${G.tour} weiter bezahlt wird, z. B. als Reserve für Ausfälle und Spitzentage.`,
      'Beispielrechnung mit erfundenen Daten und den angezeigten Annahmen.',
    ],
  };
}

/** Hochrechnung auf mehrere Zustellbasen (linear, jede Basis wie die Demo-Basis) */
export function rechenwegHochrechnung(ctx: Kontext, d: Delta): Rechenweg {
  const a = ctx.annahmen;
  return {
    titel: 'Hochrechnung',
    formel: 'Ersparnis = Ersparnis je Tag × Zustelltage × Zustellbasen',
    zeilen: [
      { was: `Ersparnis je Tag (${ctx.welt.name})`, rechnung: 'Startplan − Plan mit Leitstand', ergebnis: fmtEuro(d.euroTag), annahmen: [] },
      { was: 'Ersparnis je Jahr und Basis', rechnung: `${fmtEuro(d.euroTag)} × ${wert(a, 'zustelltageProJahr')}`, ergebnis: fmtEuro(d.euroJahr), annahmen: ['zustelltageProJahr'] },
      { was: 'Hochrechnung', rechnung: `${fmtEuro(d.euroJahr)} × ${wert(a, 'zustellbasen')}`, ergebnis: fmtEuro(d.euroJahr * a.zustellbasen), annahmen: ['zustellbasen'], summe: true },
    ],
    hinweise: [
      `${ctx.welt.name} ist erfunden. Die Hochrechnung nimmt an, dass jede Basis so viel Spielraum hat wie die Demo-Basis – das muss ein Pilot mit echten Daten zeigen.`,
      'Beispielrechnung mit erfundenen Daten und den angezeigten Annahmen.',
    ],
  };
}
