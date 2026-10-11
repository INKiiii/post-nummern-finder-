#!/usr/bin/env node
// Stichprobentest: zufällige Adressen aus jedem Gebiet über dieselbe Logik wie die App
// abfragen (Straßensuche + Hausnummer) und prüfen, ob eine Position geliefert wird.
//   node scripts/sample-test.mjs [--dir public/regions] [--per-region 20] [--seed 1]

import { parseArgs } from 'node:util';
import { loadAllPackages } from './lib/report.mjs';
import { buildIndex, searchStreets, findHouse } from '../src/shared/lookup.js';
import { distanceM } from '../src/shared/geo.js';

const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: 'public/regions' },
    'per-region': { type: 'string', default: '20' },
    seed: { type: 'string', default: '1' },
  },
});
const per = Number(values['per-region']);
let seed = Number(values.seed) || 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const packages = loadAllPackages(values.dir);
let total = 0;
let ok = 0;
let estimatedOk = 0;
let estimatedTotal = 0;
const failures = [];
for (const { pkg } of packages) {
  // Wie in der App: nur das geladene Gebiet ist durchsuchbar.
  const index = buildIndex([pkg]);
  const withNumbers = pkg.streets.filter((s) => s.h.length);
  for (let i = 0; i < per && withNumbers.length; i++) {
    const s = withNumbers[Math.floor(rand() * withNumbers.length)];
    const [label, lat, lon] = s.h[Math.floor(rand() * s.h.length)];
    total++;
    // Suche über den Namen, wie ein Nutzer ihn eintippt
    const hits = searchStreets(index, s.n, 10);
    const street = hits.find((x) => x.id === s.id);
    if (!street) {
      failures.push(`[${pkg.id}] ${s.n} ${label}: Straße nicht über Suche gefunden`);
      continue;
    }
    const r = findHouse(street, label);
    const d = distanceM(r.lat, r.lon, lat / 1e6, lon / 1e6);
    if (r.status === 'exact' && d < 1) ok++;
    else failures.push(`[${pkg.id}] ${s.n} ${label}: Status ${r.status}, Abweichung ${d.toFixed(1)} m`);

    // Zusätzlich: eine nicht vorhandene Nummer muss eine geschätzte Position liefern
    const max = s.q?.max ?? 1;
    const fake = String(max + 1 + Math.floor(rand() * 3));
    const e = findHouse(street, fake);
    estimatedTotal++;
    if (Number.isFinite(e.lat) && Number.isFinite(e.lon) && e.estimated) estimatedOk++;
    else failures.push(`[${pkg.id}] ${s.n} ${fake} (fehlt): keine geschätzte Position`);
  }
}
console.log(`Gebiete: ${packages.length}`);
console.log(`Vorhandene Adressen: ${ok}/${total} mit exakter Position`);
console.log(`Fehlende Nummern:    ${estimatedOk}/${estimatedTotal} mit geschätzter Position`);
if (failures.length) {
  console.log(`\nAuffällig (${failures.length}):`);
  for (const f of failures.slice(0, 50)) console.log('  ' + f);
}
const rate = total ? ok / total : 0;
process.exit(rate >= 0.98 && estimatedOk === estimatedTotal ? 0 : 1);
