import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { MeshLambertMaterial } from 'three';
import type { Welt } from '../core/types';
import { useAnsicht } from '../state/ansicht';
import { THEME } from '../theme';
import { EBENE, REIHENFOLGE, S } from './koord';
import { halleMitte } from './layout';
import { textTextur } from './textur';

const WAND_H = 0.85;
const TUER_B = 0.82;
const TUER_H = 0.58;

/** Zustellbasis: Halle mit Rampen, Bereitstellfläche, Hof und Parkplätzen */
export function Basis({ welt }: { welt: Welt }) {
  const m = halleMitte(welt);
  const B = welt.basis.halle.breiteKm * S;
  const T = welt.basis.halle.tiefeKm * S;
  const nord = -T / 2;
  const tueren = welt.basis.rampen.map((r) => r.pos.x * S - m.x);
  const dach = useRef<MeshLambertMaterial>(null);
  const waehlen = useAnsicht((s) => s.waehlen);

  // Dach wird durchsichtig, wenn die Kamera nah ist (Blick in die Halle)
  useFrame(({ camera }) => {
    if (!dach.current) return;
    const d = Math.hypot(camera.position.x - m.x, camera.position.y, camera.position.z - m.z);
    const ziel = d < 45 ? 0.12 : d < 90 ? 0.12 + ((d - 45) / 45) * 0.88 : 1;
    dach.current.opacity += (ziel - dach.current.opacity) * 0.15;
    dach.current.depthWrite = dach.current.opacity > 0.5;
  });

  // Nordwand zwischen den Toren
  const nordwand = useMemo(() => {
    const teile: Array<{ x: number; b: number }> = [];
    let x0 = -B / 2;
    for (const t of tueren) {
      teile.push({ x: (x0 + t - TUER_B / 2) / 2, b: t - TUER_B / 2 - x0 });
      x0 = t + TUER_B / 2;
    }
    teile.push({ x: (x0 + B / 2) / 2, b: B / 2 - x0 });
    return teile.filter((t) => t.b > 0.01);
  }, [B, tueren]);

  const parkplaetze = welt.basis.parkplaetze.map((p) => ({ x: p.x * S - m.x, z: -p.y * S - m.z }));
  const hofTiefe = (welt.basis.pos.y - welt.netz.knoten[welt.basis.knoten].y) * S; // negativ: Hof liegt nördlich

  return (
    <group position={[m.x, 0, m.z]}>
      {/* Hof */}
      <mesh rotation-x={-Math.PI / 2} position={[-1, EBENE.hof, (nord + hofTiefe) / 2 + 0.6]} receiveShadow renderOrder={REIHENFOLGE.hof}>
        <planeGeometry args={[B + 7, Math.abs(hofTiefe - nord) + T + 2.6]} />
        <meshLambertMaterial color="#c8ccd1" depthWrite={false} />
      </mesh>
      {/* Parkplätze */}
      {parkplaetze.map((p, i) => (
        <mesh key={i} rotation-x={-Math.PI / 2} position={[p.x, EBENE.hof + 0.01, p.z]} renderOrder={REIHENFOLGE.markierung}>
          <planeGeometry args={[1.5, 0.05]} />
          <meshBasicMaterial color="#f4f4f0" depthWrite={false} />
        </mesh>
      ))}
      {/* Boden der Halle und Bereitstellfläche */}
      <mesh position={[0, 0.06, 0]} receiveShadow>
        <boxGeometry args={[B, 0.12, T]} />
        <meshLambertMaterial color="#d6dade" />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.125, nord + 1.3]} receiveShadow>
        <planeGeometry args={[B - 0.6, 2.2]} />
        <meshLambertMaterial color={THEME.szene.bereitstell} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.127, nord + 2.45]}>
        <planeGeometry args={[B - 0.6, 0.05]} />
        <meshBasicMaterial color="#f2f2ee" />
      </mesh>
      {/* Wände */}
      <mesh position={[0, WAND_H / 2 + 0.12, T / 2]} castShadow receiveShadow>
        <boxGeometry args={[B, WAND_H, 0.12]} />
        <meshLambertMaterial color={THEME.szene.halle} />
      </mesh>
      {[-B / 2, B / 2].map((x) => (
        <mesh key={x} position={[x, WAND_H / 2 + 0.12, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.12, WAND_H, T]} />
          <meshLambertMaterial color={THEME.szene.halle} />
        </mesh>
      ))}
      {nordwand.map((t, i) => (
        <mesh key={i} position={[t.x, WAND_H / 2 + 0.12, nord]} castShadow receiveShadow>
          <boxGeometry args={[t.b, WAND_H, 0.12]} />
          <meshLambertMaterial color={THEME.szene.halle} />
        </mesh>
      ))}
      {tueren.map((x, i) => (
        <group key={i} position={[x, 0, nord]}>
          {/* Sturz über dem Tor */}
          <mesh position={[0, TUER_H + 0.12 + (WAND_H - TUER_H) / 2, 0]} castShadow>
            <boxGeometry args={[TUER_B, WAND_H - TUER_H, 0.12]} />
            <meshLambertMaterial color={THEME.szene.halle} />
          </mesh>
          {/* Rampe (Andockplatte) */}
          <mesh position={[0, 0.07, -0.16]} receiveShadow>
            <boxGeometry args={[TUER_B, 0.12, 0.32]} />
            <meshLambertMaterial color={THEME.szene.rampe} />
          </mesh>
          {/* Nummernschild */}
          <mesh position={[0, WAND_H + 0.02, -0.07]} rotation-y={Math.PI}>
            <planeGeometry args={[0.32, 0.22]} />
            <meshBasicMaterial map={textTextur(String(i + 1), '#2a3240')} />
          </mesh>
        </group>
      ))}
      {/* Dach */}
      <mesh position={[0, WAND_H + 0.16, 0]} onClick={(e) => {
        if (e.delta > 6) return;
        e.stopPropagation();
        waehlen({ art: 'basis', id: 'basis' });
      }}>
        <boxGeometry args={[B + 0.4, 0.1, T + 0.4]} />
        <meshLambertMaterial ref={dach} color={THEME.szene.halleDach} transparent />
      </mesh>
    </group>
  );
}
