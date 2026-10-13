import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { InterleavedBufferAttribute } from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Kontext } from '../core/modell';
import { suchIndex, type Route } from '../core/route';
import type { Tour } from '../core/types';
import { useAnsicht } from '../state/ansicht';
import { simUhr, useLeitstand } from '../state/store';
import { tourDerAuswahl } from './auswahl';
import { S } from './koord';

const HOEHE_REST = 0.3;
const HOEHE_SPUR = 0.36;

/**
 * Spuren der Touren aus dem Lagebild: die schon gefahrene Strecke durchgezogen in Tourfarbe,
 * der Rest der Route gestrichelt. Die ausgewählte Tour wird betont, die anderen treten zurück.
 */
export function Spuren({ ctx }: { ctx: Kontext }) {
  return (
    <group>
      {ctx.tag.touren.map((t) => (
        <Spur key={t.id} tour={t} ctx={ctx} />
      ))}
    </group>
  );
}

function linie(route: Route, hoehe: number): LineGeometry {
  const g = new LineGeometry();
  const pos = new Float32Array(route.punkte.length * 3);
  route.punkte.forEach((p, i) => {
    pos[i * 3] = p.x * S;
    pos[i * 3 + 1] = hoehe;
    pos[i * 3 + 2] = -p.y * S;
  });
  g.setPositions(pos);
  return g;
}

function Spur({ tour, ctx }: { tour: Tour; ctx: Kontext }) {
  const obj = useMemo(() => {
    const rest = new Line2(
      new LineGeometry(),
      new LineMaterial({ color: tour.farbe, linewidth: 2, dashed: true, dashSize: 1, gapSize: 0.7, transparent: true, opacity: 0.7, depthWrite: false }),
    );
    const spur = new Line2(new LineGeometry(), new LineMaterial({ color: tour.farbe, linewidth: 3.5, transparent: true, opacity: 1 }));
    // erst die Spur (schreibt Tiefe), dann der gestrichelte Rest, der unter der Spur verschwindet
    spur.renderOrder = 1;
    rest.renderOrder = 2;
    rest.visible = false;
    spur.visible = false;
    return { rest, spur };
  }, [tour.farbe]);

  /** Original des gerade gekürzten Segments, um es wiederherzustellen */
  const z = useRef<{ route: Route | null; seg: number; orig: number[] }>({ route: null, seg: -1, orig: [] });

  useEffect(
    () => () => {
      for (const l of [obj.rest, obj.spur]) {
        l.geometry.dispose();
        l.material.dispose();
      }
    },
    [obj],
  );

  useFrame(() => {
    const lage = useLeitstand.getState().lage;
    const plan = useLeitstand.getState().plan;
    const { auswahl, kameraAbstand } = useAnsicht.getState();
    const { rest, spur } = obj;
    if (!lage || !plan) {
      rest.visible = spur.visible = false;
      return;
    }
    const f = lage.fahrzeug(tour.id);
    const route = f.route;
    const gewaehlteTour = tourDerAuswahl(auswahl, ctx.tag, plan);
    const gewaehlt = gewaehlteTour === tour.id;
    const zurueckGestellt = gewaehlteTour !== null && !gewaehlt;
    const vorAbfahrt = f.phase === 'rampe' || f.phase === 'laedt';
    // vor der Abfahrt nur die geplante Route der ausgewählten Tour, nach der Rückkehr nur die Spur der ausgewählten
    const zeigeRest = route.punkte.length > 1 && ctx.tag.start[tour.id].besetzt && (f.phase === 'unterwegs' || (vorAbfahrt && gewaehlt));
    const zeigeSpur = route.punkte.length > 1 && (f.phase === 'unterwegs' || (f.phase === 'zurueck' && gewaehlt));
    rest.visible = zeigeRest;
    spur.visible = zeigeSpur;
    if (!zeigeRest && !zeigeSpur) return;

    const zz = z.current;
    if (zz.route !== route) {
      // neue Route (Beladung, Umplanung): Geometrien neu
      rest.geometry.dispose();
      spur.geometry.dispose();
      rest.geometry = linie(route, HOEHE_REST);
      rest.computeLineDistances();
      spur.geometry = linie(route, HOEHE_SPUR);
      zz.route = route;
      zz.seg = -1;
    }

    // gefahrene Strecke: Segmente bis zur aktuellen Stelle, das letzte bis genau dorthin gekürzt
    const s = vorAbfahrt ? 0 : lage.anzeigeS(tour.id, simUhr.zeit);
    const n = route.punkte.length - 1;
    const seg = Math.min(suchIndex(route.s, s), n - 1);
    const attr = spur.geometry.getAttribute('instanceEnd') as InterleavedBufferAttribute;
    const puffer = attr.data;
    const arr = puffer.array as Float32Array;
    if (seg !== zz.seg) {
      if (zz.seg >= 0) arr.set(zz.orig, zz.seg * 6 + 3);
      zz.orig = Array.from(arr.subarray(seg * 6 + 3, seg * 6 + 6));
      if (zz.seg >= 0) puffer.addUpdateRange(zz.seg * 6 + 3, 3);
      zz.seg = seg;
    }
    const a = route.punkte[seg];
    const b = route.punkte[seg + 1];
    const l = route.s[seg + 1] - route.s[seg];
    const u = l > 0 ? Math.max(0, Math.min(1, (s - route.s[seg]) / l)) : 1;
    arr[seg * 6 + 3] = (a.x + (b.x - a.x) * u) * S;
    arr[seg * 6 + 4] = HOEHE_SPUR;
    arr[seg * 6 + 5] = -(a.y + (b.y - a.y) * u) * S;
    puffer.addUpdateRange(seg * 6 + 3, 3);
    puffer.needsUpdate = true;
    spur.geometry.instanceCount = s <= 0 ? 0 : seg + 1;

    // Darstellung je nach Auswahl und Zoom
    const strich = Math.max(0.8, kameraAbstand / 70);
    rest.material.dashSize = strich;
    rest.material.gapSize = strich * 0.7;
    rest.material.linewidth = gewaehlt ? 3 : 1.8;
    rest.material.opacity = zurueckGestellt ? 0.25 : gewaehlt ? 0.95 : 0.65;
    spur.material.linewidth = gewaehlt ? 5 : 3.5;
    spur.material.opacity = zurueckGestellt ? 0.35 : 1;
  });

  return (
    <group>
      <primitive object={obj.spur} />
      <primitive object={obj.rest} />
    </group>
  );
}
