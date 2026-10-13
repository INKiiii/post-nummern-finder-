import { useEffect } from 'react';
import { DREHBUCH } from './drehbuch';
import { demoBeenden, demoPauseUmschalten, demoStarten, demoWeiter, useDemo } from './regie';

/** Demo von außen starten (Knopf, Menü, ?demo) */
export function demoLos(): void {
  void demoStarten(DREHBUCH);
}

/**
 * Untertitel der geführten Demo mit Pause, Weiter und Beenden.
 * Tasten: Leertaste Pause/Weiter · → nächster Schritt · Esc beenden.
 */
export function DemoOverlay({ unten }: { unten: boolean }) {
  const d = useDemo();

  useEffect(() => {
    if (!d.aktiv) return;
    const taste = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const ziel = e.target as HTMLElement | null;
      if (ziel?.closest('input, textarea, select')) return;
      if (e.key === ' ' && !ziel?.closest('button, a')) {
        e.preventDefault();
        demoPauseUmschalten();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        demoWeiter();
      } else if (e.key === 'Escape') demoBeenden();
    };
    window.addEventListener('keydown', taste);
    return () => window.removeEventListener('keydown', taste);
  }, [d.aktiv]);

  if (!d.aktiv) return null;
  const gesamt = d.anzahl ? Math.min(1, (d.schritt + d.anteil) / d.anzahl) : 0;
  return (
    <div className={`demo-ebene ${unten ? 'unten' : ''}`}>
      <section className="demo-karte glas" aria-label="Geführte Demo" aria-live="polite">
        <div className="demo-kopf">
          <span className="demo-marke">{d.fertig ? 'Demo' : `Demo · ${d.schritt + 1}/${d.anzahl}`}</span>
          <div className="demo-knoepfe">
            {d.fertig ? (
              <>
                <button className="knopf klein" onClick={demoLos}>
                  ↻ Nochmal
                </button>
                <button className="knopf klein primaer" onClick={demoBeenden}>
                  Schließen
                </button>
              </>
            ) : (
              <>
                <button className="knopf klein symbol" onClick={demoPauseUmschalten} aria-label={d.pausiert ? 'Demo fortsetzen' : 'Demo anhalten'} title={d.pausiert ? 'Fortsetzen (Leertaste)' : 'Anhalten (Leertaste)'}>
                  {d.pausiert ? '▶' : '❚❚'}
                </button>
                <button className="knopf klein symbol" onClick={demoWeiter} aria-label="Nächster Schritt" title="Nächster Schritt (→)">
                  ⏭
                </button>
                <button className="knopf klein symbol" onClick={demoBeenden} aria-label="Demo beenden" title="Demo beenden (Esc)">
                  ✕
                </button>
              </>
            )}
          </div>
        </div>
        <h3>{d.titel}</h3>
        <p>{d.text}</p>
        <div className="demo-balken" aria-hidden="true">
          <span style={{ width: `${gesamt * 100}%` }} />
        </div>
        {d.pausiert && <div className="demo-pause leise klein">Angehalten – die Uhr steht. Umsehen und Antippen ist erlaubt.</div>}
      </section>
    </div>
  );
}
