// Zuletzt genutzte Straßen und Adressen (lokal).

import { kvGet, kvSet } from './db';
import type { RecentAddress } from './types';

let addresses: RecentAddress[] = [];
let streets: { id: string; name: string; place: string }[] = [];

export async function loadRecents() {
  addresses = await kvGet<RecentAddress[]>('recentAddresses', []);
  streets = await kvGet<{ id: string; name: string; place: string }[]>('recentStreets', []);
}

export function recentAddresses(n = 5) {
  return addresses.slice(0, n);
}
export function recentStreets(n = 8) {
  return streets.slice(0, n);
}

export async function remember(a: Omit<RecentAddress, 'at'>) {
  addresses = [{ ...a, at: Date.now() }, ...addresses.filter((x) => !(x.streetId === a.streetId && x.number === a.number))].slice(0, 20);
  streets = [{ id: a.streetId, name: a.streetName, place: a.place }, ...streets.filter((s) => s.id !== a.streetId)].slice(0, 20);
  await kvSet('recentAddresses', addresses);
  await kvSet('recentStreets', streets);
}
