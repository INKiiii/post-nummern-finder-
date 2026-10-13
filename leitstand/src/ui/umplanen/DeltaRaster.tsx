import { fmtDeltaEuro, fmtDeltaKm, fmtDeltaMin } from '../../core/format';
import type { Delta, Kontext, PlanAuswertung } from '../../core/modell';
import { rechenwegErsparnis } from '../../core/rechenweg';
import { WertKnopf } from '../Rechenweg';

const farbe = (x: number, gutWennNegativ = true) => (Math.abs(x) < 1e-6 ? '' : (x < 0) === gutWennNegativ ? 'gut' : 'schlecht');

/** Δ km, Δ Arbeitszeit, Δ €/Tag, Δ €/Jahr – jede Euro-Zahl mit „Wie kommt die Zahl zustande?“ */
export function DeltaRaster({ ctx, alt, neu, delta, wiederkehrend }: { ctx: Kontext; alt: PlanAuswertung; neu: PlanAuswertung; delta: Delta; wiederkehrend: boolean }) {
  const rw = () => rechenwegErsparnis(ctx, alt, neu, delta, wiederkehrend);
  return (
    <>
      <div className="deltas">
        <div className="delta">
          <div className="label">Δ km</div>
          <div className={`wert ${farbe(delta.km)}`}>{fmtDeltaKm(delta.km)}</div>
        </div>
        <div className="delta">
          <div className="label">Δ Arbeitszeit</div>
          <div className={`wert ${farbe(delta.arbeitMin)}`}>{fmtDeltaMin(delta.arbeitMin)}</div>
        </div>
        <div className="delta">
          <div className="label">Δ €/Tag</div>
          <div className={`wert ${farbe(-delta.euroTag)}`}>
            <WertKnopf rechenweg={rw}>{fmtDeltaEuro(-delta.euroTag)}</WertKnopf>
          </div>
        </div>
        <div className="delta">
          <div className="label">Δ €/Jahr{wiederkehrend ? '' : ' (falls täglich)'}</div>
          <div className={`wert ${farbe(-delta.euroJahr)}`}>
            <WertKnopf rechenweg={rw}>{fmtDeltaEuro(-delta.euroJahr, true)}</WertKnopf>
          </div>
        </div>
      </div>
      {Math.abs(delta.ueberstundenMin) > 0.5 && (
        <div className={`klein ${delta.ueberstundenMin < 0 ? 'gut' : 'warnung'}`} style={{ marginBottom: 6 }}>
          Überstunden: {fmtDeltaMin(delta.ueberstundenMin)}
        </div>
      )}
      {delta.bezahltMin !== 0 && Math.abs(delta.bezahltMin - delta.arbeitMin) > 1 && (
        <div className="leise klein" style={{ marginBottom: 6 }}>
          Bezahlte Zeit: {fmtDeltaMin(delta.bezahltMin)} (volle Schicht je Tour plus Überstunden)
        </div>
      )}
    </>
  );
}
