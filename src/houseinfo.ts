// Haus-Infos: Zufahrt, Eingänge (Lage + Briefkästen) und kurzer Hinweis pro Hausnummer.

import * as db from './db';
import { normHouseNumber, normStreet } from './core';
import type { HouseInfo, Street } from './types';

export const ACCESS_OPTIONS = [
  'direkt an der Straße',
  'Einfahrt links',
  'Einfahrt rechts',
  '2. Einfahrt links',
  '2. Einfahrt rechts',
  'lange Auffahrt',
  'Haus liegt hinten',
  'über den Hof',
  'Zugang von hinten',
];

export const ENTRANCE_POSITIONS = [
  'vorne',
  'rechts',
  'links',
  'hinten',
  'rechts hinten',
  'links hinten',
  'über Durchgang',
  'Hof',
  'Nebengebäude',
  'oben (Treppe)',
];

export const NOTE_SNIPPETS = ['Briefkasten am Tor', 'Hund', 'Auffahrt rein', 'Paketkasten', 'Briefschlitz in Tür', 'Tor geschlossen'];

export function houseKey(street: Pick<Street, 'name' | 'plz'>, number: string): string {
  return `${street.plz ?? ''}|${normStreet(street.name)}|${normHouseNumber(number)}`;
}

const cache = new Map<string, HouseInfo>();
let loaded = false;

export async function loadHouseInfos(): Promise<Map<string, HouseInfo>> {
  if (!loaded) {
    for (const h of await db.getAll<HouseInfo>('houseinfo')) cache.set(h.key, h);
    loaded = true;
  }
  return cache;
}

export function getHouseInfo(key: string): HouseInfo | undefined {
  return cache.get(key);
}

export async function saveHouseInfo(info: HouseInfo): Promise<void> {
  info.updated = Date.now();
  cache.set(info.key, info);
  await db.put('houseinfo', info);
}

export async function deleteHouseInfo(key: string): Promise<void> {
  cache.delete(key);
  await db.del('houseinfo', key);
}

export function emptyHouseInfo(street: Street, number: string): HouseInfo {
  return {
    key: houseKey(street, number),
    street: street.name,
    number,
    plz: street.plz ?? '',
    place: street.place ?? '',
    access: null,
    entrances: [],
    note: '',
    updated: 0,
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const boxes = (n: number) => `${n} ${n === 1 ? 'Briefkasten' : 'Briefkästen'}`;

/** "42: 2 Eingänge. Rechts: 3 Briefkästen. Links hinten: 2 Briefkästen." */
export function summarize(info: HouseInfo): string[] {
  const lines: string[] = [];
  const n = info.entrances.length;
  if (n) {
    lines.push(`${info.number}: ${n} ${n === 1 ? 'Eingang' : 'Eingänge'}.`);
    for (const e of info.entrances) lines.push(`${cap(e.pos)}: ${boxes(e.boxes)}.`);
  } else lines.push(`${info.number}:`);
  if (info.access) lines.push(`Zufahrt: ${info.access}.`);
  if (info.note.trim()) lines.push(`„${info.note.trim()}“`);
  return lines;
}

export function isEmpty(info: HouseInfo): boolean {
  return !info.entrances.length && !info.access && !info.note.trim();
}
