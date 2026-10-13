import type { OptimiererOptionen } from '../core/optimierer';
import type { Plan, Welt } from '../core/types';
import type { Vorschlag } from '../core/vorschlaege';
import type { Anfrage, Antwort, KernEingabe } from './protokoll';

/** Schlanke Promise-Hülle um den Rechenkern-Worker */
export class KernClient {
  private worker: Worker;
  private naechsteId = 1;
  private offen = new Map<number, { ok: (v: unknown) => void; fehler: (e: Error) => void }>();

  constructor() {
    this.worker = new Worker(new URL('./kern.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<Antwort>) => {
      const a = ev.data;
      const p = this.offen.get(a.id);
      if (!p) return;
      this.offen.delete(a.id);
      if (a.ok) p.ok(a.ergebnis);
      else p.fehler(new Error(a.fehler));
    };
  }

  private senden<T>(anfrage: Anfrage): Promise<T> {
    const id = this.naechsteId++;
    return new Promise<T>((ok, fehler) => {
      this.offen.set(id, { ok: ok as (v: unknown) => void, fehler });
      this.worker.postMessage({ id, anfrage });
    });
  }

  setzeWelt(welt: Welt): Promise<void> {
    return this.senden({ art: 'welt', welt });
  }

  vorschlaege(eingabe: KernEingabe, wiederkehrend: boolean): Promise<Vorschlag[]> {
    return this.senden({ art: 'vorschlaege', eingabe, wiederkehrend });
  }

  optimiere(eingabe: KernEingabe, optionen: OptimiererOptionen = {}): Promise<Plan> {
    return this.senden({ art: 'optimiere', eingabe, optionen });
  }

  beenden(): void {
    this.worker.terminate();
  }
}
