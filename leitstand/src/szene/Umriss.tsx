import { BackSide, BoxGeometry, type BufferGeometry } from 'three';

const cache = new WeakMap<BufferGeometry, BufferGeometry>();

/** Hülle um eine Geometrie: um den Mittelpunkt vergrößert, nur Rückseiten sichtbar */
function huelle(geo: BufferGeometry): BufferGeometry {
  let h = cache.get(geo);
  if (h) return h;
  geo.computeBoundingBox();
  const b = geo.boundingBox!;
  const mx = (b.min.x + b.max.x) / 2;
  const my = (b.min.y + b.max.y) / 2;
  const mz = (b.min.z + b.max.z) / 2;
  h = geo.clone().translate(-mx, -my, -mz);
  h.userData = { mitte: [mx, my, mz], groesse: [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z] };
  cache.set(geo, h);
  return h;
}

/**
 * Umriss für Auswahl und Hover (Inverted Hull): eine leicht größere Kopie der Geometrie,
 * von der nur die Innenseite gezeichnet wird. Dicke in Szene-Einheiten.
 */
export function Umriss({ geometrie, dicke, farbe = '#ffffff' }: { geometrie: BufferGeometry; dicke: number; farbe?: string }) {
  const h = huelle(geometrie);
  const [mx, my, mz] = h.userData.mitte as number[];
  const [gx, gy, gz] = h.userData.groesse as number[];
  return (
    <mesh geometry={h} position={[mx, my, mz]} scale={[1 + (2 * dicke) / gx, 1 + (2 * dicke) / gy, 1 + (2 * dicke) / gz]} raycast={() => null}>
      <meshBasicMaterial color={farbe} side={BackSide} />
    </mesh>
  );
}

export const EINHEITSWUERFEL = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);

/** Umriss-Dicke passend zum Kameraabstand (wirkt ungefähr gleich breit) */
export function umrissDicke(kameraAbstand: number, faktor = 1): number {
  return Math.min(0.6, Math.max(0.012, kameraAbstand * 0.0022)) * faktor;
}
