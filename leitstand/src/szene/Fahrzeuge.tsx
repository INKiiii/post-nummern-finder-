import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { BoxGeometry, CylinderGeometry, Group } from 'three';
import { fmtUhr } from '../core/format';
import type { Prognose } from '../core/lagebild';
import type { Kontext } from '../core/modell';
import type { Tour } from '../core/types';
import { gleicheAuswahl, useAnsicht } from '../state/ansicht';
import { simUhr, useLeitstand } from '../state/store';
import { setzeAnker } from './beschriftung';
import { S } from './koord';
import { rampenPose } from './layout';
import { textTextur } from './textur';
import { Umriss, umrissDicke } from './Umriss';

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

/** Text des Labels über dem Fahrzeug, aus der Prognose des Lagebilds */
export function labelText(p: Prognose, zeit: number, besetzt: boolean): string {
  if (!besetzt) return 'unbesetzt';
  switch (p.phase) {
    case 'rampe':
      return p.naechster ? `ab ${fmtUhr(p.abfahrt)}` : 'bereit';
    case 'laedt':
      return 'lädt';
    case 'unterwegs': {
      const n = p.naechster;
      if (!n) return '';
      if (n.vorOrt) return `vor Ort · ${Math.max(1, Math.round(n.ende - zeit))} Min`;
      return `${Math.max(1, Math.round(n.ankunft - zeit))} Min`;
    }
    case 'zurueck':
      return 'zurück';
  }
}

export function Fahrzeuge({ ctx }: { ctx: Kontext }) {
  return (
    <group>
      {ctx.tag.touren.map((t) => (
        <Fahrzeug key={t.id} tour={t} ctx={ctx} />
      ))}
    </group>
  );
}

function Fahrzeug({ tour, ctx }: { tour: Tour; ctx: Kontext }) {
  const gruppe = useRef<Group>(null);
  const winkel = useRef<number | null>(null);
  const { auswahl, hover, waehlen, hovern, fliegen, folgenSetzen, kameraAbstand } = useAnsicht();
  const lage = useLeitstand((s) => s.lage);
  const rampe = rampenPose(ctx.welt, tour.rampe);
  const ich = { art: 'fahrzeug' as const, id: tour.id };
  const gewaehlt = gleicheAuswahl(auswahl, ich);
  const gehovert = gleicheAuswahl(hover, ich);
  const dachTextur = useMemo(() => textTextur(String(tour.nr), tour.farbe, '#ffffff', 192, 128), [tour.nr, tour.farbe]);
  const grau = !ctx.tag.start[tour.id].besetzt;
  const zoomRef = useRef(1);

  useFrame((_, dt) => {
    const g = gruppe.current;
    if (!g || !lage) return;
    const p = lage.pose(tour.id, simUhr.zeit);
    const abstand = useAnsicht.getState().kameraAbstand;
    // in der Übersicht größer zeichnen, damit Fahrzeuge sichtbar bleiben (an der Basis nur leicht)
    const zoom = Math.min(p.anRampe ? 1.4 : 9, Math.max(1, abstand / 45));
    zoomRef.current = zoom;
    let ziel: number;
    if (p.anRampe) {
      g.position.set(rampe.x, 0, rampe.z);
      ziel = rampe.rot;
    } else {
      g.position.set(p.x * S, 0, -p.y * S);
      ziel = p.richtung;
    }
    // sanft lenken statt an jeder Ecke springen
    if (winkel.current === null || p.anRampe) winkel.current = ziel;
    else {
      const d = Math.atan2(Math.sin(ziel - winkel.current), Math.cos(ziel - winkel.current));
      winkel.current += d * Math.min(1, dt * 8);
    }
    g.rotation.y = winkel.current;
    g.scale.setScalar(zoom);
    setzeAnker(`fz:${tour.id}`, g.position.x, 1.0 * zoom, g.position.z);
  });

  const umriss = gewaehlt || gehovert;
  const dicke = umrissDicke(kameraAbstand, gewaehlt ? 1.3 : 0.8) / zoomRef.current;
  return (
    <group
      ref={gruppe}
      position={[rampe.x, 0, rampe.z]}
      rotation-y={rampe.rot}
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
        const g = gruppe.current!;
        const faehrt = lage ? !lage.pose(tour.id, simUhr.zeit).anRampe : false;
        fliegen({ ziel: [g.position.x, 0.3, g.position.z], distanz: faehrt ? 70 : 14 });
        folgenSetzen(faehrt ? tour.id : null);
      }}
    >
      <mesh geometry={GEO.kasten} castShadow receiveShadow>
        <meshLambertMaterial color={grau ? '#c9ccd1' : '#f4f5f7'} />
      </mesh>
      {umriss && <Umriss geometrie={GEO.kasten} dicke={dicke} />}
      <mesh geometry={GEO.kabine} castShadow>
        <meshLambertMaterial color={grau ? '#c9ccd1' : '#f4f5f7'} />
      </mesh>
      {umriss && <Umriss geometrie={GEO.kabine} dicke={dicke} />}
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
