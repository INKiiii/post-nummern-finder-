// Datenquelle: amtliche Adressdaten (z. B. Hauskoordinaten der Bundesländer) als CSV.
// Die Spaltenzuordnung, Lizenz und Quellenangabe stehen in einer JSON-Konfiguration,
// siehe scripts/sources.example.json.

import fs from 'node:fs';
import readline from 'node:readline';

/** Zerlegt eine CSV-Zeile (Anführungszeichen werden unterstützt). */
export function splitCsvLine(line, delim) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** UTM (ETRS89, Nordhalbkugel) -> geographische Koordinaten. Genauigkeit < 1 m. */
export function utmToLatLon(easting, northing, zone) {
  const a = 6378137;
  const f = 1 / 298.257222101; // GRS80
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const x = easting - 500000;
  const y = northing;
  const lon0 = ((zone - 1) * 6 - 180 + 3) * (Math.PI / 180);
  const M = y / k0;
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sin1 = Math.sin(phi1);
  const cos1 = Math.cos(phi1);
  const tan1 = Math.tan(phi1);
  const N1 = a / Math.sqrt(1 - e2 * sin1 * sin1);
  const T1 = tan1 * tan1;
  const C1 = ep2 * cos1 * cos1;
  const R1 = (a * (1 - e2)) / (1 - e2 * sin1 * sin1) ** 1.5;
  const D = x / (N1 * k0);
  const lat =
    phi1 -
    ((N1 * tan1) / R1) *
      ((D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon =
    lon0 +
    (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) /
      cos1;
  return [(lat * 180) / Math.PI, (lon * 180) / Math.PI];
}

/**
 * @param {string} file CSV-Datei
 * @param {object} cfg Konfiguration (id, name, license, attribution, url, delimiter, encoding, crs, columns)
 */
export async function loadCsvAddresses(file, cfg) {
  const delim = cfg.delimiter ?? ';';
  const cols = cfg.columns ?? {};
  const crs = cfg.crs ?? 'EPSG:4326';
  const utmZone = { 'EPSG:25832': 32, 'EPSG:25833': 33, 'EPSG:4647': 32 }[crs];
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: cfg.encoding ?? 'utf8' }),
    crlfDelay: Infinity,
  });
  let header = null;
  const idx = {};
  const addresses = [];
  let skipped = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const parts = splitCsvLine(line, delim);
    if (!header) {
      header = parts.map((h) => h.trim().replace(/^\uFEFF/, ''));
      for (const [k, name] of Object.entries(cols)) {
        const i = header.indexOf(name);
        if (i < 0) throw new Error(`Spalte "${name}" (${k}) fehlt in ${file}. Vorhanden: ${header.join(', ')}`);
        idx[k] = i;
      }
      continue;
    }
    const get = (k) => (idx[k] === undefined ? '' : (parts[idx[k]] ?? '').trim());
    const num = (s) => parseFloat(String(s).replace(',', '.'));
    let lat;
    let lon;
    if (idx.lat !== undefined) {
      lat = num(get('lat'));
      lon = num(get('lon'));
    } else if (utmZone) {
      let x = num(get('x'));
      // EPSG:4647 bzw. manche Daten mit Zonen-Präfix im Ostwert (32xxxxxx).
      if (x > 1e7) x -= utmZone * 1e6;
      [lat, lon] = utmToLatLon(x, num(get('y')), utmZone);
    } else throw new Error(`Koordinatensystem ${crs} nicht unterstützt (lat/lon oder EPSG:25832/25833 verwenden)`);
    const street = get('street');
    const hn = get('housenumber') + get('suffix');
    if (!street || !hn || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      skipped++;
      continue;
    }
    addresses.push({
      housenumber: hn,
      street,
      isPlace: false,
      postcode: get('postcode'),
      city: get('city'),
      suburb: get('suburb'),
      lat,
      lon,
      source: cfg.id,
    });
  }
  process.stderr.write(`${cfg.name}: ${addresses.length} Adressen geladen, ${skipped} übersprungen\n`);
  return {
    meta: {
      id: cfg.id,
      name: cfg.name,
      license: cfg.license,
      attribution: cfg.attribution,
      url: cfg.url ?? '',
      date: cfg.date ?? fs.statSync(file).mtime.toISOString(),
    },
    addresses,
    streetSegments: [],
    areas: null,
  };
}
