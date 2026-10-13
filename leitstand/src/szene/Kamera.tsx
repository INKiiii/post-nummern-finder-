import { MapControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { MathUtils, PerspectiveCamera, Spherical, Vector3 } from 'three';
import type { MapControls as MapControlsImpl } from 'three-stdlib';
import { useAnsicht } from '../state/ansicht';
import { simUhr, useLeitstand } from '../state/store';
import { fahrzeugOrte } from './fahrzeugOrte';
import { S } from './koord';

export const POLAR_3D = 0.95;
const POLAR_OBEN = 0.0001;
const MAX_POLAR = 1.28;

interface Animation {
  vonZiel: Vector3;
  nachZiel: Vector3;
  vonR: number;
  nachR: number;
  vonPhi: number;
  nachPhi: number;
  vonTheta: number;
  nachTheta: number;
  start: number;
  dauer: number;
}

const kugel = new Spherical();
const versatz = new Vector3();

function weich(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Kamerasteuerung: Verschieben, Drehen, Zoomen (auch per Touch) und sanfte Flüge */
export function Kamera({ startZiel }: { startZiel: [number, number, number] }) {
  const ref = useRef<MapControlsImpl>(null);
  const anim = useRef<Animation | null>(null);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const flug = useAnsicht((s) => s.flug);
  const draufsicht = useAnsicht((s) => s.draufsicht);
  const zoom = useAnsicht((s) => s.zoom);
  const welt = useLeitstand((s) => s.welt);
  const folgeVorher = useRef<{ x: number; z: number } | null>(null);
  /** Abstand Blickziel – verfolgtes Fahrzeug zu Beginn einer Bedienung */
  const folgeAbstand = useRef<{ x: number; z: number } | null>(null);
  /** läuft gerade eine Bedienung (Ziehen, Zoomen, Drehen)? */
  const bedienung = useRef(false);

  /** Position des verfolgten Fahrzeugs, so wie es gezeichnet wird (auch an der Rampe) */
  const folgePunkt = (): { x: number; z: number } | null => {
    const folgen = useAnsicht.getState().folgen;
    if (!folgen) return null;
    const ort = fahrzeugOrte.get(folgen);
    if (ort) return ort;
    const lage = useLeitstand.getState().lage;
    if (!lage) return null;
    const p = lage.pose(folgen, simUhr.zeit);
    return p.anRampe ? null : { x: p.x * S, z: -p.y * S };
  };

  const starte = (ziel: Vector3, r: number, phi: number, theta: number, dauer = 1.3) => {
    const c = ref.current;
    if (!c) return;
    versatz.copy(camera.position).sub(c.target);
    kugel.setFromVector3(versatz);
    // kürzester Weg beim Drehen
    let dTheta = theta - kugel.theta;
    dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
    c.maxPolarAngle = Math.max(MAX_POLAR, phi);
    c.minPolarAngle = 0;
    anim.current = {
      vonZiel: c.target.clone(),
      nachZiel: ziel.clone(),
      vonR: kugel.radius,
      nachR: r,
      vonPhi: kugel.phi,
      nachPhi: phi,
      vonTheta: kugel.theta,
      nachTheta: kugel.theta + dTheta,
      start: performance.now(),
      dauer: dauer * 1000,
    };
  };

  useEffect(() => {
    if (!flug || !ref.current) return;
    versatz.copy(camera.position).sub(ref.current.target);
    kugel.setFromVector3(versatz);
    const oben = useAnsicht.getState().draufsicht;
    const r = flug.distanz ?? kugel.radius;
    const phi = oben ? POLAR_OBEN : (flug.polar ?? Math.max(0.5, Math.min(kugel.phi, 1.15)));
    const theta = oben ? 0 : (flug.azimut ?? kugel.theta);
    const ziel = flug.versatz === false ? new Vector3(...flug.ziel) : versatzFuerBlatt(new Vector3(...flug.ziel), r, phi, theta);
    starte(ziel, r, phi, theta);
  }, [flug?.nr]);

  // Zoom-Knöpfe (Handy): Abstand ändern, Blickziel und Richtung bleiben
  useEffect(() => {
    const c = ref.current;
    if (!zoom || !c) return;
    versatz.copy(camera.position).sub(c.target);
    kugel.setFromVector3(versatz);
    const r = MathUtils.clamp(kugel.radius * zoom.faktor, c.minDistance, c.maxDistance);
    starte(c.target, r, kugel.phi, kugel.theta, 0.35);
  }, [zoom?.nr]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    versatz.copy(camera.position).sub(c.target);
    kugel.setFromVector3(versatz);
    if (draufsicht) starte(c.target, kugel.radius, POLAR_OBEN, 0, 0.9);
    else starte(c.target, kugel.radius, POLAR_3D, kugel.theta, 0.9);
  }, [draufsicht]);

  useFrame(() => {
    const c = ref.current;
    if (!c) return;
    // ausgewähltem Fahrzeug folgen (gezeichnete Position, auch an der Rampe)
    const folgen = useAnsicht.getState().folgen;
    if (folgen) {
      const p = folgePunkt();
      if (p) {
        const x = p.x;
        const z = p.z;
        if (anim.current) {
          // Flug: am Ende so stehen, dass das Fahrzeug im sichtbaren Teil des Bildes ist
          const a = anim.current;
          const v = blattVersatz(a.nachR, a.nachPhi, a.nachTheta);
          a.nachZiel.set(x + v.x, a.nachZiel.y, z + v.z);
        } else if (!bedienung.current) {
          // ruhig: Blickziel am Fahrzeug halten (auch nach dem Zoomen per Knopf richtig versetzt)
          versatz.copy(camera.position).sub(c.target);
          kugel.setFromVector3(versatz);
          const v = blattVersatz(kugel.radius, kugel.phi, kugel.theta);
          const dx = x + v.x - c.target.x;
          const dz = z + v.z - c.target.z;
          c.target.x += dx;
          c.target.z += dz;
          camera.position.x += dx;
          camera.position.z += dz;
        } else if (folgeVorher.current) {
          const dx = x - folgeVorher.current.x;
          const dz = z - folgeVorher.current.z;
          c.target.x += dx;
          c.target.z += dz;
          camera.position.x += dx;
          camera.position.z += dz;
        }
        folgeVorher.current = { x, z };
      } else folgeVorher.current = null;
    } else folgeVorher.current = null;
    // beim Verfolgen zum Blickziel hin zoomen, damit das Fahrzeug im Bild bleibt
    if (c.zoomToCursor === Boolean(folgen)) c.zoomToCursor = !folgen;
    const a = anim.current;
    if (a) {
      const t = Math.min(1, (performance.now() - a.start) / a.dauer);
      const e = weich(t);
      c.target.lerpVectors(a.vonZiel, a.nachZiel, e);
      // Zoom logarithmisch, wirkt gleichmäßiger
      const r = Math.exp(MathUtils.lerp(Math.log(a.vonR), Math.log(a.nachR), e));
      kugel.set(r, MathUtils.lerp(a.vonPhi, a.nachPhi, e), MathUtils.lerp(a.vonTheta, a.nachTheta, e));
      camera.position.setFromSpherical(kugel).add(c.target);
      camera.lookAt(c.target);
      if (t >= 1) {
        anim.current = null;
        const oben = useAnsicht.getState().draufsicht;
        c.minPolarAngle = 0;
        c.maxPolarAngle = oben ? POLAR_OBEN : MAX_POLAR;
        c.enableRotate = !oben;
      }
      c.update();
    }
    // Ziel innerhalb der Karte halten
    if (welt) {
      const tx = MathUtils.clamp(c.target.x, -100, welt.breiteKm * S + 100);
      const tz = MathUtils.clamp(c.target.z, -welt.hoeheKm * S - 100, 100);
      if (tx !== c.target.x || tz !== c.target.z) {
        const dx = tx - c.target.x;
        const dz = tz - c.target.z;
        c.target.x = tx;
        c.target.z = tz;
        camera.position.x += dx;
        camera.position.z += dz;
      }
    }
    // Clipping-Ebenen an den Abstand anpassen (Genauigkeit des Tiefenpuffers)
    const d = camera.position.distanceTo(c.target);
    const near = MathUtils.clamp(d * 0.015, 0.03, 25);
    const far = d * 8 + 3000;
    if (Math.abs(near - camera.near) / camera.near > 0.1 || Math.abs(far - camera.far) / camera.far > 0.1) {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }
    useAnsicht.getState().kameraAbstandSetzen(d);
  });

  return (
    <MapControls
      ref={ref}
      makeDefault
      target={startZiel}
      enableDamping
      dampingFactor={0.12}
      minDistance={2.5}
      maxDistance={2600}
      maxPolarAngle={MAX_POLAR}
      zoomToCursor
      screenSpacePanning={false}
      onStart={() => {
        anim.current = null;
        bedienung.current = true;
        // Zoomen und Drehen behalten die Verfolgung bei; ob verschoben wurde, zeigt sich am Ende
        const c = ref.current;
        const p = folgePunkt();
        folgeAbstand.current = p && c ? { x: c.target.x - p.x, z: c.target.z - p.z } : null;
        const oben = useAnsicht.getState().draufsicht;
        if (c) {
          c.maxPolarAngle = oben ? POLAR_OBEN : MAX_POLAR;
          c.enableRotate = !oben;
        }
      }}
      onEnd={() => {
        bedienung.current = false;
        const c = ref.current;
        const p = folgePunkt();
        const vorher = folgeAbstand.current;
        folgeAbstand.current = null;
        if (!c || !p || !vorher) return;
        // verschoben: Verfolgung beenden
        const drift = Math.hypot(c.target.x - p.x - vorher.x, c.target.z - p.z - vorher.z);
        const d = camera.position.distanceTo(c.target);
        if (drift > Math.max(2, d * 0.12)) useAnsicht.getState().folgenSetzen(null);
      }}
    />
  );
}

function istSchmal(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < 820;
}

/** Abstand, aus dem die ganze Karte zu sehen ist (Hochformat braucht mehr Abstand) */
export function uebersichtsAbstand(): number {
  const seiten = typeof window === 'undefined' ? 1.6 : window.innerWidth / Math.max(1, window.innerHeight);
  return Math.min(2300, Math.max(1250, 1250 * (0.95 / seiten)));
}

/** Blickwinkel der Übersicht: im Hochformat steiler, damit die Karte den Bildschirm füllt */
export function uebersichtsPolar(): number {
  return istSchmal() ? 0.55 : POLAR_3D;
}

/** Startansicht: ganze Karte von Süden */
export function startKamera(breiteKm: number, hoeheKm: number): { position: [number, number, number]; ziel: [number, number, number] } {
  const r = uebersichtsAbstand();
  const phi = uebersichtsPolar();
  const z = versatzFuerBlatt(new Vector3((breiteKm * S) / 2, 0, (-hoeheKm * S) / 2), r, phi, 0);
  const ziel: [number, number, number] = [z.x, z.y, z.z];
  return { position: [ziel[0], Math.cos(phi) * r, ziel[2] + Math.sin(phi) * r], ziel };
}

/**
 * Auf schmalen Bildschirmen verdeckt das Blatt unten einen Teil des Bildes: um so viel das
 * Blickziel zur Kamera hin rücken, dass das Objekt in der Mitte des sichtbaren Teils steht.
 */
function blattVersatz(r: number, phi: number, theta: number): { x: number; z: number } {
  if (!istSchmal()) return { x: 0, z: 0 };
  const v = (r * 0.12) / Math.max(0.35, Math.cos(phi));
  // Richtung „unten am Bildschirm“ auf dem Boden = zur Kamera hin
  return phi < 0.05 ? { x: 0, z: v } : { x: Math.sin(theta) * v, z: Math.cos(theta) * v };
}

function versatzFuerBlatt(ziel: Vector3, r: number, phi: number, theta: number): Vector3 {
  const v = blattVersatz(r, phi, theta);
  return ziel.clone().add(new Vector3(v.x, 0, v.z));
}
