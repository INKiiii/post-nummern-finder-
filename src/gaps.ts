// Lückenanzeige pro Straße: „Nummern 1 bis 40, es fehlen 17 und 23“.
// Berücksichtigt eigene Punkte (selbst gesetzt schließt die Lücke). Hat eine Straße nur
// Nummern einer Seite (z. B. nur ungerade), zählen nur Lücken dieser Seite.

import { formatRanges } from './core';
import type { Street } from './types';

export interface Gaps {
  min: number | null;
  max: number | null;
  missing: number[];
  text: string;
}

export function streetGaps(street: Street): Gaps {
  const present = new Set<number>();
  for (const n of street.numbers) {
    if (n.num === null) continue;
    present.add(n.num);
    if (n.to !== null) for (let k = n.num; k <= n.to && k - n.num < 500; k++) present.add(k);
  }
  if (!present.size) return { min: null, max: null, missing: [], text: 'Keine Hausnummern bekannt' };
  const nums = [...present].sort((a, b) => a - b);
  const min = nums[0];
  const max = nums[nums.length - 1];
  const odd = nums.filter((n) => n % 2).length;
  const even = nums.length - odd;
  // Einseitig bebaute Straße: nur die vorhandene Seite prüfen
  const oneSided = nums.length >= 2 && (Math.min(odd, even) === 0 || (nums.length >= 4 && Math.min(odd, even) <= Math.max(odd, even) * 0.1));
  const onlyParity = oneSided ? (odd > even ? 1 : 0) : null;
  const missing: number[] = [];
  for (let n = min; n <= max; n++) {
    if (onlyParity !== null && n % 2 !== onlyParity) continue;
    if (!present.has(n)) missing.push(n);
  }
  const range = min === max ? `Nr. ${min}` : `Nummern ${min} bis ${max}`;
  const side = onlyParity === null ? '' : onlyParity ? ' (nur ungerade)' : ' (nur gerade)';
  let text: string;
  if (!missing.length) text = `${range}${side}, keine Lücken`;
  else if (missing.length === 1) text = `${range}${side}, es fehlt ${missing[0]}`;
  else if (missing.length === 2) text = `${range}${side}, es fehlen ${missing[0]} und ${missing[1]}`;
  else text = `${range}${side}, es fehlen ${formatRanges(missing, 8)} (${missing.length})`;
  return { min, max, missing, text };
}
