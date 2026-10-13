import { useMemo, useState } from 'react';
import { G } from '../../glossar';
import { fmtDeltaEuro, fmtUhr } from '../../core/format';
import { tourMitBehaelter } from '../../core/uebergabe';
import { tauschOptionen, tourName, umplanOptionen } from '../../core/vorschlaege';
import { useAnsicht } from '../../state/ansicht';
import { useLeitstand } from '../../state/store';
import { optionVorschau, tauschVorschau, vorschauOeffnen } from '../aktionen';

const grob = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

function EuroDelta({ euroTag }: { euroTag: number }) {
  const klasse = euroTag > 0.5 ? 'gut' : euroTag < -0.5 ? 'schlecht' : 'leise';
  return <span className={`zahlen ${klasse}`}>{fmtDeltaEuro(-euroTag, true)}/Tag</span>;
}

/** Alle Touren als Ziel: aus der Halle anders verladen oder unterwegs per Übergabe */
export function AndereTourListe({ behaelterId, ohneAktuell = false }: { behaelterId: string; ohneAktuell?: boolean }) {
  const ctx = useLeitstand((s) => s.ctxLive);
  const rest = useLeitstand((s) => s.restplan);
  const optionen = useMemo(() => (ctx && rest ? umplanOptionen(ctx, rest, behaelterId) : []), [ctx, rest, behaelterId]);
  if (!ctx) return null;
  const liste = optionen.filter((o) => !ohneAktuell || !o.aktuell);
  if (liste.filter((o) => !o.aktuell).length === 0)
    return <p className="leise klein">Kein anderes {G.fahrzeug} kann diesen {G.behaelter} gerade übernehmen.</p>;
  return (
    <div className="optionen">
      {liste.map((o) => {
        const t = ctx.tag.touren.find((x) => x.id === o.tourId)!;
        return (
          <button
            key={o.tourId}
            className={`option ${o.aktuell ? 'aktuell' : ''} ${o.machbar ? '' : 'knapp'}`}
            style={{ ['--tourfarbe' as string]: t.farbe }}
            disabled={o.aktuell}
            onClick={() => vorschauOeffnen(optionVorschau(o, behaelterId))}
          >
            <span className="farbe" />
            <span className="mitte">
              <b>
                {tourName(ctx, o.tourId)}
                {o.aktuell && <span className="leise"> · aktuell</span>}
                {o.beste && !o.aktuell && <span className="gut"> · beste Wahl</span>}
              </b>
              <span className="leise klein">
                {o.uebergabe ? `Übergabe ${fmtUhr(o.uebergabe.zeit)} · ${o.uebergabe.treffpunkt.name}` : `${G.rampe} ${t.rampe}`} · endet {fmtUhr(o.endeDanach)}
                {!o.machbar && ' · Überstunden'}
              </span>
            </span>
            {!o.aktuell && <EuroDelta euroTag={o.delta.euroTag} />}
          </button>
        );
      })}
    </div>
  );
}

/** Tauschpartner: Behälter anderer Touren, beste zuerst */
export function TauschListe({ behaelterId }: { behaelterId: string }) {
  const ctx = useLeitstand((s) => s.ctxLive);
  const rest = useLeitstand((s) => s.restplan);
  const optionen = useMemo(() => (ctx && rest ? tauschOptionen(ctx, rest, behaelterId) : []), [ctx, rest, behaelterId]);
  const [alle, setAlle] = useState(false);
  if (!ctx) return null;
  if (optionen.length === 0) return <p className="leise klein">Kein Tausch möglich.</p>;
  const liste = alle ? optionen : optionen.slice(0, 5);
  return (
    <div className="optionen">
      {liste.map((o) => {
        const t = ctx.tag.touren.find((x) => x.id === o.tourId)!;
        return (
          <button
            key={`${o.tourId}:${o.partner}`}
            className={`option ${o.machbar ? '' : 'knapp'}`}
            style={{ ['--tourfarbe' as string]: t.farbe }}
            onClick={() => vorschauOeffnen(tauschVorschau(o, behaelterId))}
          >
            <span className="farbe" />
            <span className="mitte">
              <b>
                ⇄ {o.partner} <span className="leise">({tourName(ctx, o.tourId)})</span>
              </b>
              <span className="leise klein">
                {ctx.welt.bezirke[ctx.tag.behaelter[o.partner].zielbezirk].name}
                {o.uebergabe && ` · Übergabe ${fmtUhr(o.uebergabe.zeit)} · ${o.uebergabe.treffpunkt.name}`}
                {!o.machbar && ' · Überstunden'}
              </span>
            </span>
            <EuroDelta euroTag={o.delta.euroTag} />
          </button>
        );
      })}
      {optionen.length > 5 && (
        <button className="link klein" onClick={() => setAlle(!alle)}>
          {alle ? 'weniger zeigen' : `alle ${optionen.length} zeigen`}
        </button>
      )}
    </div>
  );
}

/** Abschnitt „Umplanen“ im Behälter-Panel */
export function BehaelterUmplanen({ id }: { id: string }) {
  const rest = useLeitstand((s) => s.restplan);
  const start = useLeitstand((s) => s.startLive);
  const zielWahlSetzen = useAnsicht((s) => s.zielWahlSetzen);
  const [modus, setModus] = useState<'andere' | 'tauschen'>('andere');
  if (!rest || !start) return null;
  const tour = tourMitBehaelter(rest, id);
  if (!tour) {
    return (
      <div className="panel-abschnitt">
        <h3>Umplanen</h3>
        <p className="leise klein">Der {G.bezirk} ist schon zugestellt oder wird gerade zugestellt.</p>
      </div>
    );
  }
  const inHalle = Object.values(start).every((s) => !s.geladen.includes(id));
  return (
    <div className="panel-abschnitt">
      <h3>Umplanen</h3>
      <div className="umschalter klein voll" role="tablist">
        <button className={modus === 'andere' ? 'an' : ''} onClick={() => setModus('andere')}>
          Andere {G.tour}
        </button>
        <button className={modus === 'tauschen' ? 'an' : ''} onClick={() => setModus('tauschen')}>
          Gebiet tauschen
        </button>
      </div>
      {modus === 'andere' ? <AndereTourListe behaelterId={id} /> : <TauschListe behaelterId={id} />}
      <p className="leise klein" style={{ margin: '6px 0 0' }}>
        {inHalle && !grob() ? `Oder den ${G.behaelter} in der 3D-Ansicht auf ein ${G.fahrzeug} ziehen. ` : ''}
        <button className="link" onClick={() => zielWahlSetzen({ behaelterId: id })}>
          {G.fahrzeug} in 3D antippen
        </button>
      </p>
    </div>
  );
}

/** Abschnitt „Umplanen“ im Fahrzeug-Panel: Behälter abgeben oder tauschen */
export function FahrzeugUmplanen({ tourId }: { tourId: string }) {
  const rest = useLeitstand((s) => s.restplan);
  const start = useLeitstand((s) => s.startLive);
  const [wahl, setWahl] = useState<string | null>(null);
  const [modus, setModus] = useState<'abgeben' | 'tauschen'>('abgeben');
  if (!rest || !start) return null;
  const st = start[tourId];
  if (!st?.besetzt) return null;
  const moeglich = (rest.touren[tourId]?.schritte ?? []).flatMap((s) => (s.art === 'bezirk' && (st.mussLaden || st.geladen.includes(s.behaelterId)) ? [s.behaelterId] : []));
  if (moeglich.length === 0) return null;
  const gewaehlt = wahl && moeglich.includes(wahl) ? wahl : null;
  return (
    <div className="panel-abschnitt">
      <h3>Umplanen</h3>
      <div className="umschalter klein voll" role="tablist">
        <button className={modus === 'abgeben' ? 'an' : ''} onClick={() => setModus('abgeben')}>
          {G.behaelter} abgeben an …
        </button>
        <button className={modus === 'tauschen' ? 'an' : ''} onClick={() => setModus('tauschen')}>
          Gebiet tauschen
        </button>
      </div>
      <div className="leise klein" style={{ margin: '6px 0 4px' }}>
        Welcher {G.behaelter}?
      </div>
      <div className="chips" style={{ marginBottom: 6 }}>
        {moeglich.map((b) => (
          <button key={b} className={`chip ${gewaehlt === b ? 'gewaehlt' : ''}`} onClick={() => setWahl(gewaehlt === b ? null : b)} aria-pressed={gewaehlt === b}>
            {b}
          </button>
        ))}
      </div>
      {gewaehlt && (modus === 'abgeben' ? <AndereTourListe behaelterId={gewaehlt} ohneAktuell /> : <TauschListe behaelterId={gewaehlt} />)}
      {!st.mussLaden && (
        <p className="leise klein" style={{ margin: '6px 0 0' }}>
          Unterwegs geht das per Übergabe an einem {G.treffpunkt}; wer zuerst da ist, wartet.
        </p>
      )}
    </div>
  );
}
