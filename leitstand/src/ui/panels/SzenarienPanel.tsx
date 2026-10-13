import { useState } from 'react';
import { G } from '../../glossar';
import { fmtUhr } from '../../core/format';
import { SZENARIEN, type SzenarioArt } from '../../core/szenarien';
import { useLeitstand } from '../../state/store';
import { PanelKopf } from './Gemeinsam';

/** Szenarien für die Demo: Ausfall, Stau, Panne, Spitzentag */
export function SzenarienPanel({ onSchliessen, onGestartet }: { onSchliessen: () => void; onGestartet: () => void }) {
  const tag = useLeitstand((s) => s.tag);
  const szenario = useLeitstand((s) => s.szenario);
  const annahmen = useLeitstand((s) => s.annahmen);
  const zeit = useLeitstand((s) => s.zeit);
  const starten = useLeitstand((s) => s.szenarioStarten);
  const beenden = useLeitstand((s) => s.szenarioBeenden);
  const [ausfallTour, setAusfallTour] = useState('T3');
  const [springer, setSpringer] = useState(false);
  const [panneTour, setPanneTour] = useState('T2');
  const [laeuft, setLaeuft] = useState(false);
  if (!tag) return null;

  const los = async (art: SzenarioArt, opt?: { tourId?: string; springer?: boolean }) => {
    setLaeuft(true);
    try {
      await starten(art, opt);
      onGestartet();
    } finally {
      setLaeuft(false);
    }
  };
  const tourWahl = (wert: string, setzen: (v: string) => void, label: string) => (
    <label className="szenario-wahl">
      <span>{label}</span>
      <select value={wert} onChange={(e) => setzen(e.target.value)}>
        {tag.touren.map((t) => (
          <option key={t.id} value={t.id}>
            {G.tour} {t.nr} ({t.pseudonym})
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="panel">
      <PanelKopf titel="Szenarien" unter="Was passiert, wenn der Tag nicht nach Plan läuft?" onSchliessen={onSchliessen} />
      {szenario && (
        <div className="panel-abschnitt szenario-aktiv">
          <div>
            <span className="leise klein">Läuft gerade</span>
            <b>{szenario.titel}</b>
          </div>
          <button className="knopf klein" onClick={() => void beenden()} disabled={laeuft}>
            Normaler Tag
          </button>
        </div>
      )}
      <div className="panel-abschnitt szenarien">
        <Karte art="ausfall">
          {tourWahl(ausfallTour, setAusfallTour, 'Wer fällt aus?')}
          <label className="schalter-zeile">
            <input type="checkbox" checked={springer} onChange={(e) => setSpringer(e.target.checked)} />
            <span>
              {G.springer} übernimmt ({annahmen.springerVorlaufMin} Min später)
            </span>
          </label>
          <button className="knopf primaer klein" disabled={laeuft} onClick={() => void los('ausfall', { tourId: ausfallTour, springer })}>
            Starten · Tag beginnt um 06:40
          </button>
        </Karte>
        <Karte art="stau">
          <button className="knopf primaer klein" disabled={laeuft} onClick={() => void los('stau')}>
            {zeit < 9 * 60 ? 'Starten · Uhr springt auf 09:30' : `Jetzt sperren (${fmtUhr(zeit)})`}
          </button>
        </Karte>
        <Karte art="defekt">
          {tourWahl(panneTour, setPanneTour, 'Welches Fahrzeug?')}
          <button className="knopf primaer klein" disabled={laeuft} onClick={() => void los('defekt', { tourId: panneTour })}>
            {zeit < 11 * 60 ? 'Starten · Uhr springt auf 11:30' : `Panne jetzt melden (${fmtUhr(zeit)})`}
          </button>
          <p className="leise klein" style={{ margin: 0 }}>
            Geht auch vom Gerät aus: in der Geräte-Ansicht „Panne melden“.
          </p>
        </Karte>
        <Karte art="spitzentag" zusatz={` +${annahmen.spitzentagProzent} %`}>
          <button className="knopf primaer klein" disabled={laeuft} onClick={() => void los('spitzentag')}>
            Starten · Tag beginnt um 06:40
          </button>
        </Karte>
      </div>
      <p className="leise klein" style={{ margin: '0 0 4px' }}>
        Danach zeigt der {G.leitstand} unter „Vorschläge“, wie er reagieren würde – mit Δ €, Vorschau und Nachricht an die Fahrer/innen.
      </p>
    </div>
  );
}

function Karte({ art, zusatz = '', children }: { art: SzenarioArt; zusatz?: string; children: React.ReactNode }) {
  const info = SZENARIEN[art];
  return (
    <div className="szenario-karte">
      <div className="art">{info.wann}</div>
      <h3>
        {info.titel}
        {zusatz}
      </h3>
      <p>{info.text}</p>
      <div className="szenario-bedienung">{children}</div>
    </div>
  );
}
