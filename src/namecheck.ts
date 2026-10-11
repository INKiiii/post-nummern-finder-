// Warnt, wenn im Freitext offensichtlich ein Personenname steht.
// Es werden keine Namen gespeichert – das Feld ist nur für Hinweise wie "Hund".

const TITLES = /\b(familie|fam\.?|herr|herrn|frau|hr\.|fr\.|dr\.|prof\.|c\/o|z\.\s?hd\.?)\s*[a-zäöüß]/i;

// Häufige Nachnamen (Auswahl) und Vornamen – nur zum Erkennen, nichts wird gespeichert.
const SURNAMES = new Set(
  (
    'müller schmidt schneider fischer weber meyer meier wagner becker schulz hoffmann schäfer richter ' +
    'schröder neumann zimmermann krüger hofmann hartmann lange schmitt werner schmitz krause lehmann köhler ' +
    'maier walter mayer huber peters scholz möller schubert friedrich ' +
    'günther berger winkler roth beck lorenz baumann franke albrecht schuster simon ludwig böhm kraus martin ' +
    'schumacher krämer vogt jäger seidel heinrich brandt haas schreiber schulte dietrich ziegler ' +
    'kuhn kühn pohl bergmann thomas voigt arnold wolff pfeiffer meyer petersen hansen jensen nielsen ' +
    'jansen janssen ahrens behrens wilke lüdemann bruns heitmann tiedemann rademacher hinrichs harms'
  ).split(' '),
);
const FIRSTNAMES = new Set(
  (
    'peter michael thomas andreas stefan klaus jürgen frank uwe hans wolfgang bernd dieter ralf sven jan jens lars kai tim ' +
    'max paul lukas felix jonas leon finn ben elias noah luca anna maria sabine petra monika ursula karin andrea claudia ' +
    'susanne julia lena laura lea sarah sophie emma mia hannah lisa nicole katrin anja heike birgit martina christina ' +
    'gabriele renate helga ingrid christian markus martin alexander daniel tobias florian sebastian matthias heinz horst ' +
    'werner gerhard günter manfred rolf erika elke silke inge ali mehmet ahmet mohammed fatma ayse'
  ).split(' '),
);

/** Liefert eine Warnung oder null. */
export function nameWarning(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (TITLES.test(t)) return 'Bitte keine Namen eintragen (z. B. "Familie …", "Herr …"). Nur Hinweise zur Zustellung.';
  const words = t
    .toLowerCase()
    .split(/[^a-zäöüß-]+/)
    .filter((w) => w.length > 1);
  if (words.some((w) => SURNAMES.has(w) || FIRSTNAMES.has(w))) {
    return 'Das sieht nach einem Namen aus. Bitte keine personenbezogenen Daten speichern.';
  }
  // "Vorname Nachname"-Muster: zwei großgeschriebene Wörter, die keine üblichen Hinweiswörter sind.
  const caps = t.match(/\b[A-ZÄÖÜ][a-zäöüß]+\s+[A-ZÄÖÜ][a-zäöüß]+\b/g) ?? [];
  const COMMON = /^(Briefkasten|Briefkästen|Tor|Tür|Hund|Hof|Garage|Einfahrt|Auffahrt|Keller|Klingel|Paket|Paketkasten|Haus|Hinterhaus|Nebengebäude|Eingang|Seite|Zaun|Pforte|Garten|Schuppen|Scheune|Carport|Treppe|Durchgang|Achtung|Vorsicht|Rechts|Links|Hinten|Vorne|Neben|Am|An|Bei|Im|Hinter|Vor|Nicht|Kein|Keine|Rein|Raus|Einwurf|Werktags|Morgens|Abends|Glocke|Briefschlitz|Schlitz|Kasten|Großer|Kleiner|Grüner|Roter|Weißer|Schwarzer|Blauer|Gelber|Grauer|Alter|Neuer)$/;
  for (const c of caps) {
    const [a, b] = c.split(/\s+/);
    if (!COMMON.test(a) && !COMMON.test(b)) {
      return 'Das sieht nach einem Namen aus. Bitte keine personenbezogenen Daten speichern.';
    }
  }
  return null;
}
