import { Line } from '@react-three/drei';
import { useLayoutEffect, useMemo } from 'react';
import type { Welt } from '../core/types';
import { useAnsicht } from '../state/ansicht';
import { useLeitstand } from '../state/store';
import { THEME } from '../theme';
import { setzeAnker } from './beschriftung';
import { S } from './koord';

/** Gesperrte Straßen (Szenario Stau): rot markiert, mit Absperrungen an beiden Enden */
export function Sperrungen({ welt }: { welt: Welt }) {
  const sperrungen = useLeitstand((s) => s.tag?.sperrungen);
  const abstand = useAnsicht((s) => s.kameraAbstand);
  const teile = useMemo(() => {
    if (!sperrungen?.length) return null;
    const k = welt.netz.knoten;
    const linien = sperrungen.map((id) => {
      const e = welt.netz.kanten[id];
      return [
        [k[e.a].x * S, 0.5, -k[e.a].y * S],
        [k[e.b].x * S, 0.5, -k[e.b].y * S],
      ] as [number, number, number][];
    });
    // Enden: Knoten, die nur an einer gesperrten Kante hängen
    const zaehler = new Map<number, number>();
    for (const id of sperrungen) for (const n of [welt.netz.kanten[id].a, welt.netz.kanten[id].b]) zaehler.set(n, (zaehler.get(n) ?? 0) + 1);
    const enden = [...zaehler].filter(([, n]) => n === 1).map(([id]) => ({ x: k[id].x * S, z: -k[id].y * S }));
    const xs = linien.flat().map((p) => p[0]);
    const zs = linien.flat().map((p) => p[2]);
    const mitte = { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 };
    return { linien, enden, mitte };
  }, [sperrungen, welt]);

  useLayoutEffect(() => {
    if (teile) setzeAnker('sperrung', teile.mitte.x, 2.5, teile.mitte.z);
  }, [teile]);

  if (!teile) return null;
  const gross = Math.min(7, Math.max(1, abstand / 60));
  return (
    <group>
      {teile.linien.map((l, i) => (
        <Line key={i} points={l} color={THEME.szene.sperrung} lineWidth={7} transparent opacity={0.9} depthWrite={false} renderOrder={22} />
      ))}
      {teile.enden.map((e, i) => (
        <group key={i} position={[e.x, 0, e.z]} scale={gross}>
          {[-0.35, 0, 0.35].map((dx) => (
            <mesh key={dx} position={[dx, 0.32, 0]}>
              <boxGeometry args={[0.32, 0.16, 0.06]} />
              <meshLambertMaterial color={dx === 0 ? '#ffffff' : THEME.szene.sperrung} />
            </mesh>
          ))}
          {[-0.5, 0.5].map((dx) => (
            <mesh key={dx} position={[dx, 0.2, 0]}>
              <boxGeometry args={[0.05, 0.4, 0.05]} />
              <meshLambertMaterial color="#3a4250" />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}
