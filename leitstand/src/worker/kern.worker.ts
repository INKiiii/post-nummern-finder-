/// <reference lib="webworker" />
/**
 * Rechenkern im Web Worker: Optimierung und Vorschläge laufen hier, damit die 3D-Szene
 * flüssig bleibt.
 */
import { berechneIdeeInZahlen } from '../core/ideeInZahlen';
import { erstelleKontext } from '../core/modell';
import { optimiere } from '../core/optimierer';
import type { Welt } from '../core/types';
import { erzeugeVorschlaege } from '../core/vorschlaege';
import type { Anfrage, Antwort, KernEingabe } from './protokoll';

let welt: Welt | null = null;

function kontext(e: KernEingabe) {
  if (!welt) throw new Error('Welt fehlt');
  return erstelleKontext(welt, e.tag, e.annahmen);
}

self.onmessage = (ev: MessageEvent<{ id: number; anfrage: Anfrage }>) => {
  const { id, anfrage } = ev.data;
  let antwort: Antwort;
  try {
    let ergebnis: unknown = null;
    switch (anfrage.art) {
      case 'welt':
        welt = anfrage.welt;
        break;
      case 'vorschlaege':
        ergebnis = erzeugeVorschlaege(kontext(anfrage.eingabe), anfrage.eingabe.plan, { wiederkehrend: anfrage.wiederkehrend });
        break;
      case 'optimiere':
        ergebnis = optimiere(kontext(anfrage.eingabe), anfrage.eingabe.plan, anfrage.optionen);
        break;
      case 'zahlen':
        if (!welt) throw new Error('Welt fehlt');
        ergebnis = berechneIdeeInZahlen(welt, anfrage.annahmen);
        break;
    }
    antwort = { id, ok: true, ergebnis };
  } catch (e) {
    antwort = { id, ok: false, fehler: e instanceof Error ? e.message : String(e) };
  }
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(antwort);
};
