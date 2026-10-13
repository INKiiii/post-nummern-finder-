import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { BoxGeometry, CylinderGeometry, Group } from 'three';
import { fmtUhr } from '../core/format';
import type { Prognose } from '../core/lagebild';
import type { Kontext } from '../core/modell';
import type { Tour } from '../core/types';
import { gleicheAuswahl, useAnsicht } from '../state/ansicht';
import { umplanenAuf } from '../ui/aktionen';
import { simUhr, useLeitstand } from '../state/store';
import { setzeAnker } from './beschriftung';
import { fahrzeugOrte } from './fahrzeugOrte';
import { S } from './koord';
import { abfahrtPose, ankunftPose, rampenPose } from './layout';
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
  /** Felgenstrich, damit man das Drehen sieht */
  felge: new BoxGeometry(0.15, 0.03, 0.074),
  licht: new BoxGeometry(0.02, 0.05, 0.08),
  blinker: new BoxGeometry(0.035, 0.045, 0.05),
};
const RAD_RADIUS = 0.1;
/** Warnblinker: vorn an den Ecken, hinten oben */
const BLINKER: Array<[number, number, number]> = [
  [0.722, 0.3, 0.215],
  [0.722, 0.3, -0.215],
  [-0.6, 0.62, 0.22],
  [-0.6, 0.62, -0.22],
];
/** Ab dieser Geschwindigkeit (Szene-Einheiten je Sim-Minute) gilt das Fahrzeug als fahrend */
const FAEHRT_AB = 4;
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
  const auswahl = useAnsicht((s) => s.auswahl);
  const hover = useAnsicht((s) => s.hover);
  const waehlen = useAnsicht((s) => s.waehlen);
  const hovern = useAnsicht((s) => s.hovern);
  const fliegen = useAnsicht((s) => s.fliegen);
  const folgenSetzen = useAnsicht((s) => s.folgenSetzen);
  const kameraAbstand = useAnsicht((s) => s.kameraAbstand);
  const lage = useLeitstand((s) => s.lage);
  const rampe = rampenPose(ctx.welt, tour.rampe);
  const ich = { art: 'fahrzeug' as const, id: tour.id };
  const gewaehlt = gleicheAuswahl(auswahl, ich);
  const ziehen = useAnsicht((s) => s.ziehen);
  const gehovert = gleicheAuswahl(hover, ich) || gleicheAuswahl(ziehen?.ziel ?? null, ich);
  const dachTextur = useMemo(() => textTextur(String(tour.nr), tour.farbe, '#ffffff', 192, 128), [tour.nr, tour.farbe]);
  const grau = !ctx.tag.start[tour.id].besetzt;
  const zoomRef = useRef(1);

  const raeder = useRef<Array<Group | null>>([]);
  const blinker = useRef<Group>(null);
  const lauf = useRef({ x: NaN, z: NaN, zeit: 0, bewegt: -Infinity, drehung: 0 });

  useFrame((_, dt) => {
    const g = gruppe.current;
    if (!g || !lage) return;
    const zeit = simUhr.zeit;
    const p = lage.pose(tour.id, zeit);
    const abstand = useAnsicht.getState().kameraAbstand;
    // in der Übersicht größer zeichnen, damit Fahrzeuge sichtbar bleiben (an der Basis nur leicht)
    let grenze = 9;
    let x: number;
    let z: number;
    let ziel: number;
    let sofort = false;
    if (p.anRampe) {
      x = rampe.x;
      z = rampe.z;
      ziel = rampe.rot;
      grenze = 1.4;
      sofort = true;
    } else if (p.uebergang) {
      // weich von der Rampe über den Hof bzw. zurück (rückwärts an die Rampe)
      const tor = { x: p.x * S, z: -p.y * S };
      const u = p.uebergang.anteil;
      const q = p.uebergang.art === 'abfahrt' ? abfahrtPose(rampe, tor, u) : ankunftPose(rampe, tor, u);
      x = q.x;
      z = q.z;
      ziel = q.rot;
      grenze = p.uebergang.art === 'abfahrt' ? 1.4 + 7.6 * u * u : 9 - 7.6 * Math.sqrt(u);
      sofort = true;
    } else {
      x = p.x * S;
      z = -p.y * S;
      ziel = p.richtung;
    }
    const zoom = Math.min(grenze, Math.max(1, abstand / 45));
    zoomRef.current = zoom;
    g.position.set(x, 0, z);
    const ort = fahrzeugOrte.get(tour.id);
    if (ort) {
      ort.x = x;
      ort.z = z;
    } else fahrzeugOrte.set(tour.id, { x, z });
    // sanft lenken statt an jeder Ecke springen
    if (winkel.current === null || sofort) winkel.current = ziel;
    else {
      const d = Math.atan2(Math.sin(ziel - winkel.current), Math.cos(ziel - winkel.current));
      winkel.current += d * Math.min(1, dt * 8);
    }
    g.rotation.y = winkel.current;
    g.scale.setScalar(zoom);
    setzeAnker(`fz:${tour.id}`, x, 1.0 * zoom, z);

    // Räder drehen sich mit der gefahrenen Strecke; Warnblinker beim Halt
    const l = lauf.current;
    const dx = x - l.x;
    const dz = z - l.z;
    const weg = Math.hypot(dx, dz);
    const dtSim = zeit - l.zeit;
    if (Number.isFinite(weg) && weg < 30) {
      const vorwaerts = dx * Math.cos(winkel.current) - dz * Math.sin(winkel.current) >= 0 ? 1 : -1;
      l.drehung += (vorwaerts * weg) / (RAD_RADIUS * zoom);
      for (const r of raeder.current) if (r) r.rotation.z = -l.drehung;
    }
    if (!Number.isFinite(weg) || weg >= 30 || (dtSim > 0 && weg / dtSim > FAEHRT_AB) || zeit < l.zeit) l.bewegt = zeit;
    l.x = x;
    l.z = z;
    l.zeit = zeit;
    const haelt = !p.anRampe && !p.uebergang && zeit - l.bewegt > 0.15;
    if (blinker.current) blinker.current.visible = haelt && performance.now() % 800 < 430;
    // vor Kamera (0) und Steuerung (−1): wer dem Fahrzeug folgt, sieht die Position dieses Bildes
  }, -2);

  const umriss = gewaehlt || gehovert;
  const dicke = umrissDicke(kameraAbstand, gewaehlt ? 1.3 : 0.8) / zoomRef.current;
  return (
    <group
      ref={gruppe}
      userData={{ tourId: tour.id }}
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
        // Handy: Ziel für einen Behälter wählen statt auswählen
        const zw = useAnsicht.getState().zielWahl;
        if (zw) {
          useAnsicht.getState().zielWahlSetzen(null);
          umplanenAuf(zw.behaelterId, tour.id);
          return;
        }
        waehlen(ich);
        const g = gruppe.current!;
        const faehrt = lage ? !lage.pose(tour.id, simUhr.zeit).anRampe : false;
        fliegen({ ziel: [g.position.x, 0.3, g.position.z], distanz: faehrt ? 70 : 18 });
        // die Kamera bleibt am Fahrzeug, auch wenn es erst noch an der Rampe steht
        folgenSetzen(tour.id);
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
      {RAEDER.map(([x, z], i) => (
        <group
          key={`${x}${z}`}
          position={[x, RAD_RADIUS, z]}
          ref={(r) => {
            raeder.current[i] = r;
          }}
        >
          <mesh geometry={GEO.rad}>
            <meshLambertMaterial color="#262a30" />
          </mesh>
          <mesh geometry={GEO.felge}>
            <meshLambertMaterial color="#b9bec6" />
          </mesh>
        </group>
      ))}
      {[0.17, -0.17].map((z) => (
        <mesh key={z} geometry={GEO.licht} position={[0.725, 0.24, z]}>
          <meshBasicMaterial color="#fff6d8" />
        </mesh>
      ))}
      {[0.19, -0.19].map((z) => (
        <mesh key={`r${z}`} geometry={GEO.licht} position={[-0.6, 0.24, z]}>
          <meshBasicMaterial color="#a8261d" />
        </mesh>
      ))}
      <group ref={blinker} visible={false}>
        {BLINKER.map(([x, y, z]) => (
          <mesh key={`${x}${z}`} geometry={GEO.blinker} position={[x, y, z]}>
            <meshBasicMaterial color="#ff9a1f" toneMapped={false} />
          </mesh>
        ))}
      </group>
    </group>
  );
}
