import type { ThreeEvent } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Color, InstancedMesh, Object3D } from 'three';
import { behaelterFolge } from '../core/modell';
import { zufall } from '../core/rng';
import type { Plan, Tag, Welt } from '../core/types';
import { useAnsicht } from '../state/ansicht';
import { THEME } from '../theme';
import { aktiveBezirke, bezirkMitte } from './auswahl';
import { setzeAnker } from './beschriftung';
import { dachGeometrie, hausGeometrie } from './geometrie';
import { S } from './koord';
import { EINHEITSWUERFEL, Umriss, umrissDicke } from './Umriss';

interface HausForm {
  w: number;
  h: number;
  d: number;
  dach: number;
  wand: Color;
  ziegel: Color;
}

const FORMEN = [
  { w: 1.25, h: 0.85, d: 1.0, dach: 0.62 },
  { w: 1.9, h: 0.9, d: 1.05, dach: 0.62 },
  { w: 1.7, h: 1.7, d: 1.35, dach: 0.4 },
];

const dummy = new Object3D();

/** Alle Häuser als zwei Instanced Meshes (Körper und Dach) */
export function Haeuser({ welt, tag, plan }: { welt: Welt; tag: Tag; plan: Plan }) {
  const koerper = useRef<InstancedMesh>(null);
  const daecher = useRef<InstancedMesh>(null);
  const [hoverHaus, setHoverHaus] = useState<number | null>(null);
  const { qualitaet, tourDaecher, auswahl, waehlen, hovern, fliegen, tippSetzen, kameraAbstand } = useAnsicht();
  const geo = useMemo(() => ({ koerper: hausGeometrie(), dach: dachGeometrie() }), []);

  const formen = useMemo<HausForm[]>(() => {
    const rng = zufall(welt.seed + 21);
    return welt.haeuser.map((h) => {
      const f = FORMEN[h.art];
      const v = rng.zwischen(0.92, 1.08);
      return {
        w: f.w * v,
        h: f.h * rng.zwischen(0.92, 1.1),
        d: f.d * v,
        dach: f.dach * rng.zwischen(0.9, 1.1),
        wand: new Color(rng.wahl(THEME.szene.haus)),
        ziegel: new Color(rng.wahl(THEME.szene.dach)),
      };
    });
  }, [welt]);

  // Lage der Häuser
  useLayoutEffect(() => {
    welt.haeuser.forEach((h, i) => {
      const f = formen[i];
      dummy.position.set(h.x * S, 0, -h.y * S);
      dummy.rotation.set(0, h.rot, 0);
      dummy.scale.set(f.w, f.h, f.d);
      dummy.updateMatrix();
      koerper.current!.setMatrixAt(i, dummy.matrix);
      dummy.position.y = f.h;
      dummy.scale.set(f.w * 1.08, f.dach, f.d * 1.12);
      dummy.updateMatrix();
      daecher.current!.setMatrixAt(i, dummy.matrix);
    });
    for (const m of [koerper.current!, daecher.current!]) {
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }, [welt, formen]);

  // Farben: Dächer in Tourfarbe, ausgewählte Bezirke hervorgehoben
  const tourJeBezirk = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tag.touren) for (const b of behaelterFolge(plan, t.id)) m.set(tag.behaelter[b].zielbezirk, t.farbe);
    return m;
  }, [tag, plan]);
  const aktiv = useMemo(() => aktiveBezirke(auswahl, tag, plan), [auswahl, tag, plan]);

  useLayoutEffect(() => {
    const c = new Color();
    const hell = new Color('#fffaf0');
    const grau = new Color('#9a9ea6');
    welt.haeuser.forEach((h, i) => {
      const f = formen[i];
      const bezirk = welt.stopps[h.stoppId].bezirkId;
      const imFokus = aktiv === null || aktiv.has(bezirk);
      c.copy(f.wand);
      if (aktiv && imFokus) c.lerp(hell, 0.6);
      if (!imFokus) c.multiplyScalar(0.86);
      koerper.current!.setColorAt(i, c);
      c.copy(f.ziegel);
      const tf = tourJeBezirk.get(bezirk);
      if (tourDaecher) c.lerp(tf ? new Color(tf) : grau, 0.78);
      if (!imFokus) c.lerp(grau, 0.45);
      daecher.current!.setColorAt(i, c);
    });
    koerper.current!.instanceColor!.needsUpdate = true;
    daecher.current!.instanceColor!.needsUpdate = true;
  }, [welt, formen, tourJeBezirk, tourDaecher, aktiv]);

  const bezirkVon = (i: number) => welt.stopps[welt.haeuser[i].stoppId].bezirkId;

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    if (e.instanceId === undefined) return;
    e.stopPropagation();
    if (hoverHaus !== e.instanceId) setHoverHaus(e.instanceId);
    const h = welt.haeuser[e.instanceId];
    const f = formen[e.instanceId];
    setzeAnker('tipp', h.x * S, f.h + f.dach + 0.3, -h.y * S);
    tippSetzen(welt.bezirke[bezirkVon(e.instanceId)].name);
    hovern({ art: 'bezirk', id: bezirkVon(e.instanceId) });
    document.body.style.cursor = 'pointer';
  };
  const onOut = () => {
    setHoverHaus(null);
    hovern(null);
    tippSetzen(null);
    document.body.style.cursor = '';
  };
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.instanceId === undefined || e.delta > 6) return;
    e.stopPropagation();
    const id = bezirkVon(e.instanceId);
    waehlen({ art: 'bezirk', id });
    const m = bezirkMitte(welt, id);
    fliegen({ ziel: [m.x, 0, m.z], distanz: 55 });
  };

  const schatten = qualitaet === 'hoch';
  const h = hoverHaus !== null ? welt.haeuser[hoverHaus] : null;
  const hf = hoverHaus !== null ? formen[hoverHaus] : null;
  return (
    <group>
      <instancedMesh
        ref={koerper}
        args={[geo.koerper, undefined, welt.haeuser.length]}
        castShadow={schatten}
        receiveShadow
        onPointerMove={onMove}
        onPointerOut={onOut}
        onClick={onClick}
      >
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={daecher} args={[geo.dach, undefined, welt.haeuser.length]} castShadow={schatten} onPointerMove={onMove} onPointerOut={onOut} onClick={onClick}>
        <meshLambertMaterial flatShading />
      </instancedMesh>
      {h && hf && (
        <group position={[h.x * S, 0, -h.y * S]} rotation-y={h.rot}>
          <group scale={[hf.w, hf.h + hf.dach, hf.d]}>
            <Umriss geometrie={EINHEITSWUERFEL} dicke={umrissDicke(kameraAbstand, 0.8) / Math.min(hf.w, hf.d)} />
          </group>
        </group>
      )}
    </group>
  );
}
