import type { Kontext } from '../core/modell';
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
