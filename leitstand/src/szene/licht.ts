/**
 * Licht passend zur Simulationsuhr: Sonnenstand, Farben, Himmel.
 * Reine Funktion, damit sie testbar ist.
 */

export interface Licht {
  /** Einheitsvektor zur Sonne in Szene-Koordinaten (x Ost, y oben, −z Nord) */
  sonne: [number, number, number];
  hoeheGrad: number;
  sonnenFarbe: string;
  sonnenStaerke: number;
  himmel: string;
  boden: string;
  umgebungStaerke: number;
  /** 0 = Tag, 1 = Nacht (für Straßenlaternen o. Ä.) */
  nacht: number;
}

const AUFGANG = 5 * 60 + 30;
const UNTERGANG = 20 * 60 + 30;
const MAX_HOEHE = 55;

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mische(a: string, b: string, t: number): string {
  const x = hex(a);
  const y = hex(b);
  const k = Math.max(0, Math.min(1, t));
  const r = x.map((v, i) => Math.round(v + (y[i] - v) * k));
  return '#' + r.map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function lichtZurZeit(minuten: number): Licht {
  const tag = (minuten - AUFGANG) / (UNTERGANG - AUFGANG);
  const hoeheGrad = Math.sin(Math.PI * tag) * MAX_HOEHE;
  // Azimut: Osten bei Aufgang, Süden mittags, Westen bei Untergang
  const azimut = ((90 + 180 * Math.max(-0.2, Math.min(1.2, tag))) * Math.PI) / 180;
  const h = (Math.max(hoeheGrad, 4) * Math.PI) / 180;
  const sonne: [number, number, number] = [Math.sin(azimut) * Math.cos(h), Math.sin(h), -Math.cos(azimut) * Math.cos(h)];

  const tagAnteil = Math.max(0, Math.min(1, (hoeheGrad + 4) / 26)); // 0 nachts … 1 ab ~22°
  const daemmerung = Math.max(0, 1 - Math.abs(hoeheGrad - 4) / 12) * (hoeheGrad > -6 ? 1 : 0);
  let himmel = mische('#1d2636', '#cfe3f2', tagAnteil);
  himmel = mische(himmel, '#f1c8a4', daemmerung * 0.55);
  return {
    sonne,
    hoeheGrad,
    sonnenFarbe: mische('#ffad66', '#fff4e6', Math.min(1, Math.max(0, hoeheGrad / 25))),
    sonnenStaerke: 0.35 + 2.65 * tagAnteil,
    himmel,
    boden: mische('#3a4436', '#b9c79e', tagAnteil),
    umgebungStaerke: 1.5 + 1.0 * tagAnteil,
    nacht: 1 - tagAnteil,
  };
}
