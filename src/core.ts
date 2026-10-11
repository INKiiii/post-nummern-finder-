// Typisierte Fassade über die gemeinsamen JS-Module (src/shared), die auch die
// Node-Skripte verwenden.

import * as L from './shared/lookup.js';
import * as N from './shared/normalize.js';
import * as H from './shared/housenumber.js';
import * as G from './shared/geo.js';
import type { FindResult, Index, RegionPackage, Street, UserPoint, UserStreet } from './types';

export const buildIndex = L.buildIndex as unknown as (
  pkgs: RegionPackage[],
  user?: { points?: UserPoint[]; streets?: UserStreet[] },
) => Index;
export const searchStreets = L.searchStreets as unknown as (index: Index, q: string, limit?: number) => Street[];
export const findHouse = L.findHouse as unknown as (street: Street, input: string) => FindResult;
export const sortedNumbers = L.sortedNumbers as unknown as (street: Street) => Street['numbers'];
export const streetMidpoint = L.streetMidpoint as unknown as (street: Street) => [number, number] | null;
export const PACKAGE_FORMAT: string = L.PACKAGE_FORMAT;
export const drivewayFor = L.drivewayFor as unknown as (
  street: Street,
  input: string,
  result?: FindResult,
) => { line: [number, number][]; junction: [number, number]; user: boolean; pointId?: string } | null;
export const distanceToStreet = L.distanceToStreet as unknown as (street: Street, lat: number, lon: number) => number | null;

export const normStreet: (s: string) => string = N.normStreet;
export const foldText: (s: string) => string = N.foldText;
export const editDistance: (a: string, b: string, max?: number) => number = N.editDistance;

export const parseHouseNumber = H.parseHouseNumber as (s: string) => {
  label: string;
  norm: string;
  num: number | null;
  suffix: string;
  to: number | null;
};
export const normHouseNumber: (s: string) => string = H.normHouseNumber;
export const formatRanges: (n: number[], limit?: number) => string = H.formatRanges;

export const distanceM: (a: number, b: number, c: number, d: number) => number = G.distanceM;
export const bearingDeg: (a: number, b: number, c: number, d: number) => number = G.bearingDeg;
export const wrap180: (a: number) => number = G.wrap180;
export const makeProjection = G.makeProjection as (
  lat0: number,
  lon0: number,
) => { toXY: (lat: number, lon: number) => [number, number]; toLatLon: (x: number, y: number) => [number, number] };
export const projectOnLine = G.projectOnLine as (
  p: number[],
  line: number[][],
) => { s: number; dist: number; seg: number; t: number; point: number[]; tangent: number[]; cross: number } | null;
