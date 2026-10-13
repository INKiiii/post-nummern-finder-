import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Color, InstancedMesh, Object3D, Sphere, Vector3 } from 'three';
import { G } from '../glossar';
import { behaelterFolge } from '../core/modell';
import type { Plan, Tag, Welt } from '../core/types';
import { gleicheAuswahl, useAnsicht } from '../state/ansicht';
import { simUhr, useLeitstand } from '../state/store';
import { BEHAELTER_MASS, behaelterGeometrie } from './geometrie';
import { setzeAnker } from './beschriftung';
import { hallenPlatz, rampenPose, rampenTuer, rollPosition } from './layout';
import { Umriss, umrissDicke } from './Umriss';

const dummy = new Object3D();
const BODEN = 0.12;
/** So lange (Sim-Minuten) rollt ein Behälter nach dem Verladescan von seinem Platz ins Fahrzeug */
export const ROLLEN_MIN = 1.5;


/**
 * Rollbehälter auf der Bereitstellfläche (Instancing), in Tourfarbe. Nach dem Verladescan
 * rollt ein Behälter durch die Rampentür ins Fahrzeug und verschwindet dann aus der Halle:
 * Er hat keinen eigenen Tracker, seine Position ist die des Fahrzeugs.
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
  /** zuletzt gesetzter Zustand je Instanz ('h' Halle, 'x' weg, 'r' rollt), damit nur Änderungen hochgeladen werden */
  const zustand = useRef<string[]>([]);

  const posen = useMemo(() => Object.fromEntries(ids.map((id) => [id, hallenPlatz(welt, tag, plan, id)])), [welt, tag, plan, ids]);

  // Farben und Hüllkugel (Halle samt Rampen), Matrizen setzt useFrame
  useLayoutEffect(() => {
    const m = ref.current!;
    const c = new Color();
    const punkte: Vector3[] = [];
    ids.forEach((id, i) => {
      const tour = tag.touren.find((t) => behaelterFolge(plan, t.id).includes(id));
      c.set(tour ? tour.farbe : '#8a919b');
      m.setColorAt(i, c);
      punkte.push(new Vector3(posen[id].x, BODEN, posen[id].z));
    });
    for (const r of welt.basis.rampen) {
      const p = rampenPose(welt, r.nr);
      punkte.push(new Vector3(p.x, BODEN, p.z));
    }
    m.instanceColor!.needsUpdate = true;
    m.boundingSphere = new Sphere().setFromPoints(punkte);
    m.boundingSphere.radius += 1;
    zustand.current = [];
  }, [ids, posen, tag, plan, welt]);

  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    const l = useLeitstand.getState().lage;
    const zeit = simUhr.zeit;
    let geaendert = false;
    ids.forEach((id, i) => {
      const b = l?.behaelter(id);
      const p = posen[id];
      let art = 'h';
      let x = p.x;
      let z = p.z;
      if (b && b.status !== 'halle') {
        const u = b.seit === null ? 1 : (zeit - b.seit) / ROLLEN_MIN;
        const tour = b.tourId ? tag.touren.find((t) => t.id === b.tourId) : undefined;
        if (u >= 1 || u < 0 || !tour) art = 'x';
        else {
          art = 'r';
          const q = rollPosition(p, rampenTuer(welt, tour.rampe), rampenPose(welt, tour.rampe), u);
          x = q.x;
          z = q.z;
        }
      }
      if (art !== 'r' && zustand.current[i] === art) return;
      zustand.current[i] = art;
      dummy.position.set(x, BODEN, z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.setScalar(art === 'x' ? 0 : 1);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      geaendert = true;
    });
    if (geaendert) m.instanceMatrix.needsUpdate = true;
  });

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
