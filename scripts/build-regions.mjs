#!/usr/bin/env node
// Erzeugt Regionspakete (pro PLZ oder Landkreis) aus einem OSM-Auszug und optional
// amtlichen Adressdaten. Aufruf siehe --help bzw. README.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { loadOsmPbf } from './lib/sources/osm-pbf.mjs';
import { loadCsvAddresses } from './lib/sources/csv-addresses.mjs';
import { mergeAddresses, attachBuildings, attachDriveways, buildStreets, assignRegions, assignStreetIds, makePackage, writePackage } from './lib/regions.mjs';
import { describeStreet, writeReport, loadAllPackages } from './lib/report.mjs';

const HELP = `
Regionspakete bauen

  node scripts/build-regions.mjs --download europe/germany/niedersachsen --state Niedersachsen
  node scripts/build-regions.mjs --input niedersachsen-latest.osm.pbf --only 21395,21436 --details

Optionen:
  --input <datei.osm.pbf>     OSM-Auszug (mehrfach möglich)
  --download <pfad>           Auszug von download.geofabrik.de laden, z. B. europe/germany/niedersachsen
  --cache <ordner>            Ablage für Downloads (Standard: data/osm)
  --official <csv>:<json>     amtliche Adressen (CSV) mit Konfiguration, mehrfach möglich
  --prefer <ids>              Quellen-Reihenfolge für Koordinaten, z. B. "lgln,osm" (Standard: amtlich vor OSM)
  --out <ordner>              Ausgabe (Standard: public/regions)
  --group plz|kreis           Paket pro Postleitzahl (Standard) oder pro Landkreis
  --state <name>              nur Gebiete in diesem Bundesland (OSM-Landesgrenze), z. B. Niedersachsen
  --plz-prefix <liste>        nur PLZ mit diesen Anfängen, z. B. 21,29
  --only <liste>              nur diese Gebiete, z. B. 21395,21436
  --details [liste]           Vollständigkeit pro Straße ausgeben (alle oder nur diese Gebiete)
  --report <datei>            Qualitätsbericht (Standard: report.csv)
`;

// "--details" ohne Wert erlauben (parseArgs verlangt sonst einen Wert)
const argv = process.argv.slice(2).map((a, i, arr) =>
  a === '--details' && (i === arr.length - 1 || arr[i + 1].startsWith('--')) ? '--details=' : a,
);
const { values } = parseArgs({
  args: argv,
  options: {
    input: { type: 'string', multiple: true, default: [] },
    download: { type: 'string', multiple: true, default: [] },
    cache: { type: 'string', default: 'data/osm' },
    official: { type: 'string', multiple: true, default: [] },
    prefer: { type: 'string' },
    out: { type: 'string', default: 'public/regions' },
    group: { type: 'string', default: 'plz' },
    state: { type: 'string' },
    'plz-prefix': { type: 'string' },
    only: { type: 'string' },
    details: { type: 'string' },
    report: { type: 'string', default: 'report.csv' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || (!values.input.length && !values.download.length)) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}
if (!['plz', 'kreis'].includes(values.group)) {
  console.error('--group muss plz oder kreis sein');
  process.exit(1);
}
const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

async function download(geofabrikPath, cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const name = geofabrikPath.split('/').pop() + '-latest.osm.pbf';
  const file = path.join(cacheDir, name);
  const url = `https://download.geofabrik.de/${geofabrikPath}-latest.osm.pbf`;
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 24 * 3600 * 1000) {
    console.error(`Verwende vorhandene Datei ${file}`);
    return file;
  }
  console.error(`Lade ${url} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download fehlgeschlagen: ${res.status} ${url}`);
  const tmp = file + '.part';
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, file);
  console.error(`Gespeichert: ${file} (${(fs.statSync(file).size / 1e6).toFixed(0)} MB)`);
  return file;
}

const fmt = (n) => n.toLocaleString('de-DE');
const kb = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);

async function main() {
  const t0 = Date.now();
  const inputs = [...values.input];
  for (const d of values.download) inputs.push(await download(d, values.cache));

  // ---- Quellen laden ----
  const sources = [];
  for (const f of inputs) sources.push(loadOsmPbf(f));
  for (const spec of values.official) {
    const i = spec.lastIndexOf(':');
    if (i < 0) throw new Error('--official erwartet <csv>:<config.json>');
    const cfg = JSON.parse(fs.readFileSync(spec.slice(i + 1), 'utf8'));
    sources.push(await loadCsvAddresses(spec.slice(0, i), cfg));
  }

  // Quellen-Metadaten (gleiche ID nur einmal, z. B. mehrere OSM-Auszüge)
  const metas = [];
  for (const s of sources)
    for (const m of [s.meta, ...(s.extraSources ?? [])]) if (!metas.some((x) => x.id === m.id)) metas.push(m);
  const official = metas.filter((m) => !m.id.startsWith('osm')).map((m) => m.id);
  // Lage: amtlich vor OSM vor OSM-Interpolationslinie
  const prefer = values.prefer ? list(values.prefer) : [...official, 'osm', 'osm-interp'];

  const { addresses, merged } = mergeAddresses(sources, prefer);
  console.error(`Adressen gesamt: ${fmt(addresses.length)} (${fmt(merged)} Dubletten zusammengeführt)`);
  const segments = sources.flatMap((s) => s.streetSegments);
  const areas = { postal: [], admin: {} };
  for (const s of sources) {
    if (!s.areas) continue;
    areas.postal.push(...s.areas.postal);
    for (const [lvl, a] of Object.entries(s.areas.admin)) (areas.admin[lvl] ??= []).push(...a);
  }

  const streets = buildStreets(segments, addresses);
  const driveways = attachDriveways(streets, sources.flatMap((s) => s.drivewaySegments ?? []));
  console.error(`Zufahrtswege Häusern zugeordnet: ${fmt(driveways)}`);
  const blds = attachBuildings(streets, sources.flatMap((s) => s.buildings ?? []));
  console.error(`Wohngebäude ohne Hausnummer Straßen zugeordnet: ${fmt(blds)}`);
  assignStreetIds(streets);
  const { regions, unassigned } = assignRegions(streets, areas, {
    group: values.group,
    state: values.state,
    only: list(values.only),
    plzPrefix: list(values['plz-prefix']),
  });
  if (unassigned) console.error(`Hinweis: ${unassigned} Straßen konnten keinem Gebiet zugeordnet werden.`);
  if (!regions.length) {
    console.error('Keine Gebiete gefunden – Filter prüfen.');
    process.exit(2);
  }

  // ---- Pakete schreiben ----
  fs.mkdirSync(values.out, { recursive: true });
  const indexFile = path.join(values.out, 'regions.json');
  const oldIndex = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : { regions: [] };
  const entries = new Map(oldIndex.regions.map((r) => [r.id, r]));
  const built = new Date().toISOString();
  const detailIds = values.details === undefined ? null : list(values.details);

  console.log(`\n${'Gebiet'.padEnd(34)} ${'Straßen'.padStart(8)} ${'Nummern'.padStart(9)} ${'ohne Nr.'.padStart(9)}  Größe`);
  let totStreets = 0;
  let totNumbers = 0;
  for (const r of regions) {
    const pkg = makePackage(r, metas, built);
    const w = writePackage(pkg, values.out);
    const numbers = pkg.streets.reduce((n, s) => n + s.h.length, 0);
    // Echte Lücken: Straßen mit Häusern, aber ohne Nummern (Feldwege ohne Häuser zählen nicht)
    const gaps = pkg.streets.filter((s) => s.q.gap && s.q.bu > 0).length;
    totStreets += pkg.streets.length;
    totNumbers += numbers;
    const old = entries.get(pkg.id);
    entries.set(pkg.id, {
      id: pkg.id,
      name: pkg.name,
      plz: pkg.plzList,
      places: pkg.places.slice(0, 30),
      file: w.file,
      size: w.size,
      streets: pkg.streets.length,
      numbers,
      gaps,
      bbox: pkg.bbox,
      hash: w.hash,
      updated: old && old.hash === w.hash ? old.updated : built,
      sources: pkg.sources.map((s) => s.id),
    });
    console.log(`${pkg.name.slice(0, 34).padEnd(34)} ${fmt(pkg.streets.length).padStart(8)} ${fmt(numbers).padStart(9)} ${fmt(gaps).padStart(9)}  ${kb(w.size)}${w.size > 5e6 ? '  (groß!)' : ''}`);
    if (detailIds && (detailIds.length === 0 || detailIds.includes(pkg.id))) {
      for (const s of pkg.streets) console.log(`    ${s.n}${s.p ? ` (${s.p})` : ''}: ${describeStreet(s.q)}`);
    }
  }
  const index = {
    format: 'hnf-regions',
    version: 1,
    generated: built,
    group: values.group,
    sources: metas,
    regions: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 1));
  console.log(`\n${regions.length} Gebiete, ${fmt(totStreets)} Straßen, ${fmt(totNumbers)} Hausnummern → ${values.out}`);

  // ---- Qualitätsbericht über alle gebauten Gebiete ----
  const rep = writeReport(loadAllPackages(values.out), values.report);
  console.log(`Qualitätsbericht: ${values.report} (${fmt(rep.streets)} Straßen, davon ${fmt(rep.gaps)} mit Häusern ohne Hausnummern, ${fmt(rep.paths)} Wege ohne Häuser)`);
  console.log(`Fertig in ${((Date.now() - t0) / 1000).toFixed(0)} s.`);
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
