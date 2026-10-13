import type { ReactNode } from 'react';
import { G } from '../../glossar';
import type { BehaelterStatus } from '../../core/types';

export const STATUS_TEXT: Record<BehaelterStatus, string> = {
  halle: `In der ${G.halle}`,
  verladen: 'Verladen',
  unterwegs: 'Unterwegs',
  zugestellt: 'Zugestellt',
};

export function PanelKopf({ titel, unter, farbe, onSchliessen }: { titel: ReactNode; unter?: ReactNode; farbe?: string; onSchliessen: () => void }) {
  return (
    <div className="panel-kopf" style={farbe ? { ['--tourfarbe' as string]: farbe } : undefined}>
      <div style={{ minWidth: 0 }}>
        <h2 className={farbe ? 'mit-farbe' : ''}>{titel}</h2>
        {unter && <div className="leise unter">{unter}</div>}
      </div>
      <button className="knopf klein symbol" onClick={onSchliessen} aria-label="Schließen">
        ✕
      </button>
    </div>
  );
}

export function Zeile({ was, children }: { was: ReactNode; children: ReactNode }) {
  return (
    <div className="info-zeile">
      <span className="leise">{was}</span>
      <span>{children}</span>
    </div>
  );
}

export function Balken({ anteil, warnung }: { anteil: number; warnung?: boolean }) {
  return (
    <div className="balken">
      <div className={`fuellung ${warnung ? 'warn' : ''}`} style={{ width: `${Math.min(100, Math.max(0, anteil * 100))}%` }} />
    </div>
  );
}
