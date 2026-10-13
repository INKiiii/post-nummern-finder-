import type { ThreeEvent } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Color, InstancedMesh, Object3D } from 'three';
import { G } from '../glossar';
import { behaelterFolge } from '../core/modell';
import type { Plan, Tag, Welt } from '../core/types';
import { gleicheAuswahl, useAnsicht } from '../state/ansicht';
import { useLeitstand } from '../state/store';
import { BEHAELTER_MASS, behaelterGeometrie } from './geometrie';
import { setzeAnker } from './beschriftung';
import { hallenPlatz } from './layout';
import { Umriss, umrissDicke } from './Umriss';

const dummy = new Object3D();
const BODEN = 0.12;

/**
 * Rollbehälter auf der Bereitstellfläche (Instancing), in Tourfarbe. Sobald das Lagebild
 * einen Behälter im Fahrzeug sieht, verschwindet er aus der Halle: Er hat keinen eigenen
 * Tracker, seine Position ist die des Fahrzeugs.
 */
export function Behaelter3D({ welt, tag, plan }: { welt: Welt; tag: Tag; plan: Plan }) {
  const lage = useLeitstand((s) => s.lage);
  const lageVersion = useLeitstand((s) => s.lageVersion);
  const inHalle = useMemo(() => {
    void lageVersion;
    return Object.fromEntries(tag.behaelterIds.map((id) => [id, !lage || lage.behaelter(id).status === 'halle']));
  }, [lage, lageVersion, tag]);
  const ref = useRef<InstancedMesh>(null);
  const geo = useMemo(() => behaelterGeometrie(), []);
  const { auswahl, hover, waehlen, hovern, fliegen, tippSetzen, kameraAbstand } = useAnsicht();
  const ids = tag.behaelterIds;

  const posen = useMemo(() => Object.fromEntries(ids.map((id) => [id, hallenPlatz(welt, tag, plan, id)])), [welt, tag, plan, ids]);

  useLayoutEffect(() => {
    const m = ref.current!;
    const c = new Color();
    ids.forEach((id, i) => {
      const p = posen[id];
      const sichtbar = inHalle[id];
      dummy.position.set(p.x, BODEN, p.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.setScalar(sichtbar ? 1 : 0);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      const tour = tag.touren.find((t) => behaelterFolge(plan, t.id).includes(id));
      c.set(tour ? tour.farbe : '#8a919b');
      m.setColorAt(i, c);
    });
    m.instanceMatrix.needsUpdate = true;
    m.instanceColor!.needsUpdate = true;
    m.computeBoundingSphere();
  }, [ids, posen, inHalle, tag, plan]);

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    if (e.instanceId === undefined) return;
    e.stopPropagation();
    const id = ids[e.instanceId];
    const p = posen[id];
    setzeAnker('tipp', p.x, BODEN + BEHAELTER_MASS.hoehe + 0.12, p.z);
    tippSetzen(`${G.behaelter} ${id}`);
    hovern({ art: 'behaelter', id });
    document.body.style.cursor = 'pointer';
  };
  const onOut = () => {
    hovern(null);
    tippSetzen(null);
    document.body.style.cursor = '';
  };
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.instanceId === undefined || e.delta > 6) return;
    e.stopPropagation();
    const id = ids[e.instanceId];
    waehlen({ art: 'behaelter', id });
    const p = posen[id];
    fliegen({ ziel: [p.x, 0.3, p.z], distanz: 9 });
  };

  const markiert = [auswahl, hover].filter((a) => a?.art === 'behaelter' && inHalle[a.id]) as Array<{ art: 'behaelter'; id: string }>;
  return (
    <group>
      <instancedMesh ref={ref} args={[geo, undefined, ids.length]} castShadow receiveShadow onPointerMove={onMove} onPointerOut={onOut} onClick={onClick}>
        <meshLambertMaterial vertexColors />
      </instancedMesh>
      {markiert.map((a) => {
        const p = posen[a.id];
        const gewaehlt = gleicheAuswahl(a, auswahl);
        return (
          <group key={`${a.id}-${gewaehlt}`} position={[p.x, BODEN, p.z]}>
            <Umriss geometrie={geo} dicke={umrissDicke(kameraAbstand, gewaehlt ? 0.9 : 0.6)} farbe={gewaehlt ? '#ffffff' : '#e8eefc'} />
          </group>
        );
      })}
    </group>
  );
}
