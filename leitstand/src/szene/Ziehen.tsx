import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Mesh, MeshLambertMaterial, Object3D, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { useAnsicht, type Auswahl } from '../state/ansicht';
import { tauschenMit, umplanenAuf } from '../ui/aktionen';
import { behaelterGeometrie } from './geometrie';

interface Steuerung {
  enabled: boolean;
}

/** Zustand außerhalb von React: ändert sich bei jeder Mausbewegung */
const z = {
  kandidat: null as null | { id: string; x: number; y: number; steuerung: Steuerung | null; farbe: string },
  aktiv: false,
  sichtbar: false,
  punkt: new Vector3(),
};

/** Maustaste auf einem Behälter gedrückt: Ziehen vorbereiten (Kamera steht still) */
export function ziehenVorbereiten(id: string, x: number, y: number, steuerung: Steuerung | null, farbe: string): void {
  z.kandidat = { id, x, y, steuerung, farbe };
  if (steuerung) steuerung.enabled = false;
}

/**
 * Drag & Drop am Laptop: Behälter aus der Halle auf ein Fahrzeug ziehen (andere Tour) oder
 * auf einen anderen Behälter (Gebiete tauschen). Ergebnis ist immer erst eine Vorschau.
 */
/** Ziel unter dem Strahl: Fahrzeug (userData.tourId) oder Behälter (userData.behaelterIds) */
function zielFinden(strahl: Raycaster, kandidaten: Object3D[], selbst: string): Auswahl {
  for (const t of strahl.intersectObjects(kandidaten, true)) {
    let o: Object3D | null = t.object;
    while (o) {
      if (o.userData.tourId) return { art: 'fahrzeug', id: o.userData.tourId as string };
      if (o.userData.behaelterIds && t.instanceId !== undefined) {
        const id = (o.userData.behaelterIds as string[])[t.instanceId];
        if (id !== selbst) return { art: 'behaelter', id };
        break;
      }
      o = o.parent;
    }
  }
  return null;
}

export function Ziehen() {
  const { camera, gl, scene } = useThree();
  const ref = useRef<Mesh>(null);
  const geo = useMemo(() => behaelterGeometrie(), []);
  const material = useMemo(() => new MeshLambertMaterial({ color: '#ffffff', transparent: true, opacity: 0.78, depthTest: false }), []);

  useEffect(() => {
    const strahl = new Raycaster();
    const boden = new Plane(new Vector3(0, 1, 0), 0);
    const ndc = new Vector2();
    let kandidaten: Object3D[] = [];
    const bewegen = (e: PointerEvent) => {
      const k = z.kandidat;
      if (!k) return;
      if (!z.aktiv && Math.hypot(e.clientX - k.x, e.clientY - k.y) > 6) {
        z.aktiv = true;
        material.color.set(k.farbe);
        kandidaten = [];
        scene.traverse((o) => {
          if (o.userData.tourId || o.userData.behaelterIds) kandidaten.push(o);
        });
        document.body.style.cursor = 'grabbing';
      }
      if (!z.aktiv) return;
      const r = gl.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      strahl.setFromCamera(ndc, camera);
      z.sichtbar = !!strahl.ray.intersectPlane(boden, z.punkt);
      useAnsicht.getState().ziehenSetzen({ behaelterId: k.id, ziel: zielFinden(strahl, kandidaten, k.id) });
    };
    const loslassen = () => {
      const k = z.kandidat;
      if (!k) return;
      if (k.steuerung) k.steuerung.enabled = true;
      const war = z.aktiv;
      const h = useAnsicht.getState().ziehen?.ziel ?? null;
      z.kandidat = null;
      z.aktiv = false;
      z.sichtbar = false;
      useAnsicht.getState().ziehenSetzen(null);
      document.body.style.cursor = '';
      if (!war) return;
      if (h?.art === 'fahrzeug') umplanenAuf(k.id, h.id);
      else if (h?.art === 'behaelter' && h.id !== k.id) tauschenMit(k.id, h.id);
      else useAnsicht.getState().hinweisSetzen('Zum Umplanen auf ein Fahrzeug ziehen (oder auf einen anderen Behälter zum Tauschen).');
    };
    window.addEventListener('pointermove', bewegen);
    window.addEventListener('pointerup', loslassen);
    window.addEventListener('pointercancel', loslassen);
    return () => {
      window.removeEventListener('pointermove', bewegen);
      window.removeEventListener('pointerup', loslassen);
      window.removeEventListener('pointercancel', loslassen);
    };
  }, [camera, gl, scene, material]);

  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    m.visible = z.aktiv && z.sichtbar;
    if (m.visible) m.position.set(z.punkt.x, 0.35, z.punkt.z);
  });

  return <mesh ref={ref} geometry={geo} material={material} visible={false} renderOrder={10} />;
}
