/** Deterministischer Zufallsgenerator (mulberry32). Gleicher Seed → gleiche Demo-Welt. */
export interface Zufall {
  /** Zahl in [0, 1) */
  (): number;
  zwischen(min: number, max: number): number;
  ganz(min: number, max: number): number;
  wahl<T>(liste: readonly T[]): T;
}

export function zufall(seed: number): Zufall {
  let s = seed >>> 0;
  const r = (() => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Zufall;
  r.zwischen = (min, max) => min + (max - min) * r();
  r.ganz = (min, max) => Math.floor(min + (max - min + 1) * r());
  r.wahl = (liste) => liste[Math.floor(r() * liste.length)];
  return r;
}
