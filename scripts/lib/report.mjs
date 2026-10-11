// Qualitätsbericht: Vollständigkeit der Nummernfolge pro Straße, schlechteste zuerst.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { formatRanges } from '../../src/shared/housenumber.js';

export function readPackage(file) {
  let buf = fs.readFileSync(file);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return JSON.parse(buf.toString('utf8'));
}

export function loadAllPackages(dir) {
  const indexFile = path.join(dir, 'regions.json');
  if (!fs.existsSync(indexFile)) throw new Error(`${indexFile} fehlt – zuerst build-regions ausführen.`);
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  return index.regions.map((r) => ({ meta: r, pkg: readPackage(path.join(dir, r.file)) }));
}

/** Weg ohne Häuser: keine Nummern und auch keine Wohngebäude an der Straße. */
export function noHouses(q) {
  return !!q && q.gap && q.bu === 0;
}

/**
 * Bewertet eine Straße: 0 = Häuser ohne Nummern (echte Lücke), 1 = lückenlos.
 * Wege ohne Häuser sind kein Fehler und landen am Ende (2).
 */
export function streetScore(q) {
  if (!q) return 0;
  if (noHouses(q)) return 2;
  if (q.gap) return 0;
  return q.ratio;
}

export function statusText(q) {
  if (!q) return 'keine Hausnummern';
  if (noHouses(q)) return 'Weg ohne Häuser';
  if (q.gap) return q.bu ? `keine Hausnummern, ${q.bu} Gebäude` : 'keine Hausnummern';
  if (q.missing.length === 0) return 'vollständig';
  if (q.ratio < 0.5) return 'große Lücken';
  return 'Lücken';
}

/** Beschreibung wie "Nummern 1 bis 40 vorhanden (35), es fehlen 17, 23 und 24". */
export function describeStreet(q) {
  if (noHouses(q)) return 'Weg ohne Häuser (keine Wohngebäude an der Straße)';
  if (!q || q.gap) return `LÜCKE: keine Hausnummern in den Daten${q?.bu ? `, aber ${q.bu} Gebäude ohne Nummer` : ''}`;
  const base = `Nummern ${q.min} bis ${q.max} vorhanden (${q.count})`;
  const bld = q.bu ? ` · ${q.bu} Gebäude ohne Nummer` : '';
  if (!q.missing.length) return base + ', lückenlos' + bld;
  return `${base}, es fehlen ${formatRanges(q.missing, 15)}${bld}`;
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Schreibt report.csv (Semikolon, UTF-8 mit BOM für Excel). */
export function writeReport(packages, file) {
  const rows = [];
  const seen = new Map();
  for (const { pkg } of packages) {
    for (const s of pkg.streets) {
      const q = s.q;
      // Straßen über mehrere Gebiete nur einmal aufführen, Gebiete zusammenfassen.
      const prev = seen.get(s.id);
      if (prev) {
        prev.cols[0] += ',' + pkg.id;
        continue;
      }
      const row = {
        score: streetScore(q),
        cols: [
          pkg.id,
          pkg.name,
          s.n,
          s.p ?? '',
          q?.count ?? 0,
          q?.min ?? '',
          q?.max ?? '',
          q?.missing?.length ?? 0,
          formatRanges(q?.missing ?? [], 60),
          q && !q.gap ? Math.round(q.ratio * 100) : 0,
          statusText(q),
          s.l?.length ? 'ja' : 'nein',
          q?.bu ?? 0,
        ],
      };
      seen.set(s.id, row);
      rows.push(row);
    }
  }
  // Schlechteste zuerst; bei gleicher Quote die mit mehr fehlenden Nummern.
  rows.sort((a, b) => a.score - b.score || b.cols[7] - a.cols[7] || String(a.cols[2]).localeCompare(String(b.cols[2]), 'de'));
  const header = ['gebiet', 'gebietsname', 'strasse', 'ort', 'anzahl_nummern', 'min', 'max', 'anzahl_fehlend', 'fehlende_nummern', 'vollstaendigkeit_prozent', 'status', 'geometrie', 'gebaeude_ohne_nummer'];
  const lines = [header.join(';'), ...rows.map((r) => r.cols.map(csvCell).join(';'))];
  fs.writeFileSync(file, '\uFEFF' + lines.join('\n') + '\n');
  const gaps = rows.filter((r) => r.score === 0).length;
  const paths = rows.filter((r) => r.score === 2).length;
  return { streets: rows.length, gaps, paths };
}
