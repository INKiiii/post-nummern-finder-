import { useMemo } from 'react';
import { BoxGeometry, CylinderGeometry } from 'three';
import { fmtUhr } from '../core/format';
import type { Kontext, PlanAuswertung } from '../core/modell';
import { fahrzeugSicht, type FahrzeugSicht } from '../core/sicht';
import type { Plan, Tour } from '../core/types';
import { gleicheAuswahl, useAnsicht } from '../state/ansicht';
import { setzeAnker } from './beschriftung';
import { rampenPose } from './layout';
import { Umriss, umrissDicke } from './Umriss';
import { textTextur } from './textur';

/** Fahrzeugmaße in Szene-Einheiten (überhöht): Länge 1,2 · Breite 0,52 */
const GEO = {
  kasten: new BoxGeometry(0.84, 0.54, 0.52).translate(-0.17, 0.42, 0),
  kabine: new BoxGeometry(0.36, 0.4, 0.5).translate(0.43, 0.35, 0),
  haube: new BoxGeometry(0.12, 0.2, 0.48).translate(0.66, 0.25, 0),
  scheibe: new BoxGeometry(0.02, 0.17, 0.42).translate(0.612, 0.44, 0),
  seitenfenster: new BoxGeometry(0.2, 0.14, 0.505).translate(0.47, 0.45, 0),
  streifen: new BoxGeometry(0.85, 0.07, 0.525).translate(-0.17, 0.36, 0),
  dach: new BoxGeometry(0.8, 0.012, 0.48).translate(-0.17, 0.696, 0),
  rad: new CylinderGeometry(0.1, 0.1, 0.07, 10).rotateX(Math.PI / 2),
  licht: new BoxGeometry(0.02, 0.05, 0.08),
};
const RAEDER: Array<[number, number]> = [
  [0.45, 0.24],
  [0.45, -0.24],
  [-0.42, 0.24],
  [-0.42, -0.24],
];

export function labelText(s: FahrzeugSicht): string {
  switch (s.status) {
    case 'bereit':
      return s.abfahrt !== null ? `ab ${fmtUhr(s.abfahrt)}` : 'bereit';
    case 'beladen':
      return 'lädt';
    case 'unterwegs':
    case 'rueckfahrt':
      return s.naechster ? (s.naechster.vorOrt ? `${Math.round(s.naechster.ende - s.naechster.ankunft)} Min vor Ort` : `${Math.max(1, Math.round(s.naechster.restMin))} Min`) : '';
    case 'zurueck':
      return 'zurück';
    case 'unbesetzt':
      return 'unbesetzt';
    case 'defekt':
      return 'Defekt';
  }
}

export function Fahrzeuge({ ctx, plan, aus, zeit }: { ctx: Kontext; plan: Plan; aus: PlanAuswertung; zeit: number }) {
  return (
    <group>
      {ctx.tag.touren.map((t) => (
        <Fahrzeug key={t.id} tour={t} ctx={ctx} sicht={fahrzeugSicht(ctx, plan, aus, t.id, zeit)} />
      ))}
    </group>
  );
}

function Fahrzeug({ tour, ctx, sicht }: { tour: Tour; ctx: Kontext; sicht: FahrzeugSicht }) {
  const { auswahl, hover, waehlen, hovern, fliegen, kameraAbstand } = useAnsicht();
  const pose = rampenPose(ctx.welt, tour.rampe);
  const ich = { art: 'fahrzeug' as const, id: tour.id };
  const gewaehlt = gleicheAuswahl(auswahl, ich);
  const gehovert = gleicheAuswahl(hover, ich);
  const anBasis = sicht.status === 'bereit' || sicht.status === 'beladen' || sicht.status === 'zurueck' || sicht.status === 'unbesetzt';
  // in der Übersicht größer zeichnen, damit Fahrzeuge sichtbar bleiben (an der Basis nur leicht)
  const zoom = Math.min(anBasis ? 1.4 : 9, Math.max(1, kameraAbstand / 45));
  const dachTextur = useMemo(() => textTextur(String(tour.nr), tour.farbe, '#ffffff', 192, 128), [tour.nr, tour.farbe]);
  setzeAnker(`fz:${tour.id}`, pose.x, 1.0 * zoom, pose.z);
  const umriss = gewaehlt || gehovert;
  const grau = sicht.status === 'unbesetzt';

  return (
    <group
      position={[pose.x, 0, pose.z]}
      rotation-y={pose.rot}
      scale={zoom}
      onPointerOver={(e) => {
        e.stopPropagation();
        hovern(ich);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        hovern(null);
        document.body.style.cursor = '';
      }}
      onClick={(e) => {
        if (e.delta > 6) return;
        e.stopPropagation();
        waehlen(ich);
        fliegen({ ziel: [pose.x, 0.3, pose.z], distanz: 14 });
      }}
    >
      <mesh geometry={GEO.kasten} castShadow receiveShadow>
        <meshLambertMaterial color={grau ? '#c9ccd1' : '#f4f5f7'} />
      </mesh>
      {umriss && <Umriss geometrie={GEO.kasten} dicke={umrissDicke(kameraAbstand, gewaehlt ? 1.3 : 0.8) / zoom} />}
      <mesh geometry={GEO.kabine} castShadow>
        <meshLambertMaterial color={grau ? '#c9ccd1' : '#f4f5f7'} />
      </mesh>
      {umriss && <Umriss geometrie={GEO.kabine} dicke={umrissDicke(kameraAbstand, gewaehlt ? 1.3 : 0.8) / zoom} />}
      <mesh geometry={GEO.haube} castShadow>
        <meshLambertMaterial color="#e9ebee" />
      </mesh>
      <mesh geometry={GEO.scheibe}>
        <meshLambertMaterial color="#2b3440" />
      </mesh>
      <mesh geometry={GEO.seitenfenster}>
        <meshLambertMaterial color="#2b3440" />
      </mesh>
      <mesh geometry={GEO.streifen}>
        <meshLambertMaterial color={grau ? '#8a919b' : tour.farbe} />
      </mesh>
      <mesh geometry={GEO.dach}>
        <meshLambertMaterial map={dachTextur} />
      </mesh>
      {RAEDER.map(([x, z]) => (
        <mesh key={`${x}${z}`} geometry={GEO.rad} position={[x, 0.1, z]}>
          <meshLambertMaterial color="#262a30" />
        </mesh>
      ))}
      {[0.17, -0.17].map((z) => (
        <mesh key={z} geometry={GEO.licht} position={[0.725, 0.24, z]}>
          <meshBasicMaterial color="#fff6d8" />
        </mesh>
      ))}
    </group>
  );
}
