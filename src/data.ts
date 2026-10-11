// Zentraler Datenstand: geladene Gebiete, eigene Punkte/Straßen, Suchindex.

import * as db from './db';
import { buildIndex, PACKAGE_FORMAT } from './core';
import type { Index, RegionEntry, RegionPackage, StoredPackage, UserPoint, UserStreet } from './types';

export const state = {
  packages: [] as StoredPackage[],
  points: [] as UserPoint[],
  ustreets: [] as UserStreet[],
  index: { streets: new Map(), byNorm: new Map() } as Index,
};

export async function loadAll(): Promise<void> {
  state.packages = await db.getAll<StoredPackage>('packages');
  state.points = await db.getAll<UserPoint>('points');
  state.ustreets = await db.getAll<UserStreet>('ustreets');
  rebuildIndex();
}

export function rebuildIndex(): void {
  state.index = buildIndex(
    state.packages.map((p) => p.pkg),
    { points: state.points, streets: state.ustreets },
  );
}

export function regionsUrl(file = 'regions.json'): string {
  return new URL(`regions/${file}`, document.baseURI).toString();
}

export async function fetchRegionIndex(): Promise<{ regions: RegionEntry[]; generated: string }> {
  const res = await fetch(regionsUrl(), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Gebietsliste nicht erreichbar (${res.status})`);
  return res.json();
}

/** Entpackt gzip, falls nötig (manche Server entpacken bereits selbst). */
export async function decodePackageBytes(buf: ArrayBuffer): Promise<RegionPackage> {
  const bytes = new Uint8Array(buf);
  let text: string;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    text = await new Response(stream).text();
  } else text = new TextDecoder().decode(bytes);
  const pkg = JSON.parse(text) as RegionPackage;
  if (pkg.format !== PACKAGE_FORMAT) throw new Error('Unbekanntes Paketformat');
  return pkg;
}

export async function downloadRegion(entry: RegionEntry, onProgress?: (done: number, total: number) => void): Promise<void> {
  const res = await fetch(regionsUrl(entry.file), { cache: 'no-cache' });
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (${res.status})`);
  const total = Number(res.headers.get('content-length')) || entry.size;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let done = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    chunks.push(value);
    done += value.length;
    onProgress?.(done, total);
  }
  const buf = new Uint8Array(done);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.length;
  }
  const pkg = await decodePackageBytes(buf.buffer);
  const stored: StoredPackage = { id: entry.id, entry, pkg, size: entry.size, downloadedAt: Date.now() };
  await db.put('packages', stored);
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* optional */
  }
  state.packages = state.packages.filter((p) => p.id !== entry.id).concat(stored);
  rebuildIndex();
}

export async function deleteRegion(id: string): Promise<void> {
  await db.del('packages', id);
  state.packages = state.packages.filter((p) => p.id !== id);
  rebuildIndex();
}

export async function savePoint(p: UserPoint): Promise<void> {
  await db.put('points', p);
  state.points = state.points.filter((x) => x.id !== p.id).concat(p);
  rebuildIndex();
}

export async function deletePoint(id: string): Promise<void> {
  await db.del('points', id);
  state.points = state.points.filter((x) => x.id !== id);
  rebuildIndex();
}

export async function saveUserStreet(s: UserStreet): Promise<void> {
  await db.put('ustreets', s);
  state.ustreets = state.ustreets.filter((x) => x.id !== s.id).concat(s);
  rebuildIndex();
}

export async function deleteUserStreet(id: string): Promise<void> {
  await db.del('ustreets', id);
  state.ustreets = state.ustreets.filter((x) => x.id !== id);
  rebuildIndex();
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
