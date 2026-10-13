import { ERKLAERUNG, G, type Begriff } from '../glossar';

/** Info-Seite: Datenschutz by Design, Hinweise zum Prototyp, Glossar */
export function InfoDialog({ onSchliessen }: { onSchliessen: () => void }) {
  return (
    <div className="dialog-hintergrund" onClick={onSchliessen}>
      <div className="dialog breit" role="dialog" aria-modal="true" aria-label="Info und Datenschutz" onClick={(e) => e.stopPropagation()}>
        <div className="karte-kopf">
          <h2>Info und Datenschutz</h2>
          <button className="knopf klein" onClick={onSchliessen}>
            Schließen
          </button>
        </div>
        <div className="hinweis-box" style={{ marginTop: 0 }}>
          Prototyp mit <b>erfundenen Daten</b>: Die Demo-Welt „Musterhausen“, alle Straßen, Mengen und Pseudonyme sind frei erfunden. Alles „Live“ ist simuliert.
        </div>

        <h3 style={{ marginTop: 16 }}>Datenschutz by Design</h3>
        <ul className="liste">
          <li>
            <b>Ortung nur während der Schicht und nur auf Fahrzeugebene.</b> Erfasst wird das {G.zustellfahrzeug}, nicht die Person; außerhalb der Schicht gibt es keine Positionen.
          </li>
          <li>
            <b>Pseudonyme statt Namen.</b> Im {G.leitstand} heißt es „{G.pseudonymVorsilbe} A“. Es gibt keine Ranglisten und keine Leistungsvergleiche einzelner {G.zustellerInnen}.
          </li>
          <li>
            <b>Positionsdaten werden nach Schichtende gelöscht.</b> Übrig bleiben nur zusammengefasste Kennzahlen je {G.tour} und Tag (z. B. km, Dauer, Kosten).
          </li>
          <li>
            <b>Einführung nur mit Betriebsrat und Datenschutzbeauftragten.</b> Die Ortung von Beschäftigten ist mitbestimmungspflichtig (§ 87 Abs. 1 Nr. 6 BetrVG); Zweck, Umfang und Speicherdauer werden vorher vereinbart.
          </li>
        </ul>

        <h3 style={{ marginTop: 16 }}>Begriffe</h3>
        <dl className="glossar">
          {(Object.keys(ERKLAERUNG) as Begriff[]).map((k) => (
            <div key={k}>
              <dt>{G[k]}</dt>
              <dd>{ERKLAERUNG[k]}</dd>
            </div>
          ))}
        </dl>
        <p className="leise klein">Alle Begriffe stehen zentral in src/glossar.ts und lassen sich dort an die eigenen Bezeichnungen anpassen.</p>
      </div>
    </div>
  );
}
