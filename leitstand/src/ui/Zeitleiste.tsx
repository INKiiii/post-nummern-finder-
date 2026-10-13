import { fmtUhr } from '../core/format';
import { TAG_BEGINN, TAG_ENDE, TEMPI, useLeitstand } from '../state/store';

/** Stundenmarken unter dem Regler */
const MARKEN = [7, 9, 12, 15, 18];
const MARKEN_KOMPAKT = [7, 12, 18];

/** Simulationsuhr: Start/Pause, Tempo, Zeitleiste zum Spulen */
export function Zeitleiste({ kompakt = false }: { kompakt?: boolean }) {
  const { zeit, laeuft, tempo, startPause, tempoSetzen, zeitSetzen, tagNeuStarten } = useLeitstand();
  return (
    <div className={`zeitleiste ${kompakt ? 'kompakt' : ''}`}>
      <button className="knopf symbol primaer" onClick={startPause} aria-label={laeuft ? 'Pause' : 'Start'} title={`${laeuft ? 'Pause' : 'Start'} (Leertaste)`}>
        {laeuft ? '❚❚' : '▶'}
      </button>
      <div className="umschalter klein" role="group" aria-label="Tempo">
        {TEMPI.filter((t) => !kompakt || t !== 240).map((t, i) => (
          <button key={t} className={tempo === t ? 'an' : ''} onClick={() => tempoSetzen(t)} title={`Tempo ${t}× (Taste ${i + 1})`}>
            {t}×
          </button>
        ))}
      </div>
      <div className="regler-huelle">
        <input
          className="regler"
          type="range"
          min={TAG_BEGINN}
          max={TAG_ENDE}
          step={1}
          value={Math.round(zeit)}
          onChange={(e) => zeitSetzen(Number(e.target.value))}
          aria-label="Zeitleiste"
          title="Zeit stellen (← → 10 Minuten, mit Umschalt 1 Stunde)"
          aria-valuetext={fmtUhr(zeit)}
        />
        <div className="regler-marken" aria-hidden="true">
          {(kompakt ? MARKEN_KOMPAKT : MARKEN).map((h) => (
            <span key={h} style={{ left: `calc(8px + (100% - 16px) * ${(h * 60 - TAG_BEGINN) / (TAG_ENDE - TAG_BEGINN)})` }}>
              {String(h).padStart(2, '0')}
            </span>
          ))}
        </div>
      </div>
      {!kompakt && <span className="zahlen uhr-klein">{fmtUhr(zeit)}</span>}
      {!kompakt && (
        <button className="knopf klein" onClick={tagNeuStarten} title="Tag von vorn" aria-label="Tag von vorn">
          ⟲<span className="neu-text"> Neu</span>
        </button>
      )}
    </div>
  );
}
