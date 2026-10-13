import { Line, QuadraticBezierLine } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Group } from 'three';
import { baueRoute, routenSchritte } from '../core/route';
import { useAnsicht } from '../state/ansicht';
import { useLeitstand, type Vorschau } from '../state/store';
import { setzeAnker } from './beschriftung';
import { behaelterGeometrie } from './geometrie';
import { S } from './koord';
import { hallenPlatz } from './layout';

const HOEHE = 0.55;

/** Touren, die eine Vorschau betrifft */
export function vorschauTouren(v: Vorschau): Set<string> {
  const s = new Set(v.delta.betroffen);
  for (const a of v.aenderungen) {
    if (a.von) s.add(a.von);
    if (a.nach) s.add(a.nach);
  }
  return s;
}

/**
 * 3D-Vorschau einer Umplanung: neue Routen der betroffenen Touren (gestrichelt, kräftig),
 * Treffpunkte der Übergaben und für Behälter in der Halle der neue Platz.
 */
export function VorschauSzene() {
  const v = useLeitstand((s) => s.vorschau);
  const ctx = useLeitstand((s) => s.ctxLive);
  const lage = useLeitstand((s) => s.lage);
  const abstand = useAnsicht((s) => s.kameraAbstand);
  const routen = useMemo(() => {
    if (!v || !ctx) return [];
    return [...vorschauTouren(v)].flatMap((id) => {
      const st = ctx.tag.start[id];
      const schritte = v.rest.touren[id]?.schritte ?? [];
      if (!st?.besetzt || (schritte.length === 0 && st.mussLaden)) return [];
      const r = baueRoute(ctx, st.knoten, routenSchritte(schritte), !st.defekt);
      if (r.punkte.length < 2) return [];
      const farbe = ctx.tag.touren.find((t) => t.id === id)!.farbe;
      return [{ id, farbe, punkte: r.punkte.map((p) => [p.x * S, HOEHE, -p.y * S] as [number, number, number]) }];
    });
  }, [v, ctx]);

  const umzuege = useMemo(() => {
    if (!v || !ctx || !lage) return [];
    return v.aenderungen.flatMap((a) => {
      if (lage.behaelter(a.behaelterId).status !== 'halle' || !a.nach) return [];
      const alt = hallenPlatz(ctx.welt, ctx.tag, useLeitstand.getState().plan!, a.behaelterId);
      const neu = hallenPlatz(ctx.welt, ctx.tag, v.tagesplan, a.behaelterId);
      const farbe = ctx.tag.touren.find((t) => t.id === a.nach)!.farbe;
      return [{ id: a.behaelterId, alt, neu, farbe }];
    });
  }, [v, ctx, lage]);

  // Ankerpunkte für die Beschriftung der Treffpunkte
  useLayoutEffect(() => {
    if (!v || !ctx) return;
    for (const u of v.uebergaben) {
      const k = ctx.welt.netz.knoten[u.treffpunkt.knoten];
      setzeAnker(`vorschau:${u.id}`, k.x * S, 2.2, -k.y * S);
    }
  }, [v, ctx]);

  if (!v || !ctx) return null;
  const strich = Math.max(1.2, abstand / 45);
  const gross = Math.min(9, Math.max(1, abstand / 55));
  return (
    <group>
      {routen.map((r) => (
        <group key={r.id}>
          <Line points={r.punkte} color="#ffffff" lineWidth={8} transparent opacity={0.85} depthWrite={false} renderOrder={20} />
          <Line points={r.punkte} color={r.farbe} lineWidth={4.5} dashed dashSize={strich} gapSize={strich * 0.55} transparent opacity={1} depthWrite={false} renderOrder={21} />
        </group>
      ))}
      {v.uebergaben.map((u) => {
        const k = ctx.welt.netz.knoten[u.treffpunkt.knoten];
        return <TreffMarke key={u.id} x={k.x * S} z={-k.y * S} gross={gross} />;
      })}
      {umzuege.map((m) => (
        <group key={m.id}>
          <QuadraticBezierLine
            start={[m.alt.x, 0.7, m.alt.z]}
            end={[m.neu.x, 0.7, m.neu.z]}
            mid={[(m.alt.x + m.neu.x) / 2, 2.2, (m.alt.z + m.neu.z) / 2]}
            color={m.farbe}
            lineWidth={3}
            dashed
            dashSize={0.25}
            gapSize={0.15}
          />
          <Geist x={m.neu.x} z={m.neu.z} farbe={m.farbe} />
        </group>
      ))}
    </group>
  );
}

/** Treffpunkt der Übergabe: pulsierender Ring mit Mast */
function TreffMarke({ x, z, gross }: { x: number; z: number; gross: number }) {
  const ring = useRef<Group>(null);
  useFrame(() => {
    const t = (performance.now() % 1600) / 1600;
    if (ring.current) ring.current.scale.setScalar(1 + 0.35 * Math.sin(t * Math.PI * 2));
  });
  return (
    <group position={[x, 0, z]} scale={gross}>
      <group ref={ring} position={[0, 0.12, 0]}>
        <mesh rotation-x={-Math.PI / 2}>
          <ringGeometry args={[0.9, 1.25, 32]} />
          <meshBasicMaterial color="#3a56d4" transparent opacity={0.85} depthWrite={false} />
        </mesh>
      </group>
      <mesh position={[0, 0.8, 0]}>
        <cylinderGeometry args={[0.06, 0.06, 1.6, 8]} />
        <meshLambertMaterial color="#3a56d4" />
      </mesh>
      <mesh position={[0, 1.65, 0]}>
        <sphereGeometry args={[0.24, 16, 10]} />
        <meshBasicMaterial color="#3a56d4" />
      </mesh>
    </group>
  );
}

const geistGeo = behaelterGeometrie();

/** halbdurchsichtiger Behälter am neuen Platz */
function Geist({ x, z, farbe }: { x: number; z: number; farbe: string }) {
  return (
    <mesh geometry={geistGeo} position={[x, 0.12, z]}>
      <meshLambertMaterial color={farbe} transparent opacity={0.45} depthWrite={false} />
    </mesh>
  );
}
