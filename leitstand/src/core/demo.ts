/**
 * Demo-Tag für Musterhausen: 6 Touren, 21 Behälter (einer je Zustellbezirk) und ein
 * „historisch gewachsener“ Startplan mit typischen Schieflagen:
 *   - Tour 1 ist überlastet (Überstunden),
 *   - Tour 2 fährt im Zickzack (Reihenfolge),
 *   - Tour 6 ist schwach ausgelastet und fährt quer über den Fluss.
 *
 * Die Mengen werden so kalibriert, dass die Touren im Startplan die Zielzeiten unten
 * erreichen (mit den Standard-Annahmen). Alles erfunden.
 */
import { standardAnnahmen, type Annahmen } from '../config';
import { pseudonym, G } from '../glossar';
import { tourFarbe } from '../theme';
import { zufall } from './rng';
import { bewertePlan, erstelleKontext, morgenStart, planAusFolgen } from './modell';
import type { BehaelterStamm, Fahrzeug, Plan, Tag, Tour, Welt } from './types';

export const SCHICHTBEGINN = 7 * 60;

/** Startplan: Behälter je Tour in Gangfolge */
export const STARTPLAN: Record<string, string[]> = {
  T1: ['AL-S', 'AL-N', 'BI-W', 'BI-M', 'BI-O'],
  T2: ['LI-N', 'EI-S', 'LI-S', 'LI-M'],
  T3: ['SE-W', 'SE-M', 'SE-O', 'EI-N'],
  T4: ['MB-W', 'MB-O', 'KI-S'],
  T5: ['RO-W', 'RO-O', 'WI-W'],
  T6: ['KI-N', 'WI-O'],
};

/** Zielzeiten der Touren im Startplan (Minuten von Schichtbeginn bis Rückkehr) */
const ZIELZEIT: Record<string, number> = {
  T1: 8.45 * 60,
  T2: 7.35 * 60,
  T3: 6.7 * 60,
  T4: 5.9 * 60,
  T5: 5.1 * 60,
  T6: 4.3 * 60,
};

export interface DemoOptionen {
  /** Mengenfaktor, z. B. 1,4 für einen Spitzentag */
  mengenFaktor?: number;
  datum?: string;
}

export function erzeugeDemoTag(welt: Welt, opt: DemoOptionen = {}): { tag: Tag; plan: Plan } {
  const rng = zufall(welt.seed + 1);
  const a: Annahmen = standardAnnahmen();
  const tourIds = Object.keys(STARTPLAN);

  const fahrzeuge: Fahrzeug[] = tourIds.map((_, i) => ({ id: `E-${String(i + 1).padStart(2, '0')}`, typ: G.fahrzeugTyp }));
  const touren: Tour[] = tourIds.map((id, i) => ({
    id,
    nr: i + 1,
    fahrzeugId: fahrzeuge[i].id,
    pseudonym: pseudonym(i + 1),
    rampe: i + 1,
    schichtbeginn: SCHICHTBEGINN,
    farbe: tourFarbe(i),
  }));

  // Rohmengen je Bezirk aus den Stopps (Haushalte), mit etwas Streuung je Sendungsart
  const behaelter: Record<string, BehaelterStamm> = {};
  for (const id of welt.bezirkIds) {
    const bz = welt.bezirke[id];
    let gewicht = 0;
    for (const s of bz.stopps) gewicht += welt.stopps[s].gewicht;
    behaelter[id] = {
      id,
      zielbezirk: id,
      inhalt: {
        pakete: gewicht * rng.zwischen(1.8, 2.6),
        briefe: gewicht * rng.zwischen(26, 36),
        zeitungen: gewicht * rng.zwischen(1.5, 3.5),
      },
    };
  }

  const start: Tag['start'] = {};
  for (const t of touren) start[t.id] = morgenStart(welt.basis.knoten, t.schichtbeginn);
  const tag: Tag = {
    datum: opt.datum ?? 'Dienstag, Beispieltag',
    touren,
    fahrzeuge,
    behaelter,
    behaelterIds: [...welt.bezirkIds],
    start,
    sperrungen: [],
    mengenFaktor: 1,
  };
  const plan = planAusFolgen(STARTPLAN);

  // Kalibrieren: Mengen je Tour so skalieren, dass die Zielzeit erreicht wird
  for (let runde = 0; runde < 3; runde++) {
    const aus = bewertePlan(erstelleKontext(welt, tag, a), plan);
    for (const id of tourIds) {
      const t = aus.touren[id];
      const fest = t.dauer - t.min.zustellung;
      const faktor = (ZIELZEIT[id] - fest) / t.min.zustellung;
      for (const b of STARTPLAN[id]) {
        const i = behaelter[b].inhalt;
        behaelter[b].inhalt = { pakete: i.pakete * faktor, briefe: i.briefe * faktor, zeitungen: i.zeitungen * faktor };
      }
    }
  }
  const f = opt.mengenFaktor ?? 1;
  for (const b of Object.values(behaelter)) {
    b.inhalt = {
      pakete: Math.round(b.inhalt.pakete * f),
      briefe: Math.round(b.inhalt.briefe * f),
      zeitungen: Math.round(b.inhalt.zeitungen * f),
    };
  }
  tag.mengenFaktor = f;
  return { tag, plan };
}
