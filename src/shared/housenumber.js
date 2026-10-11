// Hausnummern parsen, vergleichen und Vollständigkeit berechnen.

/**
 * Zerlegt eine Hausnummer: "12a" -> {num:12, suffix:'a'}, "12-14" -> {num:12, to:14},
 * "7/1" -> {num:7, suffix:'/1'}. Nicht-numerische Angaben liefern num=null.
 */
export function parseHouseNumber(raw) {
  const label = String(raw ?? '').trim();
  const norm = normHouseNumber(label);
  const m = /^(\d+)(?:\s*[-–]\s*(\d+))?\s*([a-z]{1,2}|\/\s*\d+|\s+[a-z])?/i.exec(label);
  if (!m) return { label, norm, num: null, suffix: '', to: null };
  const num = parseInt(m[1], 10);
  const to = m[2] ? parseInt(m[2], 10) : null;
  const suffix = (m[3] ?? '').replace(/\s+/g, '').toLowerCase();
  return { label, norm, num, suffix, to: to !== null && to > num && to - num < 50 ? to : null };
}

/** Vergleichsschlüssel: Kleinbuchstaben, keine Leerzeichen. "12 A" -> "12a" */
export function normHouseNumber(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/–/g, '-');
}

/** Teilt Mehrfachangaben "12;14" bzw. "12, 14" auf. */
export function splitHouseNumbers(raw) {
  return String(raw ?? '')
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function compareHouseNumbers(a, b) {
  const pa = typeof a === 'string' ? parseHouseNumber(a) : a;
  const pb = typeof b === 'string' ? parseHouseNumber(b) : b;
  if (pa.num === null && pb.num === null) return pa.norm.localeCompare(pb.norm);
  if (pa.num === null) return 1;
  if (pb.num === null) return -1;
  if (pa.num !== pb.num) return pa.num - pb.num;
  return pa.suffix.localeCompare(pb.suffix, 'de', { numeric: true });
}

/**
 * Vollständigkeit der Nummernfolge einer Straße.
 * @param {string[]} labels
 * @returns {{count:number, min:number|null, max:number|null, missing:number[], ratio:number, gap:boolean}}
 */
export function completeness(labels) {
  const present = new Set();
  for (const l of labels) {
    const p = parseHouseNumber(l);
    if (p.num === null) continue;
    present.add(p.num);
    if (p.to !== null) for (let n = p.num; n <= p.to; n++) present.add(n);
  }
  if (present.size === 0) {
    return { count: labels.length, min: null, max: null, missing: [], ratio: 0, gap: true };
  }
  const nums = [...present].sort((a, b) => a - b);
  const min = nums[0];
  const max = nums[nums.length - 1];
  const missing = [];
  for (let n = min; n <= max; n++) if (!present.has(n)) missing.push(n);
  return {
    count: labels.length,
    min,
    max,
    missing,
    ratio: present.size / (max - min + 1),
    gap: false,
  };
}

/** Fasst fehlende Nummern lesbar zusammen: [17,23,24,25] -> "17, 23–25" */
export function formatRanges(nums, limit = 30) {
  const parts = [];
  let i = 0;
  while (i < nums.length && parts.length < limit) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(i === j ? String(nums[i]) : `${nums[i]}–${nums[j]}`);
    i = j + 1;
  }
  if (i < nums.length) parts.push('…');
  return parts.join(', ');
}
