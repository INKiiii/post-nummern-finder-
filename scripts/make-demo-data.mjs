#!/usr/bin/env node
// Erzeugt ein erfundenes Demo-Gebiet ("Musterdorf", PLZ 00001/00002) zum Ausprobieren der App
// ohne echten OSM-Auszug. Mit --at <lat,lon> lässt es sich an den eigenen Standort legen,
// um GPS, Entfernung und Straßenseite im Auto zu testen.
//
//   node scripts/make-demo-data.mjs [--at 53.39,10.42] [--out public/regions]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { makeSyntheticTown, SYNTH_ORIGIN } from './lib/synthetic.mjs';
import { writePbf } from './lib/pbf-writer.mjs';

const { values } = parseArgs({ options: { at: { type: 'string' }, out: { type: 'string', default: 'public/regions' } } });
const origin = values.at ? values.at.split(',').map(Number) : SYNTH_ORIGIN;
if (origin.length !== 2 || origin.some((v) => !Number.isFinite(v))) {
  console.error('--at erwartet "lat,lon", z. B. 53.39,10.42');
  process.exit(1);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hnf-demo-'));
const pbf = path.join(tmp, 'demo.osm.pbf');
fs.writeFileSync(pbf, writePbf(makeSyntheticTown(origin)));
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build-regions.mjs');
execFileSync(process.execPath, [script, '--input', pbf, '--out', values.out, '--plz-prefix', '0000', '--state', 'Niedersachsen', '--report', path.join(tmp, 'report.csv')], {
  stdio: 'inherit',
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Demo-Gebiet (erfunden) bei ${origin.join(', ')} geschrieben.`);
