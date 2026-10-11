// Parser für gesprochene Adressen: "Elbuferstraße hundertfünfundneunzig" -> {street, number:"195"}

const UNITS: Record<string, number> = {
  null: 0, ein: 1, eins: 1, eine: 1, einen: 1, zwei: 2, zwo: 2, drei: 3, vier: 4, fuenf: 5, fünf: 5,
  sechs: 6, sieben: 7, acht: 8, neun: 9,
};
const TEENS: Record<string, number> = {
  zehn: 10, elf: 11, zwoelf: 12, zwölf: 12, dreizehn: 13, vierzehn: 14, fuenfzehn: 15, fünfzehn: 15,
  sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19,
};
const TENS: Record<string, number> = {
  zwanzig: 20, dreissig: 30, dreißig: 30, vierzig: 40, fuenfzig: 50, fünfzig: 50, sechzig: 60,
  siebzig: 70, achtzig: 80, neunzig: 90,
};
const LETTERS: Record<string, string> = {
  a: 'a', ah: 'a', b: 'b', be: 'b', bee: 'b', c: 'c', ce: 'c', zeh: 'c', tse: 'c', d: 'd', de: 'd', dee: 'd',
  e: 'e', eh: 'e', f: 'f', ef: 'f', eff: 'f', g: 'g', ge: 'g', h: 'h', ha: 'h',
};
const FILLER = new Set(['nummer', 'hausnummer', 'nr', 'nr.', 'no', 'haus']);

function below100(w: string): number | null {
  if (w in UNITS) return UNITS[w];
  if (w in TEENS) return TEENS[w];
  if (w in TENS) return TENS[w];
  const i = w.indexOf('und');
  if (i > 0) {
    const u = UNITS[w.slice(0, i)];
    const t = TENS[w.slice(i + 3)];
    if (u !== undefined && u > 0 && t !== undefined) return u + t;
  }
  return null;
}

function below1000(w: string): number | null {
  const i = w.indexOf('hundert');
  if (i >= 0) {
    const head = w.slice(0, i);
    const tail = w.slice(i + 7);
    const h = head === '' ? 1 : UNITS[head];
    if (h === undefined) return null;
    const t = tail === '' ? 0 : below100(tail.replace(/^und/, ''));
    return t === null ? null : h * 100 + t;
  }
  return below100(w);
}

/** Zahlwort -> Zahl (0 bis 9999), sonst null. */
export function parseGermanNumber(word: string): number | null {
  const w = word.toLowerCase().replace(/ß/g, 'ss').replace(/[^a-zäöü]/g, '');
  if (!w) return null;
  const norm = w.replace('dreissig', 'dreissig');
  const i = norm.indexOf('tausend');
  if (i >= 0) {
    const head = norm.slice(0, i);
    const tail = norm.slice(i + 7);
    const th = head === '' ? 1 : below1000(head);
    const rest = tail === '' ? 0 : below1000(tail.replace(/^und/, ''));
    return th === null || rest === null ? null : th * 1000 + rest;
  }
  return below1000(norm);
}

function tokenNumber(tok: string): { num: string; suffix: string } | null {
  const m = /^(\d+)\s*([a-h])?$/i.exec(tok);
  if (m) return { num: m[1], suffix: (m[2] ?? '').toLowerCase() };
  const n = parseGermanNumber(tok);
  if (n !== null) return { num: String(n), suffix: '' };
  // "zwölfa" -> 12a
  const last = tok.slice(-1).toLowerCase();
  if (/[a-h]/.test(last)) {
    const n2 = parseGermanNumber(tok.slice(0, -1));
    if (n2 !== null) return { num: String(n2), suffix: last };
  }
  return null;
}

export interface SpokenAddress {
  street: string;
  number: string | null;
}

/** Zerlegt einen erkannten Satz in Straße und Hausnummer. */
export function parseSpokenAddress(text: string): SpokenAddress {
  let tokens = text
    .replace(/[,.!?;:]/g, ' ')
    // "Elbuferstraße195" -> getrennt
    .replace(/([a-zäöüß])(\d)/gi, '$1 $2')
    .split(/\s+/)
    .filter(Boolean);
  tokens = tokens.filter((t) => !FILLER.has(t.toLowerCase()));

  let suffix = '';
  let end = tokens.length;
  // Buchstabenzusatz am Ende ("zwölf a", "12 b")
  if (end >= 2) {
    const l = LETTERS[tokens[end - 1].toLowerCase()];
    if (l && tokenNumber(tokens[end - 2])) {
      suffix = l;
      end--;
    }
  }
  // Zahl: längste Folge von Zahlwörtern am Ende ("hundert fünfundneunzig")
  for (let start = Math.max(0, end - 3); start < end; start++) {
    const slice = tokens.slice(start, end);
    const joined = slice.join('');
    const tn = /^\d+[a-h]?$/i.test(joined) && slice.length === 1 ? tokenNumber(joined) : slice.every((t) => !/\d/.test(t)) ? tokenNumber(joined) : null;
    if (tn && start > 0) {
      const street = tokens.slice(0, start).join(' ');
      return { street, number: tn.num + (suffix || tn.suffix) };
    }
  }
  return { street: tokens.slice(0, end).join(' ') + (suffix ? ` ${suffix}` : ''), number: null };
}
