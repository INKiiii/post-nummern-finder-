import { Line } from '@react-three/drei';
import { useMemo } from 'react';
import type { Kontext, PlanAuswertung } from '../core/modell';
import { tourWeg } from '../core/route';
import { useAnsicht } from '../state/ansicht';
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

/** Geplante Route der ausgewählten Tour, gestrichelt in Tourfarbe */
export function Route({ ctx, aus }: { ctx: Kontext; aus: PlanAuswertung }) {
  const auswahl = useAnsicht((s) => s.auswahl);
  const abstand = useAnsicht((s) => s.kameraAbstand);
  const tourId = auswahl?.art === 'fahrzeug' ? auswahl.id : auswahl?.art === 'behaelter' ? aus.tourIds.find((id) => aus.touren[id].zustellt.includes(auswahl.id)) : undefined;
  const punkte = useMemo(() => {
    if (!tourId) return null;
    const weg = tourWeg(ctx, aus, tourId);
    if (weg.length < 2) return null;
    return weg.map((n) => [ctx.welt.netz.knoten[n].x * S, 0.35, -ctx.welt.netz.knoten[n].y * S] as [number, number, number]);
  }, [ctx, aus, tourId]);
  if (!tourId || !punkte) return null;
  const farbe = ctx.tag.touren.find((t) => t.id === tourId)!.farbe;
  const strich = Math.max(0.8, abstand / 70);
  return <Line points={punkte} color={farbe} lineWidth={3.5} dashed dashSize={strich} gapSize={strich * 0.7} />;
}
