import { useMemo } from 'react';
import { G } from '../../glossar';
import { fmtDauer, fmtUhr } from '../../core/format';
import { VORSCHLAG_NAME, tourName } from '../../core/vorschlaege';
import { useLeitstand } from '../../state/store';
import { DeltaRaster } from './DeltaRaster';

const ART_NAME = { ...VORSCHLAG_NAME, andereTour: `Andere ${G.tour}`, tauschen: 'Gebiet tauschen' };

/** Vorschau einer Umplanung: was ändert sich, was spart es – Übernehmen oder Verwerfen */
export function VorschauKarte() {
  const v = useLeitstand((s) => s.vorschau);
  const ctx = useLeitstand((s) => s.ctxLive);
  const uebernehmen = useLeitstand((s) => s.vorschauUebernehmen);
  const setzen = useLeitstand((s) => s.vorschauSetzen);
  const nachrichtenFuer = useLeitstand((s) => s.nachrichtenFuer);
  const nachrichten = useMemo(() => (v ? nachrichtenFuer(v.tagesplan, v.neu) : []), [v, nachrichtenFuer]);
  if (!v || !ctx) return null;
  const touren = ctx.tag.touren.filter((t) => v.delta.betroffen.includes(t.id));
  return (
    <div className="vorschau-karte" role="dialog" aria-label="Vorschau der Umplanung">
      <div className="vorschau-kopf">
        <div>
          <div className="art">Vorschau · {ART_NAME[v.art]}</div>
          <h3>{v.titel}</h3>
        </div>
        <button className="knopf symbol klein" onClick={() => setzen(null)} aria-label="Vorschau verwerfen">
          ✕
        </button>
      </div>
      {v.text && <p className="vorschau-text">{v.text}</p>}
      {v.uebergaben.map((u) => (
        <div key={u.id} className="uebergabe-zeile">
          <span className="treff-symbol" aria-hidden="true" />
          <span>
            <b>
              Übergabe {fmtUhr(u.zeit)} am {G.treffpunkt} {u.treffpunkt.name}
            </b>
            <br />
            <span className="leise">
              {u.abgeben.length > 0 && `${u.abgeben.join(', ')}: ${tourName(ctx, u.von)} → ${tourName(ctx, u.nach)}`}
              {u.abgeben.length > 0 && u.aufnehmen.length > 0 && ' · '}
              {u.aufnehmen.length > 0 && `${u.aufnehmen.join(', ')}: ${tourName(ctx, u.nach)} → ${tourName(ctx, u.von)}`}
              {Object.entries(u.wartenMin)
                .filter(([, m]) => m > 0.5)
                .map(([t, m]) => ` · ${tourName(ctx, t)} wartet ${fmtDauer(m)}`)
                .join('')}
            </span>
          </span>
        </div>
      ))}
      <DeltaRaster ctx={ctx} alt={v.alt} neu={v.neu} delta={v.delta} wiederkehrend={v.wiederkehrend} />
      {touren.length > 0 && (
        <div className="vorschau-touren">
          {touren.map((t) => {
            const a = v.alt.touren[t.id];
            const n = v.neu.touren[t.id];
            const d = n.aktiv && a.aktiv ? n.ende - a.ende : 0;
            return (
              <div key={t.id} className="vorschau-tour" style={{ ['--tourfarbe' as string]: t.farbe }}>
                <span className="farbe" />
                <b>{tourName(ctx, t.id)}</b>
                <span className="zahlen">
                  {!n.aktiv ? 'entfällt' : `endet ${fmtUhr(n.ende)}`}
                  {n.aktiv && a.aktiv && Math.abs(d) >= 0.5 && <span className={d < 0 ? 'gut' : 'warnung'}> ({d < 0 ? '−' : '+'}{fmtDauer(Math.abs(d))})</span>}
                </span>
                {n.ueberstundenMin > 0.5 && <span className="warnung klein">+{fmtDauer(n.ueberstundenMin)} Überstunden</span>}
              </div>
            );
          })}
        </div>
      )}
      {v.warnung && <div className="warnung klein">⚠ {v.warnung}</div>}
      {nachrichten.length > 0 && (
        <div className="vorschau-nachrichten">
          <div className="leise klein">Beim Übernehmen geht eine Nachricht an das Gerät von:</div>
          {nachrichten.map((m) => (
            <div key={m.tourId} className="vorschau-nachricht" style={{ ['--tourfarbe' as string]: ctx.tag.touren.find((t) => t.id === m.tourId)?.farbe }}>
              <b>{tourName(ctx, m.tourId)}</b>
              <span>{m.punkte.map((p) => p.text).join(' · ')}</span>
            </div>
          ))}
        </div>
      )}
      <div className="vorschau-fuss">
        <span className="leise klein">Die Uhr steht, solange die Vorschau offen ist.</span>
        <div className="knopf-reihe">
          <button className="knopf klein" onClick={() => setzen(null)}>
            Verwerfen
          </button>
          <button className="knopf primaer klein" onClick={uebernehmen}>
            Übernehmen
          </button>
        </div>
      </div>
    </div>
  );
}
