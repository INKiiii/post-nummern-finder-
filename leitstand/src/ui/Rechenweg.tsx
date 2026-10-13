import { useEffect, type ReactNode } from 'react';
import { create } from 'zustand';
import { ANNAHMEN_INFO } from '../config';
import type { Rechenweg } from '../core/rechenweg';
import { useLeitstand } from '../state/store';

interface DialogZustand {
  rechenweg: Rechenweg | null;
  zeigen: (r: Rechenweg) => void;
  schliessen: () => void;
}

export const useRechenwegDialog = create<DialogZustand>((set) => ({
  rechenweg: null,
  zeigen: (rechenweg) => set({ rechenweg }),
  schliessen: () => set({ rechenweg: null }),
}));

/** Zahl, die per Klick ihren Rechenweg zeigt */
export function WertKnopf({ children, rechenweg, className }: { children: ReactNode; rechenweg: () => Rechenweg; className?: string }) {
  const zeigen = useRechenwegDialog((s) => s.zeigen);
  return (
    <button
      type="button"
      className={`wert-knopf ${className ?? ''}`}
      title="Wie kommt die Zahl zustande?"
      onClick={(e) => {
        e.stopPropagation();
        zeigen(rechenweg());
      }}
    >
      {children}
    </button>
  );
}

export function RechenwegDialog() {
  const { rechenweg, schliessen } = useRechenwegDialog();
  const annahmen = useLeitstand((s) => s.annahmen);
  useEffect(() => {
    if (!rechenweg) return;
    const taste = (e: KeyboardEvent) => e.key === 'Escape' && schliessen();
    window.addEventListener('keydown', taste);
    return () => window.removeEventListener('keydown', taste);
  }, [rechenweg, schliessen]);
  if (!rechenweg) return null;
  const verwendet = [...new Set(rechenweg.zeilen.flatMap((z) => z.annahmen))];
  return (
    <div className="dialog-hintergrund" onClick={schliessen}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={rechenweg.titel} onClick={(e) => e.stopPropagation()}>
        <div className="karte-kopf">
          <div>
            <div className="leise" style={{ fontSize: 12 }}>
              Wie kommt die Zahl zustande?
            </div>
            <h2>{rechenweg.titel}</h2>
          </div>
          <button className="knopf klein" onClick={schliessen}>
            Schließen
          </button>
        </div>
        <div className="formel">{rechenweg.formel}</div>
        <div className="tabelle-huelle">
          <table className="tabelle rechnung">
            <tbody>
              {rechenweg.zeilen.map((z, i) => (
                <tr key={i} className={z.summe ? 'summe' : ''}>
                  <td>{z.was}</td>
                  <td className="leise zahlen">{z.rechnung}</td>
                  <td className="r zahlen">{z.ergebnis}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {verwendet.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="leise" style={{ fontSize: 12, marginBottom: 4 }}>
              Eingesetzte Annahmen (im Bereich „Annahmen“ änderbar):
            </div>
            <div className="chips">
              {verwendet.map((k) => (
                <span key={k} className="chip annahme">
                  Annahme: {ANNAHMEN_INFO[k].label} = {annahmen[k].toLocaleString('de-DE')} {ANNAHMEN_INFO[k].einheit}
                </span>
              ))}
            </div>
          </div>
        )}
        {rechenweg.hinweise.length > 0 && (
          <ul className="hinweise">
            {rechenweg.hinweise.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
