import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Color, InstancedMesh, Object3D, Sphere, Vector3 } from 'three';
import { G } from '../glossar';
import { behaelterFolge } from '../core/modell';
import type { Plan, Tag, Welt } from '../core/types';
import { gleicheAuswahl, useAnsicht } from '../state/ansicht';
import { simUhr, useLeitstand } from '../state/store';
import { BEHAELTER_MASS, behaelterGeometrie } from './geometrie';
import { setzeAnker } from './beschriftung';
import { ANZEIGE_VERZOEGERUNG_MIN } from '../core/lagebild';
import { S } from './koord';
import { hallenPlatz, hallenWeg, rampenPose, rampenTuer, rollPosition, umladeWeg, wegPosition } from './layout';
import { Umriss, umrissDicke } from './Umriss';
import { tourMitBehaelter } from '../core/uebergabe';
import { ziehenVorbereiten } from './Ziehen';

const dummy = new Object3D();
const BODEN = 0.12;
/** So lange (Sim-Minuten) rollt ein Behälter nach dem Verladescan von seinem Platz ins Fahrzeug */
export const ROLLEN_MIN = 1.5;
/** Umladen an der Rampe bzw. am Treffpunkt (Sim-Minuten) */
const UMLADEN_MIN = 2;
/** Platzwechsel in der Halle nach einer Umplanung (echte Millisekunden) */
const UMZUG_MS = 1300;


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

  /** zuletzt gezeigte Position und Ziel je Behälter (für den Platzwechsel nach einer Umplanung) */
  const gezeigt = useRef(new Map<string, { x: number; z: number }>());
  const ziele = useRef(new Map<string, { x: number; z: number }>());
  const umzuege = useRef(new Map<string, { weg: Array<{ x: number; z: number }>; start: number }>());

  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    const l = useLeitstand.getState().lage;
    const zeit = simUhr.zeit;
    const jetzt = performance.now();
    let geaendert = false;
    ids.forEach((id, i) => {
      const b = l?.behaelter(id);
      const p = posen[id];
      let art = 'h';
      let x = p.x;
      let z = p.z;
      let y = BODEN;
      if (b && b.status !== 'halle') {
        art = 'x';
        const tour = b.tourId ? tag.touren.find((t) => t.id === b.tourId) : undefined;
        const um = b.umgeladen;
        const vonTour = um ? tag.touren.find((t) => t.fahrzeugId === um.vonFahrzeug) : undefined;
        const lagePose = (tid: string) => l!.pose(tid, zeit);
        if (um && vonTour && tour && l) {
          const pa = lagePose(vonTour.id);
          const pb = lagePose(tour.id);
          if (pa.anRampe && pb.anRampe) {
            // an der Rampe: durch die Halle in das andere Fahrzeug
            const u = (zeit - um.zeit) / UMLADEN_MIN;
            if (u >= 0 && u < 1) {
              art = 'r';
              ({ x, z } = wegPosition(umladeWeg(welt, vonTour.rampe, tour.rampe), u));
            }
          } else if (!pa.anRampe && !pb.anRampe) {
            // am Treffpunkt: im Bogen hinüber, passend zu den (eine Minute verzögert) gezeigten Fahrzeugen
            const u = (zeit - ANZEIGE_VERZOEGERUNG_MIN - (um.zeit - 0.6)) / UMLADEN_MIN;
            if (u >= 0 && u < 1) {
              art = 'r';
              x = (pa.x + (pb.x - pa.x) * u) * S;
              z = -(pa.y + (pb.y - pa.y) * u) * S;
              y = BODEN + 0.4 + Math.sin(Math.PI * u) * 1.4;
            }
          }
        }
        if (art === 'x' && b.seit !== null && tour) {
          const u = (zeit - b.seit) / ROLLEN_MIN;
          if (u >= 0 && u < 1 && !b.umgeladen) {
            art = 'r';
            ({ x, z } = rollPosition(p, rampenTuer(welt, tour.rampe), rampenPose(welt, tour.rampe), u));
          }
        }
      } else {
        // Halle: nach einer Umplanung über den Gang zum neuen Platz rollen
        const altZiel = ziele.current.get(id);
        if (altZiel && Math.hypot(altZiel.x - p.x, altZiel.z - p.z) > 0.01) {
          umzuege.current.set(id, { weg: hallenWeg(gezeigt.current.get(id) ?? altZiel, p), start: jetzt });
        }
        ziele.current.set(id, { x: p.x, z: p.z });
        const mz = umzuege.current.get(id);
        if (mz) {
          const u = (jetzt - mz.start) / UMZUG_MS;
          if (u >= 1) umzuege.current.delete(id);
          else {
            art = 'r';
            ({ x, z } = wegPosition(mz.weg, u));
          }
        }
        gezeigt.current.set(id, { x, z });
      }
      if (art !== 'r' && zustand.current[i] === art) return;
      zustand.current[i] = art;
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.setScalar(art === 'x' ? 0 : 1);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      geaendert = true;
    });
    if (geaendert) m.instanceMatrix.needsUpdate = true;
  });

  const steuerung = useThree((s) => s.controls) as unknown as { enabled: boolean } | null;
  // Laptop: Behälter aus der Halle auf ein Fahrzeug ziehen
  const onDown = (e: ThreeEvent<PointerEvent>) => {
    if (e.instanceId === undefined || e.pointerType !== 'mouse' || e.button !== 0) return;
    const id = ids[e.instanceId];
    const l = useLeitstand.getState();
    if (!l.lage || l.lage.behaelter(id).status !== 'halle' || !l.restplan || !tourMitBehaelter(l.restplan, id)) return;
    e.stopPropagation();
    const tour = tag.touren.find((t) => behaelterFolge(plan, t.id).includes(id));
    ziehenVorbereiten(id, e.nativeEvent.clientX, e.nativeEvent.clientY, steuerung, tour?.farbe ?? '#8a919b');
  };

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

  const ziehZiel = useAnsicht((s) => s.ziehen?.ziel ?? null);
  const markiert = [auswahl, hover, ziehZiel].filter((a) => a?.art === 'behaelter' && inHalle[a.id]) as Array<{ art: 'behaelter'; id: string }>;
  return (
    <group>
      <instancedMesh ref={ref} args={[geo, undefined, ids.length]} userData={{ behaelterIds: ids }} frustumCulled={false} castShadow receiveShadow onPointerDown={onDown} onPointerMove={onMove} onPointerOut={onOut} onClick={onClick}>
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
