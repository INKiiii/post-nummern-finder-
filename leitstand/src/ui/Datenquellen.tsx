import { G } from '../glossar';
import { fmtZahl } from '../core/format';
import { SCAN_ARTEN, SCAN_INFO } from '../core/scan';
import { useLeitstand } from '../state/store';

interface Zeile {
  bedarf: string;
  heute: string;
  ereignis?: string;
  neu: string | null;
}

const ZEILEN: Zeile[] = [
  { bedarf: `Welche ${G.pakete} heute in welchen ${G.bezirk} gehen`, heute: 'Eingangsscan in der Basis', ereignis: 'PAKET_EINGANG_BASIS', neu: null },
  {
    bedarf: `Wie viele ${G.briefe} und ${G.zeitungen} je ${G.bezirk}`,
    heute: 'Mengen aus der Sortierung bzw. Erfahrungswerte je Bezirk (Briefe werden nicht einzeln gescannt)',
    neu: null,
  },
  {
    bedarf: `In welchem ${G.fahrzeug} welcher ${G.rollbehaelter} ist`,
    heute: 'abgeleitet aus den Ladescans der Pakete',
    ereignis: 'PAKET_IN_FAHRZEUG',
    neu: 'optional: Barcode-Etikett am Rollbehälter (dann direkt per Verladescan)',
  },
  { bedarf: 'Wann eine Tour beginnt und endet', heute: 'An- und Abmeldung am Handscanner', ereignis: 'TOUR_START / TOUR_ENDE', neu: null },
  {
    bedarf: `Wo das ${G.fahrzeug} ungefähr ist`,
    heute: 'Standort des fahrzeuggebundenen Handscanners, alle 60 Sekunden, nur während der Tour',
    ereignis: 'POSITION',
    neu: null,
  },
  { bedarf: 'Fortschritt bei den Paketen', heute: 'Zustellscan mit Zeit und Ort, bei Misserfolg mit Grund', ereignis: 'ZUSTELLUNG / NICHT_ZUGESTELLT', neu: null },
  { bedarf: 'Fortschritt bei den Briefen', heute: 'geschätzt aus Position und Gangfolge (im Leitstand als „geschätzt“ markiert)', neu: null },
  { bedarf: `${G.zustellbezirke}, ${G.gangfolge}, Touren, ${G.rampen}`, heute: 'Gangfolge- und Bezirksdaten der Basis', neu: null },
  { bedarf: 'Straßennetz für Fahrzeiten und Umleitungen', heute: 'Kartendaten (z. B. OpenStreetMap)', neu: null },
  { bedarf: 'Nachrichten an die Fahrer/innen und Bestätigung', heute: 'Nachrichtenfunktion des Handscanners', neu: 'Anbindung über die Schnittstelle „FahrerGeraet“' },
  { bedarf: 'Daten in den Leitstand bringen', heute: '–', neu: 'eine Schnittstelle: Lesezugriff auf die Scan-Ereignisse' },
  { bedarf: `${G.leitstand}-Arbeitsplatz`, heute: 'vorhandener PC oder Laptop mit Browser', neu: null },
];

/** Seite „Datenquellen“: Bedarf | heute vorhanden über | neu nötig */
export function Datenquellen() {
  const { lage, behaelterBarcode, barcodeSetzen } = useLeitstand();
  useLeitstand((s) => s.lageVersion);
  return (
    <div className="seite">
      <header className="kopf">
        <div className="titel">
          <h1>Datenquellen</h1>
          <div className="leise" style={{ fontSize: 13 }}>
            Was braucht der {G.leitstand}, und woher kommt es heute schon?
          </div>
        </div>
        <div className="aktionen">
          <a className="knopf" href="#/" style={{ textDecoration: 'none' }}>
            ← 3D-{G.leitstand}
          </a>
        </div>
      </header>
      <main className="seite-inhalt">
        <div className="ergebnis-box">
          <div className="ergebnis-gross">Keine neue Hardware.</div>
          <div>
            Neu ist nur <b>eine Schnittstelle</b> zu den Scan-Daten, die bei der Arbeit ohnehin entstehen, und optional ein <b>Barcode-Etikett am Rollbehälter</b>.
          </div>
        </div>

        <div className="karte">
          <div className="tabelle-huelle">
            <table className="tabelle quellen">
              <thead>
                <tr>
                  <th>Bedarf</th>
                  <th>heute vorhanden über</th>
                  <th>neu nötig</th>
                </tr>
              </thead>
              <tbody>
                {ZEILEN.map((z) => (
                  <tr key={z.bedarf}>
                    <td>{z.bedarf}</td>
                    <td>
                      {z.heute}
                      {z.ereignis && (
                        <div>
                          <code className="ereignis-code">{z.ereignis}</code>
                        </div>
                      )}
                    </td>
                    <td className={z.neu ? 'neu' : 'nichts'}>{z.neu ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="karte">
          <h2>Der Ereignisstrom „Scan-Ereignisse“</h2>
          <p className="leise">
            Die 3D-Welt, der Fortschritt, die Restzeiten und die Vorschläge werden nur aus diesem Strom berechnet. Im Prototyp erzeugt ihn der Adapter „SimulierteScanner“; ein echter Adapter könnte
            ihn genauso liefern.
          </p>
          <div className="tabelle-huelle">
            <table className="tabelle">
              <thead>
                <tr>
                  <th>Ereignis</th>
                  <th>entsteht bei</th>
                  <th>Inhalt</th>
                  <th className="r">heute bisher</th>
                </tr>
              </thead>
              <tbody>
                {SCAN_ARTEN.map((a) => (
                  <tr key={a}>
                    <td>
                      <span className="art-punkt" style={{ background: SCAN_INFO[a].farbe }} /> <code className="ereignis-code">{a}</code>
                    </td>
                    <td>
                      {SCAN_INFO[a].quelle}
                      {SCAN_INFO[a].neu && <div className="leise klein">{SCAN_INFO[a].neu}</div>}
                    </td>
                    <td>{SCAN_INFO[a].text}</td>
                    <td className="r zahlen">{fmtZahl(lage?.zaehler[a] ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="schalter-zeile">
            <input type="checkbox" checked={behaelterBarcode} onChange={(e) => barcodeSetzen(e.target.checked)} />
            <span>
              Barcode-Etikett am Rollbehälter simulieren. Ohne Etikett gibt es kein BEHAELTER_VERLADEN; der {G.leitstand} leitet die Zuordnung dann aus den Ladescans der Pakete ab.
            </span>
          </label>
        </div>

        <div className="karte">
          <h2>Was gemessen und was geschätzt ist</h2>
          <ul className="liste">
            <li>
              <b>Gemessen:</b> Paketeingang, Verladung, Tourbeginn und -ende, Paketzustellung (mit Zeit und Ort), ungefähre Fahrzeugposition.
            </li>
            <li>
              <b>Abgeleitet:</b> Position der {G.rollbehaelter} = Position des {G.fahrzeug}s, in das sie verladen wurden (Behälter haben keinen eigenen Tracker).
            </li>
            <li>
              <b>Übergaben am {G.treffpunkt}:</b> erkannt am Ladescan im übernehmenden {G.fahrzeug} – dafür gibt es kein eigenes Ereignis.
            </li>
            <li>
              <b>Geschätzt:</b> Fortschritt bei {G.briefe}n und {G.zeitungen} aus Position und {G.gangfolge}; Restzeiten und Rückkehr aus dem Plan und dem bisher beobachteten Tempo.
            </li>
          </ul>
        </div>

        <div className="karte">
          <h2>Datenschutz</h2>
          <p>
            Positionen gibt es nur auf Fahrzeugebene und nur zwischen Tourbeginn und Tourende. Der {G.leitstand} zeigt Pseudonyme, keine Ranglisten. Positionsdaten werden nach Schichtende gelöscht;
            übrig bleiben zusammengefasste Kennzahlen. Einführung nur mit Betriebsrat und Datenschutzbeauftragten (§ 87 Abs. 1 Nr. 6 BetrVG).
          </p>
        </div>
      </main>
    </div>
  );
}
