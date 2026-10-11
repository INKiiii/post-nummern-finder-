// Testhilfe: synthetisches Testgebiet "Musterdorf" als Regionspakete und Suchindex.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePbf } from '../scripts/lib/pbf-writer.mjs';
import { makeSyntheticTown } from '../scripts/lib/synthetic.mjs';
import { loadOsmPbf } from '../scripts/lib/sources/osm-pbf.mjs';
import { mergeAddresses, attachBuildings, attachOutlines, attachDriveways, buildStreets, assignRegions, assignStreetIds, makePackage } from '../scripts/lib/regions.mjs';

let cache = null;

/** @returns {{pkgs: object[], town: ReturnType<typeof makeSyntheticTown>}} */
export function townPackages() {
  if (cache) return cache;
  const origErr = process.stderr.write;
  process.stderr.write = () => true;
  try {
    const town = makeSyntheticTown();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hnf-town-'));
    const file = path.join(dir, 'town.osm.pbf');
    fs.writeFileSync(file, writePbf(town, { blockSize: 50 }));
    const src = loadOsmPbf(file);
    const { addresses } = mergeAddresses([src], ['osm', 'osm-interp']);
    const streets = buildStreets(src.streetSegments, addresses);
    attachDriveways(streets, src.drivewaySegments);
    attachBuildings(streets, src.buildings);
    attachOutlines(streets, src.outlines);
    assignStreetIds(streets);
    const { regions } = assignRegions(streets, src.areas, { group: 'plz', state: 'Niedersachsen' });
    const pkgs = regions.map((r) => makePackage(r, [src.meta, ...src.extraSources], 'test'));
    cache = { pkgs: JSON.parse(JSON.stringify(pkgs)), town };
    return cache;
  } finally {
    process.stderr.write = origErr;
  }
}
