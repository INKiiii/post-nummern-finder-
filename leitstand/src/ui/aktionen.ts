/** Auswahl aus Listen und Panels: auswählen und hinfliegen */
import { basisPosition, behaelterPosition, bezirkMitte, fahrzeugPosition } from '../szene/auswahl';
import { uebersichtsAbstand, uebersichtsPolar } from '../szene/Kamera';
import { useAnsicht, type Auswahl } from '../state/ansicht';
import { simUhr, useLeitstand } from '../state/store';

export function waehleUndZeige(a: Auswahl): void {
  const { welt, tag, plan, lage } = useLeitstand.getState();
  const { waehlen, fliegen, folgenSetzen } = useAnsicht.getState();
  waehlen(a);
  if (!a || !welt || !tag || !plan) return;
  if (a.art === 'fahrzeug') {
    const p = fahrzeugPosition(welt, tag, a.id, lage, simUhr.zeit);
    fliegen({ ziel: [p.x, 0.3, p.z], distanz: p.unterwegs ? 70 : 14 });
    // fahrende Fahrzeuge behält die Kamera im Blick
    folgenSetzen(p.unterwegs ? a.id : null);
  } else if (a.art === 'behaelter') {
    const p = behaelterPosition(welt, tag, plan, a.id);
    fliegen({ ziel: [p.x, 0.3, p.z], distanz: 9 });
  } else if (a.art === 'bezirk') {
    const p = bezirkMitte(welt, a.id);
    fliegen({ ziel: [p.x, 0, p.z], distanz: 55 });
  } else if (a.art === 'basis') {
    basisZeigen();
  }
}

export function basisZeigen(): void {
  const { welt } = useLeitstand.getState();
  if (!welt) return;
  const p = basisPosition(welt);
  // von Nordosten auf die Rampen schauen
  useAnsicht.getState().fliegen({ ziel: [p.x, 0, p.z - 1.5], distanz: 22, polar: 0.92, azimut: Math.PI - 0.55 });
}

export function ganzeKarte(): void {
  const { welt } = useLeitstand.getState();
  if (!welt) return;
  useAnsicht.getState().fliegen({ ziel: [welt.breiteKm * 50, 0, -welt.hoeheKm * 50], distanz: uebersichtsAbstand(), polar: uebersichtsPolar(), azimut: 0 });
}
