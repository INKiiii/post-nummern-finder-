import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Color, InstancedMesh, Object3D } from 'three';
import { behaelterFolge } from '../core/modell';
import { zufall } from '../core/rng';
import { ANZEIGE_VERZOEGERUNG_MIN, zustellungenIm } from '../core/lagebild';
import type { Plan, Tag, Welt } from '../core/types';
import { useAnsicht } from '../state/ansicht';
import { simUhr, useLeitstand } from '../state/store';
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
/** So lange (Sim-Minuten) leuchtet ein Haus nach dem Zustellscan nach */
export const LEUCHT_MIN = 2.5;
const GELB = new Color(THEME.szene.leuchten);
const ORANGE = new Color(THEME.szene.leuchtenNicht);


/** Alle Häuser als zwei Instanced Meshes (Körper und Dach) */
export function Haeuser({ welt, tag, plan }: { welt: Welt; tag: Tag; plan: Plan }) {
  const koerper = useRef<InstancedMesh>(null);
  const daecher = useRef<InstancedMesh>(null);
  const [hoverHaus, setHoverHaus] = useState<number | null>(null);
  // nur die Teile der Ansicht, die die Häuser brauchen (sonst zeichnet jede Mausbewegung alles neu)
  const qualitaet = useAnsicht((s) => s.qualitaet);
  const tourDaecher = useAnsicht((s) => s.tourDaecher);
  const auswahl = useAnsicht((s) => s.auswahl);
  const waehlen = useAnsicht((s) => s.waehlen);
  const hovern = useAnsicht((s) => s.hovern);
  const fliegen = useAnsicht((s) => s.fliegen);
  const tippSetzen = useAnsicht((s) => s.tippSetzen);
  const kameraAbstand = useAnsicht((s) => s.kameraAbstand);
  const geo = useMemo(() => ({ koerper: hausGeometrie(), dach: dachGeometrie() }), []);
  /** Grundfarben (ohne Leuchten) und gerade leuchtende Häuser */
  const grund = useRef<{ koerper: Color[]; dach: Color[] }>({ koerper: [], dach: [] });
  const leuchtend = useRef(new Map<number, number>());
  const hausVonStopp = useMemo(() => {
    const m = new Map<number, number[]>();
    welt.haeuser.forEach((h, i) => {
      const l = m.get(h.stoppId);
      if (l) l.push(i);
      else m.set(h.stoppId, [i]);
    });
    return m;
  }, [welt]);

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

  // Farben: Dächer in Tourfarbe (in der Vorschau schon nach dem neuen Plan), ausgewählte Bezirke hervorgehoben
  const vorschau = useLeitstand((s) => s.vorschau);
  const farbPlan = vorschau?.tagesplan ?? plan;
  const tourJeBezirk = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tag.touren) for (const b of behaelterFolge(farbPlan, t.id)) m.set(tag.behaelter[b].zielbezirk, t.farbe);
    return m;
  }, [tag, farbPlan]);
  const aktiv = useMemo(() => {
    if (vorschau && vorschau.aenderungen.length) return new Set(vorschau.aenderungen.map((a) => tag.behaelter[a.behaelterId].zielbezirk));
    return aktiveBezirke(auswahl, tag, plan);
  }, [auswahl, tag, plan, vorschau]);

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
      grund.current.koerper[i] = c.clone();
      c.copy(f.ziegel);
      const tf = tourJeBezirk.get(bezirk);
      if (tourDaecher) c.lerp(tf ? new Color(tf) : grau, 0.78);
      if (!imFokus) c.lerp(grau, 0.45);
      daecher.current!.setColorAt(i, c);
      grund.current.dach[i] = c.clone();
    });
    koerper.current!.instanceColor!.needsUpdate = true;
    daecher.current!.instanceColor!.needsUpdate = true;
    leuchtend.current = new Map();
  }, [welt, formen, tourJeBezirk, tourDaecher, aktiv]);

  // Häuser leuchten kurz auf, wenn dort ein Paket zugestellt wurde (aus den Zustellscans),
  // zeitgleich mit dem angezeigten Fahrzeug (das eine Minute hinter den Meldungen fährt)
  useFrame(() => {
    const lage = useLeitstand.getState().lage;
    const k = koerper.current;
    const d = daecher.current;
    if (!k || !d || grund.current.koerper.length === 0) return;
    const bis = simUhr.zeit - ANZEIGE_VERZOEGERUNG_MIN;
    const neu = new Map<number, number>();
    const farbe = new Map<number, Color>();
    if (lage) {
      for (const z of zustellungenIm(lage.zustellungen, bis - LEUCHT_MIN, bis)) {
        const staerke = 1 - (bis - z.t) / LEUCHT_MIN;
        for (const i of hausVonStopp.get(z.stoppId) ?? []) {
          if ((neu.get(i) ?? 0) >= staerke) continue;
          neu.set(i, staerke);
          farbe.set(i, z.ok ? GELB : ORANGE);
        }
      }
    }
    const alt = leuchtend.current;
    if (neu.size === 0 && alt.size === 0) return;
    const c = new Color();
    for (const i of alt.keys()) {
      if (neu.has(i)) continue;
      k.setColorAt(i, grund.current.koerper[i]);
      d.setColorAt(i, grund.current.dach[i]);
    }
    for (const [i, st] of neu) {
      const e = Math.min(1, st * 1.4);
      k.setColorAt(i, c.copy(grund.current.koerper[i]).lerp(farbe.get(i)!, 0.85 * e));
      d.setColorAt(i, c.copy(grund.current.dach[i]).lerp(farbe.get(i)!, 0.6 * e));
    }
    leuchtend.current = neu;
    k.instanceColor!.needsUpdate = true;
    d.instanceColor!.needsUpdate = true;
  });

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
