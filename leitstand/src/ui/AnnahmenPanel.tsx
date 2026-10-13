import { ANNAHMEN_INFO, STANDARD_ANNAHMEN, type AnnahmeGruppe, type AnnahmeSchluessel } from '../config';
import { useLeitstand } from '../state/store';

const GRUPPEN: AnnahmeGruppe[] = ['Zeit', 'Kosten', 'Hochrechnung', 'Ablauf'];

/** Alle Annahmen des Rechenmodells, gruppiert und änderbar */
export function AnnahmenPanel() {
  const { annahmen, annahmeSetzen, annahmenZuruecksetzen } = useLeitstand();
  const schluessel = Object.keys(ANNAHMEN_INFO) as AnnahmeSchluessel[];
  const geaendert = schluessel.some((k) => annahmen[k] !== STANDARD_ANNAHMEN[k]);
  return (
    <div>
      {GRUPPEN.map((g) => (
        <div key={g} className="annahmen-gruppe">
          <h3>{g}</h3>
          {schluessel
            .filter((k) => ANNAHMEN_INFO[k].gruppe === g)
            .map((k) => {
              const info = ANNAHMEN_INFO[k];
              return (
                <label key={k} className={`annahme-zeile ${annahmen[k] !== STANDARD_ANNAHMEN[k] ? 'geaendert' : ''}`} title={info.hinweis}>
                  <span>
                    {info.label} <span className="einheit">({info.einheit})</span>
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={info.min}
                    max={info.max}
                    step={info.schritt}
                    value={annahmen[k]}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value.replace(',', '.'));
                      if (Number.isFinite(v)) annahmeSetzen(k, Math.min(info.max, Math.max(info.min, v)));
                    }}
                  />
                </label>
              );
            })}
        </div>
      ))}
      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span className="leise" style={{ fontSize: 12 }}>
          Alle Werte sind Annahmen für eine Beispielrechnung.
        </span>
        <button className="knopf klein" disabled={!geaendert} onClick={annahmenZuruecksetzen}>
          Standardwerte
        </button>
      </div>
    </div>
  );
}
