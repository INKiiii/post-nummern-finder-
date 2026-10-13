/**
 * „Idee in Zahlen“: Was bringt der Leitstand in der Demo-Basis? Alles wird live aus dem
 * Rechenmodell berechnet – mit den aktuellen Annahmen und den erfundenen Daten von Musterhausen.
 *
 *   Alltag:      historisch gewachsener Startplan  →  Plan nach den Vorschlägen des Leitstands
 *   Ausfall:     Behälter bleiben liegen / Springer  →  Leitstand verteilt sie
 *   Panne:       Behälter im Fahrzeug bleiben liegen  →  Übergabe am Standort
 *   Stau:        Prognose ohne Sperrung  →  Prognose und Vorschlag mit Umweg
 *   Spitzentag:  Startplan mit Mehrmenge  →  Leitstand verteilt um
 */
import { standardAnnahmen, type Annahmen } from '../config';
import { G } from '../glossar';
import { erzeugeDemoTag } from './demo';
import { fmtDauer, fmtUhr } from './format';
import { Lagebild } from './lagebild';
import { addInhalt, bewertePlan, erstelleKontext, vergleiche, type Delta, type Kontext, type PlanAuswertung } from './modell';
import { optimiere } from './optimierer';
import { SimulierteScanner } from './simulation';
import { mitAusfall, mitSperrung, STAU_STRASSE, SZENARIEN, type SzenarioArt } from './szenarien';
import type { Inhalt, Plan, Tag, Welt } from './types';
import { erzeugeVorschlaege, tourName, type VorschlagArt } from './vorschlaege';

/** Uhrzeiten der Szenarien (wie im Leitstand) */
export const PANNE_ZEIT = 11 * 60 + 30;
export const STAU_ZEIT = 9 * 60 + 30;
export const AUSFALL_TOUR = 'T3';
export const PANNE_TOUR = 'T2';

export interface Variante {
  titel: string;
  text: string;
  aus: PlanAuswertung;
}

export interface ZahlenVergleich {
  art: 'alltag' | SzenarioArt;
  titel: string;
  wann: string;
  ohne: Variante;
  mit: Variante;
  /** mit gegenüber ohne (euroTag positiv = Ersparnis) */
  delta: Delta;
  /** gilt jeden Tag (Alltag) oder nur an diesem einen Tag */
  wiederkehrend: boolean;
  /** Behälter, die ohne Leitstand liegen blieben und mit ihm noch heute zugestellt werden */
  gerettet: { behaelter: string[]; menge: Inhalt };
  /** weitere Möglichkeit ohne Leitstand (z. B. Springer holen) */
  alternative?: Variante & { delta: Delta };
  /** worauf es in diesem Fall ankommt */
  kern: string;
  /** Überschrift der Änderung (Standard: Ersparnis mit Leitstand) */
  deltaTitel: string;
  /** betroffene Tour (Ausfall, Panne) */
  tourId?: string;
}

export interface EinzelVorschlag {
  art: VorschlagArt;
  titel: string;
  neu: PlanAuswertung;
  delta: Delta;
}

export interface IdeeInZahlen {
  alltag: ZahlenVergleich;
  /** die einzelnen Vorschläge für den Startplan (nicht addierbar) */
  vorschlaege: EinzelVorschlag[];
  szenarien: ZahlenVergleich[];
  /** Sendungen eines normalen Tages */
  menge: Inhalt;
  touren: number;
  behaelter: number;
}

const LEER: Inhalt = { pakete: 0, briefe: 0, zeitungen: 0 };

/** 1 → „1 Behälter“, 3 → „3 Behälter“ (Singular/Plural laut Glossar) */
function anzahl(n: number): string {
  return `${n} ${n === 1 ? G.behaelter : G.behaelterPlural}`;
}

/** Menge der Behälter (Inhalt laut Tag) */
function mengeVon(tag: Tag, ids: readonly string[]): Inhalt {
  return ids.reduce((m, b) => addInhalt(m, tag.behaelter[b]?.inhalt ?? LEER), LEER);
}

function vergleich(
  ctx: Kontext,
  art: ZahlenVergleich['art'],
  ohne: Variante,
  mit: Variante,
  opt: { wiederkehrend: boolean; kern: string; alternative?: Variante; titel?: string; wann?: string; deltaTitel?: string; tourId?: string },
): ZahlenVergleich {
  const gerettet = ohne.aus.liegen.behaelter.filter((b) => !mit.aus.liegen.behaelter.includes(b));
  const info = art === 'alltag' ? { titel: 'Ein ganz normaler Tag', wann: 'jeden Tag' } : SZENARIEN[art];
  return {
    art,
    titel: opt.titel ?? info.titel,
    wann: opt.wann ?? info.wann,
    ohne,
    mit,
    delta: vergleiche(ohne.aus, mit.aus, ctx.annahmen),
    wiederkehrend: opt.wiederkehrend,
    gerettet: { behaelter: gerettet, menge: mengeVon(ctx.tag, gerettet) },
    alternative: opt.alternative && { ...opt.alternative, delta: vergleiche(opt.alternative.aus, mit.aus, ctx.annahmen) },
    kern: opt.kern,
    deltaTitel: opt.deltaTitel ?? `Mit ${G.leitstand} gegenüber ohne`,
    tourId: opt.tourId,
  };
}

/** Ein Tag wie im Leitstand: Simulation (Wahrheit) → Scans → Lagebild; Lageänderung ab `zeit` */
function laufenderTag(welt: Welt, tag: Tag, plan: Plan, a: Annahmen, zeit: number, aendern: (lage: Lagebild, sim: SimulierteScanner) => Tag) {
  const ctx0 = erstelleKontext(welt, tag, a);
  const sim = new SimulierteScanner(erstelleKontext(welt, tag, standardAnnahmen()), plan, {});
  const lage = new Lagebild(ctx0, plan);
  const bis = (t: number) => {
    for (const e of sim.vorspulen(t)) lage.anwenden(e);
  };
  const live = (t: number, ctx: Kontext) => {
    const start = lage.startZustaende(t);
    const c: Kontext = { ...ctx, tag: { ...ctx.tag, start } };
    const rest = lage.restplan(start);
    return { ctx: c, rest, aus: bewertePlan(c, rest) };
  };
  bis(zeit);
  const vorher = live(zeit, ctx0);
  const neuerTag = aendern(lage, sim);
  const ctx = erstelleKontext(welt, neuerTag, a);
  const commits = lage.planSetzen(ctx, lage.plan, zeit);
  sim.planAktualisieren(erstelleKontext(welt, neuerTag, standardAnnahmen()), lage.plan, zeit, commits);
  bis(zeit + 1);
  return { vorher, nachher: live(zeit + 1, ctx) };
}

/** Alle Zahlen für die Seite „Idee in Zahlen“ */
export function berechneIdeeInZahlen(welt: Welt, a: Annahmen): IdeeInZahlen {
  const { tag, plan } = erzeugeDemoTag(welt);
  const ctx = erstelleKontext(welt, tag, a);
  const start = bewertePlan(ctx, plan);

  // Alltag: Startplan → Gesamtplan nach den Vorschlägen
  const vorschlaege = erzeugeVorschlaege(ctx, plan);
  const gesamt = vorschlaege.find((v) => v.art === 'gesamt');
  const optPlan = gesamt?.plan ?? optimiere(ctx, plan);
  const opt = gesamt?.neu ?? bewertePlan(ctx, optPlan);
  const alltag = vergleich(
    ctx,
    'alltag',
    { titel: 'Startplan', text: `historisch gewachsen: ${start.summe.aktiveTouren} ${G.touren}, feste Zuordnung der ${G.behaelterPlural}`, aus: start },
    { titel: `Mit ${G.leitstand}`, text: `Vorschläge übernommen: ${opt.summe.aktiveTouren} ${G.touren}, neu verteilt und sortiert`, aus: opt },
    { wiederkehrend: true, kern: 'Der Plan passt besser zur Menge: weniger Strecke, keine Überstunden, eine Tour frei.' },
  );

  const szenarien: ZahlenVergleich[] = [];

  // Ausfall morgens, ohne Springer
  {
    const tA = mitAusfall(tag, AUSFALL_TOUR, null);
    const cA = erstelleKontext(welt, tA, a);
    const ohne = bewertePlan(cA, plan);
    const v = erzeugeVorschlaege(cA, plan, { wiederkehrend: false }).find((x) => x.art === 'ausfall');
    const tS = mitAusfall(tag, AUSFALL_TOUR, a.springerVorlaufMin);
    const springer = bewertePlan(erstelleKontext(welt, tS, a), plan);
    if (v) {
      const n = tourName(ctx, AUSFALL_TOUR);
      szenarien.push(
        vergleich(
          cA,
          'ausfall',
          { titel: `Ohne ${G.leitstand}`, text: `${n} fällt aus, ihre ${anzahl(ohne.liegen.behaelter.length)} bleiben stehen.`, aus: ohne },
          { titel: `Mit ${G.leitstand}`, text: v.titel, aus: v.neu },
          {
            wiederkehrend: false,
            tourId: AUSFALL_TOUR,
            titel: `${n} fällt aus`,
            kern: v.neu.liegen.behaelter.length === 0 ? 'Alles wird zugestellt – ohne Springer.' : `${v.neu.liegen.behaelter.length} ${G.behaelterPlural} bleiben trotzdem liegen.`,
            alternative: { titel: `Oder: ${G.springer} holen`, text: `${G.springer} beginnt ${a.springerVorlaufMin} Min später, falls einer frei ist.`, aus: springer },
          },
        ),
      );
    }
  }

  // Panne mittags
  {
    const { nachher } = laufenderTag(welt, tag, plan, a, PANNE_ZEIT, (lage, sim) => {
      lage.defektMelden(PANNE_TOUR, PANNE_ZEIT);
      sim.defektSetzen(PANNE_TOUR);
      return tag;
    });
    const v = erzeugeVorschlaege(nachher.ctx, nachher.rest, { wiederkehrend: false }).find((x) => x.art === 'ausfall');
    if (v) {
      const n = tourName(ctx, PANNE_TOUR);
      const fz = tag.touren.find((t) => t.id === PANNE_TOUR)?.fahrzeugId ?? '';
      szenarien.push(
        vergleich(
          nachher.ctx,
          'defekt',
          { titel: `Ohne ${G.leitstand}`, text: `${n} steht um ${fmtUhr(PANNE_ZEIT)} mit ${anzahl(nachher.aus.liegen.behaelter.length)} an Bord.`, aus: nachher.aus },
          {
            titel: `Mit ${G.leitstand}`,
            text: `Übergabe am Standort ${fz}: ${v.uebergaben.map((u) => `${u.abgeben.join(', ')} → ${tourName(ctx, u.nach === PANNE_TOUR ? u.von : u.nach)} (${fmtUhr(u.zeit)})`).join(', ')}.`,
            aus: v.neu,
          },
          {
            wiederkehrend: false,
            tourId: PANNE_TOUR,
            titel: `Panne bei ${n} um ${fmtUhr(PANNE_ZEIT)}`,
            kern:
              v.neu.liegen.behaelter.length === 0
                ? 'Alles an Bord wird noch heute zugestellt.'
                : `${nachher.aus.liegen.behaelter.length - v.neu.liegen.behaelter.length} von ${anzahl(nachher.aus.liegen.behaelter.length)} werden noch heute zugestellt.`,
          },
        ),
      );
    }
  }

  // Stau vormittags: Sperrung der Mittelbrücke – hier geht es um Wissen, nicht um Euro
  {
    const { vorher, nachher } = laufenderTag(welt, tag, plan, a, STAU_ZEIT, () => mitSperrung(tag, welt, STAU_STRASSE));
    const spaeter = nachher.aus.tourIds
      .filter((id) => nachher.aus.touren[id].aktiv)
      .map((id) => nachher.aus.touren[id].ende - vorher.aus.touren[id].ende)
      .filter((d) => d > 0.5);
    const max = Math.max(0, ...spaeter);
    szenarien.push(
      vergleich(
        nachher.ctx,
        'stau',
        { titel: 'Plan ohne Sperrung', text: `So sah der Tag um ${fmtUhr(STAU_ZEIT)} aus.`, aus: vorher.aus },
        { titel: `Prognose im ${G.leitstand}`, text: `Mit Umweg über Nord- oder Südbrücke, sofort nach der Meldung.`, aus: nachher.aus },
        {
          wiederkehrend: false,
          deltaTitel: 'Was der Umweg kostet',
          kern:
            (spaeter.length > 0
              ? `${spaeter.length} ${spaeter.length === 1 ? G.tour + ' kommt' : G.touren + ' kommen'} bis zu ${fmtDauer(max)} später zurück. `
              : 'Der Umweg ändert hier kaum etwas. ') +
            `Wichtig ist: Der ${G.leitstand} weiß es sofort – Prognosen, Übergabezeiten und Vorschläge rechnen mit dem Umweg.`,
        },
      ),
    );
  }

  // Spitzentag
  {
    const sp = erzeugeDemoTag(welt, { mengenFaktor: 1 + a.spitzentagProzent / 100 });
    const cS = erstelleKontext(welt, sp.tag, a);
    const ohne = bewertePlan(cS, sp.plan);
    const liste = erzeugeVorschlaege(cS, sp.plan);
    const v = liste.find((x) => x.art === 'gesamt') ?? liste[0];
    if (v) {
      szenarien.push(
        vergleich(
          cS,
          'spitzentag',
          { titel: `Ohne ${G.leitstand}`, text: `Startplan mit +${a.spitzentagProzent} % Menge`, aus: ohne },
          { titel: `Mit ${G.leitstand}`, text: v.titel, aus: v.neu },
          {
            wiederkehrend: false,
            titel: `Spitzentag +${a.spitzentagProzent} %`,
            kern: 'Die Mehrmenge wird gleichmäßiger verteilt: weniger Überstunden, alle sind früher zurück.',
          },
        ),
      );
    }
  }

  return {
    alltag,
    vorschlaege: vorschlaege.map((v) => ({ art: v.art, titel: v.titel, neu: v.neu, delta: v.delta })),
    szenarien,
    menge: start.summe.menge,
    touren: tag.touren.length,
    behaelter: tag.behaelterIds.length,
  };
}

/** Anteile der Ersparnis (alt − neu je Kostenart) */
export function ersparnisAnteile(alt: PlanAuswertung, neu: PlanAuswertung) {
  const k = (x: PlanAuswertung) => x.summe.kosten;
  return {
    schicht: k(alt).schicht - k(neu).schicht,
    ueberstunden: k(alt).ueberstunden - k(neu).ueberstunden,
    km: k(alt).km - k(neu).km,
    fahrzeug: k(alt).fahrzeug - k(neu).fahrzeug,
  };
}
