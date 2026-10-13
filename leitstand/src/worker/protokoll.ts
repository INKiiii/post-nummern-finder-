import type { Annahmen } from '../config';
import type { OptimiererOptionen } from '../core/optimierer';
import type { Plan, Tag, Welt } from '../core/types';

export interface KernEingabe {
  tag: Tag;
  plan: Plan;
  annahmen: Annahmen;
}

export type Anfrage =
  | { art: 'welt'; welt: Welt }
  | { art: 'vorschlaege'; eingabe: KernEingabe; wiederkehrend: boolean }
  | { art: 'optimiere'; eingabe: KernEingabe; optionen: OptimiererOptionen }
  | { art: 'zahlen'; annahmen: Annahmen };

export type Antwort = { id: number; ok: true; ergebnis: unknown } | { id: number; ok: false; fehler: string };
