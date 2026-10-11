// Normalisierung von Straßennamen für Abgleich und Suche.
// "Elbuferstr." / "Elbufer-Straße" / "elbuferstrasse" -> "elbuferstrasse"

const UMLAUTS = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', é: 'e', è: 'e', á: 'a', à: 'a' };

/** Kleinschreibung, Umlaute ausgeschrieben, "str." -> "strasse". Leerzeichen bleiben. */
export function foldText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[äöüßéèáà]/g, (c) => UMLAUTS[c])
    .replace(/\bstr\b\.?/g, 'strasse')
    .replace(/str\./g, 'strasse')
    .replace(/(\w)str\b/g, '$1strasse')
    .replace(/\bst\.\s*/g, 'sankt ')
    .replace(/[-–'’.,/()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Kompakter Schlüssel ohne Leerzeichen, für Gleichheitsvergleiche. */
export function normStreet(s) {
  return foldText(s).replace(/\s+/g, '');
}

/** Levenshtein-Distanz mit Abbruch bei max. */
export function editDistance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}
