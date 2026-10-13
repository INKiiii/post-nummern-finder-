import { Line } from '@react-three/drei';
import { useMemo } from 'react';
import type { Welt } from '../core/types';
import { useAnsicht } from '../state/ansicht';
import { markierungGeometrie, strassenGeometrie } from './geometrie';
import { REIHENFOLGE, S } from './koord';

export function Strassen({ welt }: { welt: Welt }) {
  const geo = useMemo(() => ({ strassen: strassenGeometrie(welt), markierung: markierungGeometrie(welt) }), [welt]);
  return (
    <group>
      <mesh geometry={geo.strassen} receiveShadow renderOrder={REIHENFOLGE.strassen}>
        <meshLambertMaterial vertexColors depthWrite={false} />
      </mesh>
      <mesh geometry={geo.markierung} renderOrder={REIHENFOLGE.markierung}>
        <meshLambertMaterial vertexColors depthWrite={false} />
      </mesh>
      <Uebersichtslinien welt={welt} />
    </group>
  );
}

/**
 * Aus der Ferne wären die Straßen schmaler als ein Pixel. Dann blenden wir Linien mit
 * fester Bildschirmbreite ein.
 */
function Uebersichtslinien({ welt }: { welt: Welt }) {
  const abstand = useAnsicht((s) => s.kameraAbstand);
  const linien = useMemo(() => {
    const gross: [number, number, number][] = [];
    const klein: [number, number, number][] = [];
    const k = welt.netz.knoten;
    for (const e of welt.netz.kanten) {
      const ziel = e.typ === 'ort' || e.typ === 'zufahrt' || e.typ === 'gewerbe' ? klein : gross;
      ziel.push([k[e.a].x * S, 0.12, -k[e.a].y * S], [k[e.b].x * S, 0.12, -k[e.b].y * S]);
    }
    return { gross, klein };
  }, [welt]);
  const deckkraft = Math.max(0, Math.min(1, (abstand - 140) / 260));
  if (deckkraft <= 0.01) return null;
  return (
    <group renderOrder={REIHENFOLGE.uebersicht}>
      <Line points={linien.gross} segments color="#7c838d" lineWidth={2.4} transparent opacity={deckkraft} depthWrite={false} renderOrder={REIHENFOLGE.uebersicht} />
      <Line points={linien.klein} segments color="#9fa5ad" lineWidth={1.3} transparent opacity={deckkraft} depthWrite={false} renderOrder={REIHENFOLGE.uebersicht} />
    </group>
  );
}
