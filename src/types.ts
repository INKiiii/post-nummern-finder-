// Gemeinsame Typen der App.

export interface HouseNumber {
  label: string;
  norm: string;
  num: number | null;
  suffix: string;
  to: number | null;
  lat: number;
  lon: number;
  source: string;
  plz: string;
  user?: boolean;
  pointId?: string;
}

export interface Street {
  id: string;
  name: string;
  place: string;
  plz: string;
  norm: string;
  fold: string;
  lines: [number, number][][];
  numbers: HouseNumber[];
  q: { min: number | null; max: number | null; missing: number[]; count: number; ratio: number; gap: boolean } | null;
  regions: Set<string>;
  user: boolean;
  start?: [number, number] | null;
  bbox: [number, number, number, number] | null;
}

export interface Index {
  streets: Map<string, Street>;
  byNorm: Map<string, Street[]>;
}

export interface FindResult {
  status: 'exact' | 'range' | 'base' | 'interpolated' | 'extrapolated' | 'single' | 'street' | 'none';
  lat: number;
  lon: number;
  estimated: boolean;
  match?: HouseNumber;
  neighbors: HouseNumber[];
}

export interface RegionEntry {
  id: string;
  name: string;
  plz: string[];
  places: string[];
  file: string;
  size: number;
  streets: number;
  numbers: number;
  gaps: number;
  hash: string;
  updated: string;
  sources: string[];
}

export interface SourceMeta {
  id: string;
  name: string;
  license: string;
  attribution: string;
  url: string;
  date: string;
}

export interface RegionPackage {
  format: string;
  version: number;
  id: string;
  name: string;
  plz: string;
  places: string[];
  built: string;
  sources: SourceMeta[];
  streets: unknown[];
}

export interface StoredPackage {
  id: string;
  entry: RegionEntry;
  pkg: RegionPackage;
  size: number;
  downloadedAt: number;
}

export interface Entrance {
  pos: string;
  boxes: number;
}

export interface HouseInfo {
  key: string;
  street: string;
  number: string;
  plz: string;
  place: string;
  access: string | null;
  entrances: Entrance[];
  note: string;
  updated: number;
}

export interface UserPoint {
  id: string;
  streetId: string | null;
  streetName: string;
  number: string;
  plz: string;
  lat: number;
  lon: number;
  created: number;
  updated: number;
}

export interface UserStreet {
  id: string;
  name: string;
  place: string;
  plz: string;
  line: [number, number][];
  start: [number, number] | null;
  created: number;
  updated: number;
}

export interface RecentAddress {
  streetId: string;
  streetName: string;
  place: string;
  number: string;
  at: number;
}
