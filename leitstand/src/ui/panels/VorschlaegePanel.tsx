import { G } from '../../glossar';
import { useLeitstand } from '../../state/store';
import { vorschauOeffnen } from '../aktionen';
import { VorschlagKarte } from '../VorschlagKarte';
import { PanelKopf } from './Gemeinsam';

/** Vorschläge des Leitstands ab jetzt (aus dem Lagebild), beste zuerst */
export function VorschlaegePanel({ onSchliessen }: { onSchliessen: () => void }) {
  const ctx = useLeitstand((s) => s.ctxLive);
  const vorschlaege = useLeitstand((s) => s.vorschlaege);
  const laden = useLeitstand((s) => s.vorschlaegeLaden);
  const start = useLeitstand((s) => s.startLive);
  const vorschauAusVorschlag = useLeitstand((s) => s.vorschauAusVorschlag);
  const uebernehmen = useLeitstand((s) => s.vorschlagUebernehmen);
  if (!ctx) return null;
  const morgens = !!start && Object.values(start).every((s) => s.mussLaden);
  return (
    <div className="panel">
      <PanelKopf
        titel="Vorschläge"
        unter={morgens ? `Plan für den Tag, vor der Abfahrt` : `ab jetzt, aus dem Lagebild (Umplanung unterwegs per Übergabe)`}
        onSchliessen={onSchliessen}
      />
      <div className="panel-abschnitt">
        {laden && vorschlaege.length === 0 && <p className="leise">Rechne …</p>}
        {!laden && vorschlaege.length === 0 && <p className="leise">Keine Verbesserung gefunden. Der Plan passt so.</p>}
        {vorschlaege.map((v) => (
          <VorschlagKarte key={v.id} v={v} ctx={ctx} onAnsehen={() => vorschauOeffnen(vorschauAusVorschlag(v))} onUebernehmen={() => uebernehmen(v)} />
        ))}
        <p className="leise klein" style={{ marginTop: 10 }}>
          Eigene Änderungen: {G.behaelter} oder {G.fahrzeug} anklicken → „Umplanen“. Jede Zahl lässt sich antippen: „Wie kommt die Zahl zustande?“
        </p>
      </div>
    </div>
  );
}
