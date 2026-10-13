import { useMemo, useState } from 'react';
import { G } from '../glossar';
import { fmtZahl } from '../core/format';
import type { Kontext } from '../core/modell';
import { SCAN_ARTEN, SCAN_INFO, fmtUhrSek, type ScanEreignis } from '../core/scan';
import { stoppAdresse } from '../core/sendungen';
import { tourName } from '../core/vorschlaege';
import { useLeitstand, type LogEintrag } from '../state/store';

function fahrzeugTour(ctx: Kontext, fahrzeug: string): string {
  const t = ctx.tag.touren.find((x) => x.fahrzeugId === fahrzeug);
  return t ? `${fahrzeug} (${tourName(ctx, t.id)})` : fahrzeug;
}

export function ereignisText(ctx: Kontext, e: ScanEreignis): string {
  switch (e.art) {
    case 'PAKET_EINGANG_BASIS':
      return `${e.sendung} → ${G.behaelter} ${e.behaelter} · ${stoppAdresse(ctx.welt, e.stopp)}`;
    case 'BEHAELTER_VERLADEN':
      return `${G.behaelter} ${e.behaelter} → ${fahrzeugTour(ctx, e.fahrzeug)}`;
    case 'PAKET_IN_FAHRZEUG':
      return `${e.sendung} → ${e.fahrzeug}`;
    case 'TOUR_START':
    case 'TOUR_ENDE':
      return fahrzeugTour(ctx, e.fahrzeug);
    case 'POSITION':
      return `${e.fahrzeug} · ${e.x.toFixed(3).replace('.', ',')} / ${e.y.toFixed(3).replace('.', ',')} km (±${e.genauigkeitM} m)`;
    case 'ZUSTELLUNG':
      return `${e.sendung} · ${e.fahrzeug}`;
    case 'NICHT_ZUGESTELLT':
      return `${e.sendung} · ${e.grund}`;
  }
}

const GERAET_FARBE = { NACHRICHT: '#3a56d4', BESTAETIGUNG: '#13865b', GERAET: '#5b6675' };

/** Live mitlaufender Ereignisstrom (fürs Demo-Video), mit Zählern je Art */
export function EreignisPanel({ onSchliessen }: { onSchliessen?: () => void }) {
  const { ctx, log, lage } = useLeitstand();
  useLeitstand((s) => s.lageVersion);
  const [positionen, setPositionen] = useState(true);
  const zeilen = useMemo(() => {
    const l = positionen ? log : log.filter((x) => x.quelle !== 'scan' || x.e.art !== 'POSITION');
    return l.slice(-60).reverse();
  }, [log, positionen]);
  if (!ctx || !lage) return null;
  return (
    <div className="ereignis-panel">
      <div className="ereignis-kopf">
        <div>
          <b>Ereignisstrom</b> <span className="leise klein">Scan-Ereignisse, live</span>
        </div>
        <label className="klein leise schalter">
          <input type="checkbox" checked={positionen} onChange={(e) => setPositionen(e.target.checked)} /> POSITION
        </label>
        {onSchliessen && (
          <button className="knopf klein symbol" onClick={onSchliessen} aria-label="Ereignisstrom ausblenden">
            ✕
          </button>
        )}
      </div>
      <div className="ereignis-zaehler">
        {SCAN_ARTEN.map((a) => (
          <span key={a} className="ereignis-art" style={{ ['--artfarbe' as string]: SCAN_INFO[a].farbe }} title={SCAN_INFO[a].quelle}>
            {a.replace(/_/g, ' ')} <b>{fmtZahl(lage.zaehler[a] ?? 0)}</b>
          </span>
        ))}
      </div>
      <ol className="ereignis-liste">
        {zeilen.map((x) => (
          <Zeile key={x.quelle === 'scan' ? `s${x.e.nr}` : `g${x.nr}`} x={x} ctx={ctx} />
        ))}
      </ol>
    </div>
  );
}

function Zeile({ x, ctx }: { x: LogEintrag; ctx: Kontext }) {
  if (x.quelle === 'scan') {
    const e = x.e;
    return (
      <li className={e.art === 'POSITION' ? 'leise' : ''}>
        <span className="uhr">{fmtUhrSek(e.zeit)}</span>
        <span className="art" style={{ ['--artfarbe' as string]: SCAN_INFO[e.art].farbe }}>
          {e.art}
        </span>
        <span className="text">{ereignisText(ctx, e)}</span>
      </li>
    );
  }
  return (
    <li>
      <span className="uhr">{fmtUhrSek(x.zeit)}</span>
      <span className="art art-geraet" style={{ ['--artfarbe' as string]: GERAET_FARBE[x.art] }}>
        {x.art === 'GERAET' ? 'GERÄT' : x.art === 'BESTAETIGUNG' ? 'BESTÄTIGT' : 'NACHRICHT'}
      </span>
      <span className="text">
        {tourName(ctx, x.tourId)}: {x.text}
      </span>
    </li>
  );
}
