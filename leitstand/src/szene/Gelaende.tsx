import { useLayoutEffect, useMemo, useRef } from 'react';
import { Color, ConeGeometry, CylinderGeometry, DodecahedronGeometry, InstancedMesh, Object3D } from 'three';
import { zufall } from '../core/rng';
import type { Welt } from '../core/types';
import { useAnsicht } from '../state/ansicht';
import { THEME } from '../theme';
import { felderGeometrie, glaette, linienBand } from './geometrie';
import { EBENE, REIHENFOLGE, S } from './koord';

/** Boden, Felder, Fluss, Bäume und Brücken */
export function Gelaende({ welt }: { welt: Welt }) {
  const felder = useMemo(() => felderGeometrie(welt), [welt]);
  const fluss = useMemo(() => {
    const linie = glaette(welt.landschaft.fluss, 2);
    const b = welt.landschaft.flussBreiteKm * S;
    return { ufer: linienBand(linie, b + 3.2, EBENE.ufer, '#8fae7a'), wasser: linienBand(linie, b, EBENE.wasser, THEME.szene.wasser) };
  }, [welt]);
  const mitteX = (welt.breiteKm * S) / 2;
  const mitteZ = (-welt.hoeheKm * S) / 2;
  return (
    <group>
      {/* flache Ebenen: feste Zeichenreihenfolge statt Tiefenpuffer (kein Flimmern aus der Ferne) */}
      <mesh rotation-x={-Math.PI / 2} position={[mitteX, EBENE.boden, mitteZ]} receiveShadow renderOrder={REIHENFOLGE.boden}>
        <planeGeometry args={[welt.breiteKm * S + 4000, welt.hoeheKm * S + 4000]} />
        <meshLambertMaterial color={THEME.szene.boden} depthWrite={false} />
      </mesh>
      <mesh geometry={felder} receiveShadow renderOrder={REIHENFOLGE.felder}>
        <meshLambertMaterial vertexColors depthWrite={false} />
      </mesh>
      <mesh geometry={fluss.ufer} receiveShadow renderOrder={REIHENFOLGE.ufer}>
        <meshLambertMaterial vertexColors depthWrite={false} />
      </mesh>
      <mesh geometry={fluss.wasser} renderOrder={REIHENFOLGE.wasser}>
        <meshStandardMaterial vertexColors roughness={0.18} metalness={0.05} depthWrite={false} />
      </mesh>
      <Baeume welt={welt} />
      <Bruecken welt={welt} />
    </group>
  );
}

const dummy = new Object3D();

function Baeume({ welt }: { welt: Welt }) {
  const qualitaet = useAnsicht((s) => s.qualitaet);
  const nadel = useRef<InstancedMesh>(null);
  const laub = useRef<InstancedMesh>(null);
  const stamm = useRef<InstancedMesh>(null);
  const daten = useMemo(() => {
    const rng = zufall(welt.seed + 11);
    const baeume = welt.landschaft.baeume.filter((_, i) => qualitaet === 'hoch' || i % 2 === 0);
    return baeume.map((b) => ({ ...b, nadel: rng() < 0.35, ton: rng.zwischen(0.82, 1.12), dreh: rng() * Math.PI * 2 }));
  }, [welt, qualitaet]);
  const anzahlNadel = daten.filter((b) => b.nadel).length;
  const anzahlLaub = daten.length - anzahlNadel;
  const geo = useMemo(
    () => ({
      nadel: new ConeGeometry(0.55, 1.5, 7).translate(0, 1.15, 0),
      laub: new DodecahedronGeometry(0.62, 0).translate(0, 1.05, 0),
      stamm: new CylinderGeometry(0.08, 0.11, 0.5, 5).translate(0, 0.25, 0),
    }),
    [],
  );

  useLayoutEffect(() => {
    let n = 0;
    let l = 0;
    const gruen = new Color(THEME.szene.wald);
    const c = new Color();
    daten.forEach((b, i) => {
      const s = 1.25 * b.groesse;
      dummy.position.set(b.x * S, 0, -b.y * S);
      dummy.rotation.set(0, b.dreh, 0);
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      stamm.current!.setMatrixAt(i, dummy.matrix);
      c.copy(gruen).multiplyScalar(b.ton);
      if (b.nadel) {
        c.offsetHSL(0.03, -0.05, -0.06);
        nadel.current!.setMatrixAt(n, dummy.matrix);
        nadel.current!.setColorAt(n++, c);
      } else {
        laub.current!.setMatrixAt(l, dummy.matrix);
        laub.current!.setColorAt(l++, c);
      }
    });
    for (const m of [nadel.current!, laub.current!, stamm.current!]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }, [daten]);

  const schatten = qualitaet === 'hoch';
  return (
    <group>
      <instancedMesh ref={nadel} args={[geo.nadel, undefined, Math.max(1, anzahlNadel)]} castShadow={schatten} receiveShadow>
        <meshLambertMaterial flatShading />
      </instancedMesh>
      <instancedMesh ref={laub} args={[geo.laub, undefined, Math.max(1, anzahlLaub)]} castShadow={schatten} receiveShadow>
        <meshLambertMaterial flatShading />
      </instancedMesh>
      <instancedMesh ref={stamm} args={[geo.stamm, undefined, Math.max(1, daten.length)]}>
        <meshLambertMaterial color={THEME.szene.baumStamm} />
      </instancedMesh>
    </group>
  );
}

function Bruecken({ welt }: { welt: Welt }) {
  const k = welt.netz.knoten;
  const bruecken = welt.netz.kanten.filter((e) => e.typ === 'bruecke');
  return (
    <group>
      {bruecken.map((e) => {
        const a = k[e.a];
        const b = k[e.b];
        const mx = ((a.x + b.x) / 2) * S;
        const mz = (-(a.y + b.y) / 2) * S;
        const laenge = e.laengeKm * S + 0.6;
        const winkel = Math.atan2(b.y - a.y, b.x - a.x);
        return (
          <group key={e.id} position={[mx, 0, mz]} rotation-y={winkel}>
            <mesh position={[0, 0.1, 0]} castShadow receiveShadow>
              <boxGeometry args={[laenge, 0.08, 1.35]} />
              <meshLambertMaterial color="#9aa0a8" />
            </mesh>
            {[-0.66, 0.66].map((z) => (
              <mesh key={z} position={[0, 0.24, z]} castShadow>
                <boxGeometry args={[laenge, 0.2, 0.06]} />
                <meshLambertMaterial color="#d9dbde" />
              </mesh>
            ))}
            {[-laenge / 4, 0, laenge / 4].map((x) => (
              <mesh key={x} position={[x, -0.2, 0]}>
                <boxGeometry args={[0.5, 0.6, 1.1]} />
                <meshLambertMaterial color="#8c9198" />
              </mesh>
            ))}
          </group>
        );
      })}
    </group>
  );
}
