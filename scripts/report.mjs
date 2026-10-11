#!/usr/bin/env node
// Qualitätsbericht für alle gebauten Gebiete -> report.csv (schlechteste Straßen zuerst).
//   node scripts/report.mjs [--dir public/regions] [--out report.csv] [--top 20]

import { parseArgs } from 'node:util';
import { loadAllPackages, writeReport, describeStreet, streetScore } from './lib/report.mjs';

const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: 'public/regions' },
    out: { type: 'string', default: 'report.csv' },
    top: { type: 'string', default: '20' },
  },
});
const packages = loadAllPackages(values.dir);
const r = writeReport(packages, values.out);
console.log(`${values.out}: ${r.streets} Straßen, davon ${r.gaps} mit Häusern ohne Hausnummern, ${r.paths} Wege ohne Häuser.`);

const all = [];
const seen = new Set();
for (const { pkg } of packages)
  for (const s of pkg.streets) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    all.push({ region: pkg.id, s });
  }
all.sort((a, b) => streetScore(a.s.q) - streetScore(b.s.q) || (b.s.q?.missing?.length ?? 0) - (a.s.q?.missing?.length ?? 0));
const top = Number(values.top);
if (top > 0) {
  console.log(`\nSchlechteste ${Math.min(top, all.length)} Straßen:`);
  for (const { region, s } of all.slice(0, top)) console.log(`  [${region}] ${s.n}${s.p ? ` (${s.p})` : ''}: ${describeStreet(s.q)}`);
}
