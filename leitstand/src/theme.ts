/**
 * Farben und Gestaltung an einer Stelle. Eigenständiges, neutrales Design ohne Bezug zu einer Marke.
 */
export const THEME = {
  /** Tourfarben in der Reihenfolge Tour 1 … Tour 6, danach Springer */
  tourFarben: ['#2f6fde', '#e8743b', '#18a57b', '#8e5cd9', '#d6457a', '#23a9be'],
  springerFarbe: '#6b7686',

  ui: {
    hintergrund: '#eef1f5',
    flaeche: '#ffffff',
    flaecheGlas: 'rgba(255,255,255,0.86)',
    rand: '#d5dbe3',
    text: '#17202b',
    textLeise: '#5b6675',
    akzent: '#3a56d4',
    akzentText: '#ffffff',
    gut: '#13865b',
    warnung: '#b86e00',
    schlecht: '#c43b3b',
    annahme: '#7044c7',
  },

  szene: {
    himmelTag: '#cfe3f2',
    himmelDaemmerung: '#f3c9a3',
    himmelNacht: '#1d2636',
    boden: '#c9d8b0',
    wiese: '#b7d29a',
    acker: '#d9c49a',
    raps: '#e9dc8a',
    weizen: '#e3d3a4',
    wald: '#5f8d58',
    baumStamm: '#7a5a40',
    wasser: '#6fa8d6',
    strasseHaupt: '#8d939c',
    strasseOrt: '#a7acb3',
    strasseRand: '#f3f3ef',
    halle: '#e7e9ec',
    halleDach: '#9aa3ae',
    rampe: '#5d6773',
    bereitstell: '#d7dde4',
    haus: ['#efe6da', '#f2ece4', '#e6ded3', '#f4efe8', '#e9e1d6'],
    dach: ['#b9674f', '#9c5a48', '#8a8f99', '#a8735a', '#7d6a5e'],
    leuchten: '#fff3b0',
    sperrung: '#d63c3c',
  },
} as const;

export function tourFarbe(index: number, springer = false): string {
  if (springer) return THEME.springerFarbe;
  return THEME.tourFarben[index % THEME.tourFarben.length];
}
