import { Line } from '@react-three/drei';
import { useMemo } from 'react';
import type { Kontext } from '../core/modell';
import { useAnsicht } from '../state/ansicht';
import { useLeitstand } from '../state/store';
import { S } from './koord';

/** Treffpunkte als Pins (Namen in der Beschriftungsebene) */
export function Beschriftungen({ ctx }: { ctx: Kontext }) {
  const abstand = useAnsicht((s) => s.kameraAbstand);
  const { welt } = ctx;
  return (
    <group>
      {welt.treffpunkte.map((t) => {
        const k = welt.netz.knoten[t.knoten];
        const gross = Math.min(8, Math.max(1, abstand / 60));
        return (
          <group key={t.id} position={[k.x * S, 0, -k.y * S]} scale={gross}>
            <mesh position={[0, 0.45, 0]}>
              <cylinderGeometry args={[0.035, 0.035, 0.9, 6]} />
              <meshLambertMaterial color="#3a4250" />
            </mesh>
            <mesh position={[0, 0.95, 0]}>
              <sphereGeometry args={[0.17, 12, 8]} />
              <meshLambertMaterial color="#ffffff" emissive="#555" />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

/** Route der ausgewählten Tour (laut Lagebild), gestrichelt in Tourfarbe */
export function Route({ ctx }: { ctx: Kontext }) {
  const auswahl = useAnsicht((s) => s.auswahl);
  const abstand = useAnsicht((s) => s.kameraAbstand);
  const lage = useLeitstand((s) => s.lage);
  const plan = useLeitstand((s) => s.plan);
  const lageVersion = useLeitstand((s) => s.lageVersion);
  const tourId =
    auswahl?.art === 'fahrzeug'
      ? auswahl.id
      : auswahl?.art === 'behaelter'
        ? ctx.tag.touren.find((t) => plan?.touren[t.id]?.schritte.some((x) => x.art === 'bezirk' && x.behaelterId === auswahl.id))?.id
        : undefined;
  const route = tourId && lage ? lage.fahrzeug(tourId).route : null;
  const punkte = useMemo(() => {
    void lageVersion;
    if (!route || route.punkte.length < 2) return null;
    return route.punkte.map((p) => [p.x * S, 0.35, -p.y * S] as [number, number, number]);
  }, [route, lageVersion]);
  if (!tourId || !punkte) return null;
  const farbe = ctx.tag.touren.find((t) => t.id === tourId)!.farbe;
  const strich = Math.max(0.8, abstand / 70);
  return <Line points={punkte} color={farbe} lineWidth={3.5} dashed dashSize={strich} gapSize={strich * 0.7} />;
}
