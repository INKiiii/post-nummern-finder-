// Export/Import eigener Daten (Haus-Infos, eigene Punkte, eigene Straßen) als JSON-Datei,
// damit Kollegen im selben Gebiet ihre Infos teilen können.

import * as db from './db';
import { loadHouseInfos } from './houseinfo';
import { state, rebuildIndex } from './data';
import { nameWarning } from './namecheck';
import type { HouseInfo, UserPoint, UserStreet } from './types';

export const USERDATA_FORMAT = 'hnf-userdata';

export interface UserDataFile {
  format: string;
  version: number;
  exported: string;
  houseinfo: HouseInfo[];
  points: UserPoint[];
  streets: UserStreet[];
}

export async function exportUserData(): Promise<UserDataFile> {
  const infos = [...(await loadHouseInfos()).values()];
  return {
    format: USERDATA_FORMAT,
    version: 1,
    exported: new Date().toISOString(),
    houseinfo: infos,
    points: state.points,
    streets: state.ustreets,
  };
}

/** Führt importierte Daten zusammen: bei gleichem Schlüssel gewinnt der neuere Stand. */
export function mergeRecords<T extends { updated: number }>(mine: T[], theirs: T[], key: (t: T) => string) {
  const map = new Map(mine.map((m) => [key(m), m]));
  let added = 0;
  let updated = 0;
  for (const t of theirs) {
    const k = key(t);
    const m = map.get(k);
    if (!m) {
      map.set(k, t);
      added++;
    } else if ((t.updated ?? 0) > (m.updated ?? 0)) {
      map.set(k, t);
      updated++;
    }
  }
  return { result: [...map.values()], added, updated };
}

function validate(data: any): UserDataFile & { namesRemoved: number } {
  if (!data || data.format !== USERDATA_FORMAT) throw new Error('Keine Hausnummern-Finder-Datei.');
  const arr = (x: unknown) => (Array.isArray(x) ? x : []);
  const houseinfo = arr(data.houseinfo).filter(
    (h: any) => typeof h?.key === 'string' && Array.isArray(h.entrances) && typeof h.number === 'string',
  ) as HouseInfo[];
  const points = arr(data.points).filter(
    (p: any) => typeof p?.id === 'string' && Number.isFinite(p.lat) && Number.isFinite(p.lon) && typeof p.number === 'string',
  ) as UserPoint[];
  const streets = arr(data.streets).filter((s: any) => typeof s?.id === 'string' && typeof s.name === 'string') as UserStreet[];
  // Nur bekannte Felder übernehmen
  let namesRemoved = 0;
  for (const h of houseinfo) {
    h.entrances = h.entrances
      .filter((e: any) => typeof e?.pos === 'string')
      .map((e: any) => ({ pos: String(e.pos).slice(0, 40), boxes: Math.max(0, Math.min(99, Number(e.boxes) || 0)) }));
    h.note = String(h.note ?? '').slice(0, 80);
    // Hinweise mit erkanntem Namen werden nicht übernommen
    if (nameWarning(h.note)) {
      h.note = '';
      namesRemoved++;
    }
    h.updated = Number(h.updated) || 0;
  }
  for (const p of points) if (p.kind !== 'driveway') p.kind = 'number';
  // Fotos (ältere Sicherungen) werden bewusst nicht übernommen
  const { photos: _ignored, ...rest } = data;
  void _ignored;
  return { ...rest, houseinfo, points, streets, namesRemoved };
}

export async function importUserData(json: string) {
  const data = validate(JSON.parse(json));
  const infos = await loadHouseInfos();
  const hi = mergeRecords([...infos.values()], data.houseinfo, (x) => x.key);
  const pts = mergeRecords(state.points, data.points, (x) => x.id);
  const sts = mergeRecords(state.ustreets, data.streets, (x) => x.id);
  for (const h of hi.result) {
    infos.set(h.key, h);
    await db.put('houseinfo', h);
  }
  for (const p of pts.result) await db.put('points', p);
  for (const s of sts.result) await db.put('ustreets', s);
  state.points = pts.result;
  state.ustreets = sts.result;
  rebuildIndex();
  return { houseinfo: hi, points: pts, streets: sts, namesRemoved: data.namesRemoved };
}

const BACKUP_KEY = 'lastBackup';
export const BACKUP_DAYS = 14;

/**
 * "Haus-Infos sichern": eigene Daten als JSON-Datei teilen (Teilen-Menü, z. B. an sich selbst
 * schicken oder in Dateien speichern) oder herunterladen. Merkt sich das Datum.
 * @returns true, wenn gesichert (nicht bei Abbruch im Teilen-Menü)
 */
export async function backupUserData(): Promise<boolean> {
  const data = await exportUserData();
  const json = JSON.stringify(data, null, 1);
  const name = `haus-infos-sicherung-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([json], name, { type: 'application/json' });
  let done = false;
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Haus-Infos sichern' });
      done = true;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false;
    }
  }
  if (!done) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
  }
  await db.kvSet(BACKUP_KEY, Date.now());
  return true;
}

/** Stand der Sicherung: wann zuletzt, ob fällig (älter als 14 Tage oder nie) und ob es Daten gibt. */
export async function backupState(now = Date.now()) {
  const last = await db.kvGet<number | null>(BACKUP_KEY, null);
  const infos = await loadHouseInfos();
  const count = infos.size + state.points.length + state.ustreets.length;
  return { last, count, due: backupDue(last, now) };
}

export function backupDue(last: number | null, now = Date.now()): boolean {
  return last === null || now - last > BACKUP_DAYS * 24 * 3600 * 1000;
}
