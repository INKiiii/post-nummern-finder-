import { useEffect } from 'react';
import { TEMPI, simUhr, useLeitstand } from '../state/store';
import { useDemo } from './demo/regie';

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

/**
 * Tastatur für die Zeitsteuerung (praktisch fürs Demo-Video):
 * Leertaste Start/Pause · ← → 10 Minuten (mit Umschalt 1 Stunde) · 1–5 Tempo
 */
export function useZeitTasten(): void {
  useEffect(() => {
    const taste = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // während der Demo gehören die Tasten der Demo
      if (useDemo.getState().aktiv) return;
      const ziel = e.target as HTMLElement | null;
      if (ziel?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const s = useLeitstand.getState();
      if (e.key === ' ') {
        // auf einem Knopf löst die Leertaste schon den Knopf aus
        if (ziel?.closest('button, a')) return;
        e.preventDefault();
        s.startPause();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const schritt = (e.shiftKey ? 60 : 10) * (e.key === 'ArrowLeft' ? -1 : 1);
        s.zeitSetzen(simUhr.zeit + schritt);
      } else if (/^[1-5]$/.test(e.key)) {
        const t = TEMPI[Number(e.key) - 1];
        if (t !== undefined) s.tempoSetzen(t);
      }
    };
    window.addEventListener('keydown', taste);
    return () => window.removeEventListener('keydown', taste);
  }, []);
}
