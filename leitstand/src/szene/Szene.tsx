import { Canvas } from '@react-three/fiber';
import { useMemo } from 'react';
import { NeutralToneMapping, PCFShadowMap } from 'three';
import { behaelterSicht } from '../core/sicht';
import { useAnsicht } from '../state/ansicht';
import { useLeitstand } from '../state/store';
import { Basis } from './Basis';
import { Behaelter3D } from './Behaelter3D';
import { Beschriftungen, Route } from './Beschriftungen';
import { Fahrzeuge } from './Fahrzeuge';
import { Gelaende } from './Gelaende';
import { Haeuser } from './Haeuser';
import { Kamera, startKamera } from './Kamera';
import { LabelProjektor } from './LabelProjektor';
import { LichtUndHimmel } from './LichtUndHimmel';
import { Strassen } from './Strassen';

/** Die 3D-Welt des Leitstands */
export function Szene() {
  const { ctx, plan, auswertung: aus, zeit } = useLeitstand();
  const qualitaet = useAnsicht((s) => s.qualitaet);
  const waehlen = useAnsicht((s) => s.waehlen);
  const sicht = useMemo(() => (ctx && plan && aus ? behaelterSicht(ctx, plan, aus, zeit) : null), [ctx, plan, aus, zeit]);
  if (!ctx || !plan || !aus || !sicht) return null;
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
        if (window.location.search.includes('debug')) (window as unknown as { __r3f: unknown }).__r3f = state;
      }}
      onPointerMissed={() => waehlen(null)}
    >
      <LichtUndHimmel />
      <Kamera startZiel={start.ziel} />
      <Gelaende welt={ctx.welt} />
      <Strassen welt={ctx.welt} />
      <Haeuser welt={ctx.welt} tag={ctx.tag} plan={plan} />
      <Basis welt={ctx.welt} />
      <Behaelter3D welt={ctx.welt} tag={ctx.tag} plan={plan} sicht={sicht} />
      <Fahrzeuge ctx={ctx} plan={plan} aus={aus} zeit={zeit} />
      <Beschriftungen ctx={ctx} />
      <Route ctx={ctx} aus={aus} />
      <LabelProjektor />
    </Canvas>
  );
}
