/**
 * Szenarien für die Demo: Was passiert, wenn der Tag nicht nach Plan läuft? Jedes Szenario
 * verändert nur die Lage (wer ist da, welche Straße ist frei, wie viel Menge), nie den Plan –
 * den passt der Leitstand danach mit seinen Vorschlägen an.
 */
import { G } from '../glossar';
import type { Tag, Welt } from './types';

export type SzenarioArt = 'ausfall' | 'stau' | 'defekt' | 'spitzentag';

export interface SzenarioInfo {
  titel: string;
  /** wann es spielt */
  wann: string;
  text: string;
}

export const SZENARIEN: Record<SzenarioArt, SzenarioInfo> = {
  ausfall: {
    titel: `Zusteller fällt aus`,
    wann: 'morgens vor Schichtbeginn',
    text: `Ein Zusteller meldet sich krank. Ohne ${G.springer} blieben seine ${G.behaelterPlural} stehen – der ${G.leitstand} verteilt sie auf die anderen ${G.touren}.`,
  },
  stau: {
    titel: 'Stau: Unfall auf der Mittelbrücke',
    wann: 'vormittags, ab jetzt',
    text: 'Die Mittelbrücke ist nach einem Unfall gesperrt. Wer über den Fluss muss, fährt über die Nord- oder Südbrücke; die Prognosen und Vorschläge rechnen mit dem Umweg.',
  },
  defekt: {
    titel: 'Fahrzeugdefekt mittags',
    wann: 'mittags, ab jetzt',
    text: `Ein ${G.fahrzeug} meldet eine Störung: Es darf nach dem laufenden ${G.bezirk} nicht weiterfahren. Die anderen holen die ${G.behaelterPlural} am Standort ab.`,
  },
  spitzentag: {
    titel: 'Spitzentag',
    wann: 'ganzer Tag',
    text: 'Deutlich mehr Sendungen als sonst (z. B. vor Feiertagen). Der Startplan reicht nicht ohne Überstunden; der Leitstand zeigt, wo es eng wird, und verteilt um.',
  },
};

/** Straße, die im Stau-Szenario gesperrt wird */
export const STAU_STRASSE = 'Mittelbrücke';

/** Ausfall: Tour unbesetzt, oder ein Springer übernimmt mit späterem Beginn */
export function mitAusfall(tag: Tag, tourId: string, springerVorlaufMin: number | null): Tag {
  const s = tag.start[tourId];
  const neu =
    springerVorlaufMin === null
      ? { ...s, besetzt: false }
      : { ...s, springer: true, schichtbeginn: s.schichtbeginn + springerVorlaufMin, zeit: s.zeit + springerVorlaufMin };
  return { ...tag, start: { ...tag.start, [tourId]: neu } };
}

/** Sperrung einer Straße (alle ihre Kanten) */
export function mitSperrung(tag: Tag, welt: Welt, strasse: string): Tag {
  const h = welt.hauptstrassen.find((x) => x.name === strasse);
  if (!h) return tag;
  return { ...tag, sperrungen: [...new Set([...tag.sperrungen, ...h.kanten])] };
}
