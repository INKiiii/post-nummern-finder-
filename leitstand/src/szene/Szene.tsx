import { Canvas } from '@react-three/fiber';
import { NeutralToneMapping, PCFShadowMap } from 'three';
import { useAnsicht } from '../state/ansicht';
import { useLeitstand } from '../state/store';
import { Basis } from './Basis';
import { Behaelter3D } from './Behaelter3D';
import { Beschriftungen } from './Beschriftungen';
import { Fahrzeuge } from './Fahrzeuge';
import { Gelaende } from './Gelaende';
import { Haeuser } from './Haeuser';
import { Kamera, startKamera } from './Kamera';
import { LabelProjektor } from './LabelProjektor';
import { LichtUndHimmel } from './LichtUndHimmel';
import { Spuren } from './Spuren';
import { Strassen } from './Strassen';
import { VorschauSzene } from './VorschauSzene';
import { Ziehen } from './Ziehen';

/** Die 3D-Welt des Leitstands */
export function Szene() {
  const ctx = useLeitstand((s) => s.ctx);
  const plan = useLeitstand((s) => s.plan);
  const qualitaet = useAnsicht((s) => s.qualitaet);
  const waehlen = useAnsicht((s) => s.waehlen);
  if (!ctx || !plan) return null;
  const start = startKamera(ctx.welt.breiteKm, ctx.welt.hoeheKm);
  return (
    <Canvas
      className="szene"
      shadows={{ type: PCFShadowMap }}
      dpr={qualitaet === 'hoch' ? [1, 2] : [1, 1.5]}
      gl={{ antialias: true, powerPreference: 'high-performance', toneMapping: NeutralToneMapping }}
      camera={{ fov: 40, near: 1, far: 8000, position: start.position }}
      onCreated={(state) => {
        state.camera.lookAt(...start.ziel);
        // nur zur Fehlersuche: ?debug in der Adresse macht die Szene im Browser greifbar
        if (window.location.search.includes('debug')) Object.assign(window, { __r3f: state, __leitstand: useLeitstand, __ansicht: useAnsicht });
      }}
      onPointerMissed={() => waehlen(null)}
    >
      <LichtUndHimmel />
      <Kamera startZiel={start.ziel} />
      <Gelaende welt={ctx.welt} />
      <Strassen welt={ctx.welt} />
      <Haeuser welt={ctx.welt} tag={ctx.tag} plan={plan} />
      <Basis welt={ctx.welt} />
      <Behaelter3D welt={ctx.welt} tag={ctx.tag} plan={plan} />
      <Fahrzeuge ctx={ctx} />
      <Beschriftungen ctx={ctx} />
      <Spuren ctx={ctx} />
      <VorschauSzene />
      <Ziehen />
      <LabelProjektor />
    </Canvas>
  );
}
