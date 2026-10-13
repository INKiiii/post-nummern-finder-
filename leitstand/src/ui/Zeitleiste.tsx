import { fmtUhr } from '../core/format';
import { TAG_BEGINN, TAG_ENDE, TEMPI, useLeitstand } from '../state/store';

/** Simulationsuhr: Start/Pause, Tempo, Zeitleiste zum Spulen */
export function Zeitleiste({ kompakt = false }: { kompakt?: boolean }) {
  const { zeit, laeuft, tempo, startPause, tempoSetzen, zeitSetzen, tagNeuStarten } = useLeitstand();
  return (
    <div className={`zeitleiste ${kompakt ? 'kompakt' : ''}`}>
      <button className="knopf symbol primaer" onClick={startPause} aria-label={laeuft ? 'Pause' : 'Start'} title={laeuft ? 'Pause' : 'Start'}>
        {laeuft ? '❚❚' : '▶'}
      </button>
      <div className="umschalter klein" role="group" aria-label="Tempo">
        {TEMPI.filter((t) => !kompakt || t !== 240).map((t) => (
          <button key={t} className={tempo === t ? 'an' : ''} onClick={() => tempoSetzen(t)}>
            {t}×
          </button>
        ))}
      </div>
      <input
        className="regler"
        type="range"
        min={TAG_BEGINN}
        max={TAG_ENDE}
        step={1}
        value={Math.round(zeit)}
        onChange={(e) => zeitSetzen(Number(e.target.value))}
        aria-label="Zeitleiste"
      />
      {!kompakt && <span className="zahlen uhr-klein">{fmtUhr(zeit)}</span>}
      {!kompakt && (
        <button className="knopf klein" onClick={tagNeuStarten} title="Tag von vorn">
          ⟲ Neu
        </button>
      )}
    </div>
  );
}
