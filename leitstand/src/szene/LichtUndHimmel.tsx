import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Color, DirectionalLight, Fog, HemisphereLight, Object3D, Vector3 } from 'three';
import { useAnsicht } from '../state/ansicht';
import { simUhr } from '../state/store';
import { lichtZurZeit } from './licht';

const ziel = new Vector3();

/** Sonne, Himmel und Nebel nach Simulationsuhr; der Schattenbereich folgt der Kamera */
export function LichtUndHimmel() {
  const sonne = useRef<DirectionalLight>(null);
  const hemi = useRef<HemisphereLight>(null);
  const { scene, controls } = useThree();
  const qualitaet = useAnsicht((s) => s.qualitaet);
  const groesse = useRef(0);

  useEffect(() => {
    scene.background = new Color('#cfe3f2');
    scene.fog = new Fog('#cfe3f2', 2000, 6000);
    const t = new Object3D();
    scene.add(t);
    if (sonne.current) sonne.current.target = t;
    return () => {
      scene.remove(t);
    };
  }, [scene]);

  useFrame(({ camera }) => {
    const l = lichtZurZeit(simUhr.zeit);
    const s = sonne.current;
    const h = hemi.current;
    if (!s || !h) return;
    const c = controls as unknown as { target?: Vector3 } | null;
    ziel.copy(c?.target ?? new Vector3());
    const abstand = camera.position.distanceTo(ziel);
    s.position.set(ziel.x + l.sonne[0] * 600, l.sonne[1] * 600, ziel.z + l.sonne[2] * 600);
    s.target.position.copy(ziel);
    s.target.updateMatrixWorld();
    s.color.set(l.sonnenFarbe);
    s.intensity = l.sonnenStaerke;
    h.color.set(l.himmel);
    h.groundColor.set(l.boden);
    h.intensity = l.umgebungStaerke;
    (scene.background as Color).set(l.himmel);
    const fog = scene.fog as Fog;
    fog.color.set(l.himmel);
    fog.near = abstand * 2.2 + 200;
    fog.far = abstand * 6 + 1500;

    // Schattenbereich passend zum Zoom
    const halb = Math.min(560, Math.max(22, abstand * 0.9));
    if (Math.abs(halb - groesse.current) / halb > 0.05) {
      groesse.current = halb;
      const cam = s.shadow.camera;
      cam.left = -halb;
      cam.right = halb;
      cam.top = halb;
      cam.bottom = -halb;
      cam.near = 10;
      cam.far = 1400;
      cam.updateProjectionMatrix();
      const texel = (2 * halb) / s.shadow.mapSize.x;
      s.shadow.normalBias = texel * 1.2;
    }
  });

  const karte = qualitaet === 'hoch' ? 2048 : 1024;
  return (
    <>
      <hemisphereLight ref={hemi} args={['#cfe3f2', '#b9c79e', 1.1]} />
      <directionalLight ref={sonne} castShadow shadow-mapSize={[karte, karte]} shadow-bias={-0.0004} intensity={2.4} />
    </>
  );
}
