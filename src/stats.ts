// Tageszähler für die Begrüßung: Briefe heute (je gesuchte Adresse einmal), gestern zum Vergleich.

import { kvGet, kvSet } from './db';

interface DayStats {
  date: string;
  letters: string[]; // Schlüssel Straße|Nummer, damit Doppelaufrufe nicht zählen
}

const today = () => new Date().toLocaleDateString('sv'); // JJJJ-MM-TT, lokale Zeit

let cur: DayStats = { date: today(), letters: [] };
let yesterday = 0;

export async function loadStats() {
  const s = await kvGet<{ cur: DayStats; prev: number } | null>('dayStats', null);
  if (!s) return;
  if (s.cur.date === today()) {
    cur = s.cur;
    yesterday = s.prev;
  } else {
    // neuer Tag: gestriger Stand wird Vergleichswert
    yesterday = s.cur.letters.length;
    cur = { date: today(), letters: [] };
  }
}

export async function countLetter(key: string) {
  if (cur.date !== today()) {
    yesterday = cur.letters.length;
    cur = { date: today(), letters: [] };
  }
  if (cur.letters.includes(key)) return;
  cur.letters.push(key);
  await kvSet('dayStats', { cur, prev: yesterday });
}

export function lettersToday() {
  return cur.date === today() ? cur.letters.length : 0;
}

export function lettersYesterday() {
  return yesterday;
}
