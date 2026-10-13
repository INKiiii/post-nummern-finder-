/**
 * Übertragung zwischen Leitstand und Geräte-Ansicht über BroadcastChannel (zwei Fenster
 * desselben Browsers, z. B. nebeneinander fürs Video). In echt wäre das die Nachrichten-
 * schnittstelle der Handscanner.
 */
import type { FahrerGeraet, FahrerNachricht, GeraeteMeldung } from '../core/quellen';
import type { ScanEreignis } from '../core/scan';
import type { TourPlan } from '../core/types';

export const KANAL = 'zustell-leitstand-geraete-v1';

export type VonZentrale =
  | { typ: 'nachricht'; n: FahrerNachricht }
  | { typ: 'scan'; tourId: string; e: ScanEreignis }
  | { typ: 'tour'; tourId: string; plan: TourPlan; uebergabeZeiten?: Record<string, number> }
  | { typ: 'zeit'; zeit: number; laeuft: boolean; tempo: number }
  | { typ: 'verlauf'; tourId: string; scans: ScanEreignis[]; nachrichten: FahrerNachricht[]; bestaetigt: string[] }
  | { typ: 'neustart' };

export type VomGeraet =
  | { typ: 'anmelden'; tourId: string; geraetId: string }
  | { typ: 'lebenszeichen'; tourId: string; geraetId: string }
  | { typ: 'abmelden'; tourId: string; geraetId: string }
  | { typ: 'bestaetigung'; tourId: string; nachrichtId: string; zeit: number };

function kanal(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(KANAL);
}

/** Leitstand-Seite: erfüllt die Schnittstelle FahrerGeraet für alle Touren */
export class BroadcastFahrerGeraet implements FahrerGeraet {
  private k = kanal();
  private abos = new Set<(m: GeraeteMeldung) => void>();
  /** Rohnachrichten der Geräte (für Anmeldung/Verlauf im Prototyp) */
  onGeraet: ((m: VomGeraet) => void) | null = null;

  constructor() {
    if (this.k)
      this.k.onmessage = (ev: MessageEvent<VomGeraet>) => {
        const m = ev.data;
        this.onGeraet?.(m);
        if (m.typ === 'bestaetigung') this.melden({ art: 'bestaetigung', nachrichtId: m.nachrichtId, tourId: m.tourId, zeit: m.zeit });
        if (m.typ === 'anmelden') this.melden({ art: 'angemeldet', tourId: m.tourId, geraetId: m.geraetId });
        if (m.typ === 'abmelden') this.melden({ art: 'abgemeldet', tourId: m.tourId, geraetId: m.geraetId });
      };
  }

  private melden(m: GeraeteMeldung): void {
    for (const cb of this.abos) cb(m);
  }

  senden(n: FahrerNachricht): void {
    this.post({ typ: 'nachricht', n });
  }

  abonnieren(cb: (m: GeraeteMeldung) => void): () => void {
    this.abos.add(cb);
    return () => this.abos.delete(cb);
  }

  /** Nur im Prototyp: Scans und Uhr an die Geräte-Ansicht spiegeln (in echt entstehen sie dort) */
  post(m: VonZentrale): void {
    this.k?.postMessage(m);
  }

  schliessen(): void {
    this.k?.close();
    this.k = null;
  }
}

/** Geräte-Seite */
export class GeraeteKanal {
  private k = kanal();
  readonly geraetId = Math.random().toString(36).slice(2, 8);

  constructor(
    private tourId: string,
    onNachricht: (m: VonZentrale) => void,
  ) {
    if (this.k)
      this.k.onmessage = (ev: MessageEvent<VonZentrale>) => {
        const m = ev.data;
        if ('tourId' in m && m.tourId !== this.tourId) return;
        if (m.typ === 'nachricht' && m.n.tourId !== this.tourId) return;
        onNachricht(m);
      };
  }

  get verfuegbar(): boolean {
    return this.k !== null;
  }

  anmelden(): void {
    this.k?.postMessage({ typ: 'anmelden', tourId: this.tourId, geraetId: this.geraetId } satisfies VomGeraet);
  }

  lebenszeichen(): void {
    this.k?.postMessage({ typ: 'lebenszeichen', tourId: this.tourId, geraetId: this.geraetId } satisfies VomGeraet);
  }

  bestaetigen(nachrichtId: string, zeit: number): void {
    this.k?.postMessage({ typ: 'bestaetigung', tourId: this.tourId, nachrichtId, zeit } satisfies VomGeraet);
  }

  schliessen(): void {
    this.k?.postMessage({ typ: 'abmelden', tourId: this.tourId, geraetId: this.geraetId } satisfies VomGeraet);
    this.k?.close();
    this.k = null;
  }
}
