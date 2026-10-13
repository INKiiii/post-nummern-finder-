import { CanvasTexture, SRGBColorSpace } from 'three';

const cache = new Map<string, CanvasTexture>();

/** Kleine Textur mit Text (z. B. Rampen- oder Tournummer), ohne externe Schriften */
export function textTextur(text: string, hintergrund: string, schrift = '#ffffff', breite = 128, hoehe = 128): CanvasTexture {
  const key = `${text}|${hintergrund}|${schrift}|${breite}x${hoehe}`;
  const vorhanden = cache.get(key);
  if (vorhanden) return vorhanden;
  const c = document.createElement('canvas');
  c.width = breite;
  c.height = hoehe;
  const g = c.getContext('2d')!;
  g.fillStyle = hintergrund;
  g.fillRect(0, 0, breite, hoehe);
  g.fillStyle = schrift;
  g.font = `700 ${Math.round(hoehe * 0.62)}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, breite / 2, hoehe / 2 + hoehe * 0.04);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  cache.set(key, t);
  return t;
}
