import { fmtDeltaEuro, fmtDeltaKm, fmtDeltaMin } from '../core/format';
import type { Kontext } from '../core/modell';
import { rechenwegErsparnis } from '../core/rechenweg';
import { VORSCHLAG_NAME, tourName, type Vorschlag } from '../core/vorschlaege';
import { WertKnopf } from './Rechenweg';

/** Ein Vorschlag mit Δ km, Δ Arbeitszeit, Δ €/Tag, Δ €/Jahr und den betroffenen Touren */
export function VorschlagKarte({ v, ctx, onUebernehmen }: { v: Vorschlag; ctx: Kontext; onUebernehmen: () => void }) {
  const rw = () => rechenwegErsparnis(ctx, v.alt, v.neu, v.delta, v.wiederkehrend);
  const farbe = (x: number, gutWennNegativ = true) => (Math.abs(x) < 1e-6 ? '' : (x < 0) === gutWennNegativ ? 'gut' : 'schlecht');
  return (
    <div className="vorschlag">
      <div className="art">{VORSCHLAG_NAME[v.art]}</div>
      <h3>{v.titel}</h3>
      <p>{v.text}</p>
      <div className="deltas">
        <div className="delta">
          <div className="label">Δ km</div>
          <div className={`wert ${farbe(v.delta.km)}`}>{fmtDeltaKm(v.delta.km)}</div>
        </div>
        <div className="delta">
          <div className="label">Δ Arbeitszeit</div>
          <div className={`wert ${farbe(v.delta.arbeitMin)}`}>{fmtDeltaMin(v.delta.arbeitMin)}</div>
        </div>
        <div className="delta">
          <div className="label">Δ €/Tag</div>
          <div className={`wert ${farbe(-v.delta.euroTag)}`}>
            <WertKnopf rechenweg={rw}>{fmtDeltaEuro(-v.delta.euroTag)}</WertKnopf>
          </div>
        </div>
        <div className="delta">
          <div className="label">Δ €/Jahr{v.wiederkehrend ? '' : ' (falls täglich)'}</div>
          <div className={`wert ${farbe(-v.delta.euroJahr)}`}>
            <WertKnopf rechenweg={rw}>{fmtDeltaEuro(-v.delta.euroJahr, true)}</WertKnopf>
          </div>
        </div>
      </div>
      {v.delta.bezahltMin !== 0 && Math.abs(v.delta.bezahltMin - v.delta.arbeitMin) > 1 && (
        <div className="leise" style={{ fontSize: 12, marginBottom: 6 }}>
          Bezahlte Zeit: {fmtDeltaMin(v.delta.bezahltMin)} (volle Schicht je Tour plus Überstunden)
        </div>
      )}
      {v.warnung && (
        <div className="warnung" style={{ fontSize: 13, marginBottom: 6 }}>
          ⚠ {v.warnung}
        </div>
      )}
      <div className="fuss">
        <div className="chips">
          {v.delta.betroffen.map((id) => {
            const t = ctx.tag.touren.find((x) => x.id === id)!;
            return (
              <span key={id} className="chip" style={{ borderColor: t.farbe, color: t.farbe }}>
                {tourName(ctx, id)}
              </span>
            );
          })}
        </div>
        <button className="knopf primaer klein" onClick={onUebernehmen}>
          Übernehmen
        </button>
      </div>
    </div>
  );
}
