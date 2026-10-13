import { useEffect } from 'react';
import { useLeitstand } from '../state/store';

/** Treibt die Simulationsuhr an (nur im Leitstand-Fenster) */
export function useSimulationsTakt(): void {
  useEffect(() => {
    let id = 0;
    let vorher = performance.now();
    const schritt = (jetzt: number) => {
      const dt = Math.min(0.25, Math.max(0, (jetzt - vorher) / 1000));
      vorher = jetzt;
      useLeitstand.getState().ticken(dt);
      id = requestAnimationFrame(schritt);
    };
    id = requestAnimationFrame(schritt);
    return () => cancelAnimationFrame(id);
  }, []);
}
