/** Zahlen, Zeiten und Beträge im deutschen Format */

const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const euroGanz = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

export function fmtEuro(v: number, ganz = false): string {
  return (ganz ? euroGanz : euro).format(nullFrei(v, ganz ? 0 : 2));
}

export function fmtZahl(v: number, nachkomma = 0): string {
  return nullFrei(v, nachkomma).toLocaleString('de-DE', { minimumFractionDigits: nachkomma, maximumFractionDigits: nachkomma });
}

export function fmtKm(v: number, nachkomma = 1): string {
  return `${fmtZahl(v, nachkomma)} km`;
}

/** 437 → „7 h 17 Min“, 45 → „45 Min“ */
export function fmtDauer(min: number): string {
  const m = Math.round(Math.abs(min));
  const vz = min < 0 && m > 0 ? '−' : '';
  if (m < 60) return `${vz}${m} Min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${vz}${h} h` : `${vz}${h} h ${r} Min`;
}

/** Minuten ab 0:00 → „13:10“ */
export function fmtUhr(min: number): string {
  const m = Math.round(min);
  const h = Math.floor(m / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Vorzeichen immer sichtbar: +1,2 km / −3 Min / ±0 */
export function mitVorzeichen(text: string, v: number): string {
  if (Math.abs(v) < 1e-9) return `±${text.replace(/^[−-]/, '')}`;
  return v > 0 ? `+${text}` : `−${text.replace(/^[−-]/, '')}`;
}

export function fmtDeltaKm(v: number): string {
  return mitVorzeichen(fmtKm(Math.abs(v)), runden(v, 1));
}

export function fmtDeltaMin(v: number): string {
  return mitVorzeichen(fmtDauer(Math.abs(v)), Math.round(v));
}

export function fmtDeltaEuro(v: number, ganz = false): string {
  return mitVorzeichen(fmtEuro(Math.abs(v), ganz), runden(v, ganz ? 0 : 2));
}

function runden(v: number, stellen: number): number {
  const f = 10 ** stellen;
  return Math.round(v * f) / f;
}

/** −0 und Rundungsreste vermeiden */
function nullFrei(v: number, stellen: number): number {
  const r = runden(v, stellen);
  return r === 0 ? 0 : r;
}
