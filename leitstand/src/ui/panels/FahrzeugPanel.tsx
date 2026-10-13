import { useState } from 'react';
import { G } from '../../glossar';
import { fmtDauer, fmtEuro, fmtKm, fmtUhr } from '../../core/format';
import { behaelterFolge } from '../../core/modell';
import { rechenwegTourKosten, rechenwegTourZeit } from '../../core/rechenweg';
import { fmtUhrSek } from '../../core/scan';
import { tourName } from '../../core/vorschlaege';
import { useAnsicht } from '../../state/ansicht';
import { useLeitstand } from '../../state/store';
import { waehleUndZeige } from '../aktionen';
import { WertKnopf } from '../Rechenweg';
import { AusScans, Balken, Geschaetzt, PanelKopf, Zeile } from './Gemeinsam';

const SCHNELL = [
  { titel: 'Bitte melden', text: 'Bitte kurz beim Leitstand melden.' },
  { titel: 'Hinweis', text: 'Achtung: Baustelle am Ortseingang, bitte Umleitung beachten.' },
  { titel: 'Pause', text: 'Bitte die Pause wie geplant einhalten.' },
];

export function FahrzeugPanel({ tourId }: { tourId: string }) {
  const { ctx, plan, lage, prognose, zeit, annahmen, nachrichten, geraete, nachrichtSenden } = useLeitstand();
  useLeitstand((s) => s.lageVersion);
  const waehlen = useAnsicht((s) => s.waehlen);
  const [eigeneNachricht, setEigeneNachricht] = useState('');
  if (!ctx || !plan || !lage) return null;
  const tour = ctx.tag.touren.find((t) => t.id === tourId)!;
  const fz = ctx.tag.fahrzeuge.find((f) => f.id === tour.fahrzeugId)!;
  const f = lage.fahrzeug(tourId);
  const p = lage.prognose(tourId, zeit);
  const pa = prognose?.touren[tourId];
  const schicht = annahmen.schichtStunden * 60;
  const dauer = pa?.aktiv ? pa.dauer : 0;
  const folge = behaelterFolge(plan, tourId);
  const letzteMeldung = f.fixes[f.fixes.length - 1];
  const verbunden = geraete[tourId] && Date.now() - geraete[tourId] < 15000;
  const meine = nachrichten.filter((n) => n.tourId === tourId);

  // Briefe: Fortschritt über alle Bezirke der Tour geschätzt
  let briefe = 0;
  let briefeZu = 0;
  for (const b of folge) {
    const anz = ctx.tag.behaelter[b].inhalt.briefe;
    briefe += anz;
    briefeZu += anz * lage.bezirk(ctx.tag.behaelter[b].zielbezirk).briefeAnteil;
  }

  return (
    <div className="panel">
      <PanelKopf titel={`${tourName(ctx, tourId)} · ${tour.pseudonym}`} unter={`${G.zustellfahrzeug} ${fz.id} (${fz.typ}) · ${G.rampe} ${tour.rampe}`} farbe={tour.farbe} onSchliessen={() => waehlen(null)} />
      <div className="status-zeile">
        {p.statusText} <AusScans />
      </div>

      {folge.length > 0 && (
        <>
          <div className="panel-abschnitt kacheln">
            <div className="kachel">
              <span className="leise">{f.tourStart !== null ? 'Abfahrt' : 'Abfahrt (Plan)'}</span>
              <b>{fmtUhr(p.abfahrt)}</b>
            </div>
            <div className="kachel">
              <span className="leise">Rückkehr (Prognose)</span>
              <b>{fmtUhr(p.rueckkehr)}</b>
            </div>
            <div className="kachel">
              <span className="leise">Arbeitszeit</span>
              <b className={dauer > schicht + 0.5 ? 'warnung' : ''}>
                {pa ? <WertKnopf rechenweg={() => rechenwegTourZeit(ctx, pa)}>{fmtDauer(dauer)}</WertKnopf> : '–'}
              </b>
            </div>
            <div className="kachel">
              <span className="leise">Kosten/Tag</span>
              <b>{pa ? <WertKnopf rechenweg={() => rechenwegTourKosten(ctx, pa)}>{fmtEuro(pa.kosten.summe, true)}</WertKnopf> : '–'}</b>
            </div>
          </div>

          <div className="panel-abschnitt">
            <Zeile was="Auslastung der Schicht (Prognose)">
              <span className={dauer > schicht + 0.5 ? 'warnung' : ''}>{Math.round((dauer / schicht) * 100)} %</span>
            </Zeile>
            <Balken anteil={dauer / schicht} warnung={dauer > schicht + 0.5} />
            <Zeile was="Fortschritt">{Math.round(p.fortschritt * 100)} %</Zeile>
            <Balken anteil={p.fortschritt} />
            {p.naechster && f.phase !== 'zurueck' && (
              <Zeile was={p.naechster.vorOrt ? 'Jetzt' : 'Nächster Halt'}>
                {p.naechster.name} ·{' '}
                {p.naechster.vorOrt ? `fertig ca. ${fmtUhr(p.naechster.ende)}` : `${fmtUhr(p.naechster.ankunft)} (in ${fmtDauer(Math.max(0, p.naechster.ankunft - zeit))})`}
              </Zeile>
            )}
            {f.phase === 'unterwegs' && Math.abs(p.tempo - 1) > 0.02 && (
              <Zeile was="Tempo ggü. Plan">
                {p.tempo > 1 ? `${Math.round((p.tempo - 1) * 100)} % langsamer` : `${Math.round((1 - p.tempo) * 100)} % schneller`} <Geschaetzt />
              </Zeile>
            )}
            {pa && <Zeile was="Strecke (Prognose)">{fmtKm(pa.km.gesamt)}</Zeile>}
          </div>

          <div className="panel-abschnitt">
            <h3>Ladung und Zustellung</h3>
            <div className="chips" style={{ marginBottom: 6 }}>
              {folge.map((b) => {
                const st = lage.behaelter(b).status;
                return (
                  <button key={b} className={`chip ${st === 'zugestellt' ? 'erledigt' : ''}`} style={{ borderColor: tour.farbe }} onClick={() => waehleUndZeige({ art: 'behaelter', id: b })} title={st}>
                    {st === 'zugestellt' ? '✓ ' : ''}
                    {b}
                  </button>
                );
              })}
            </div>
            <Zeile was={`${G.behaelterPlural} im ${G.fahrzeug}`}>
              {f.behaelter.length} <AusScans />
            </Zeile>
            <Zeile was={G.pakete}>
              {f.pakete.zugestellt} von {f.pakete.geladen} zugestellt{f.pakete.nicht ? `, ${f.pakete.nicht} nicht` : ''} <AusScans />
            </Zeile>
            <Balken anteil={f.pakete.geladen ? (f.pakete.zugestellt + f.pakete.nicht) / f.pakete.geladen : 0} />
            <Zeile was={G.briefe}>
              ca. {Math.round(briefe ? (briefeZu / briefe) * 100 : 0)} % <Geschaetzt />
            </Zeile>
            <Balken anteil={briefe ? briefeZu / briefe : 0} geschaetzt />
            {letzteMeldung && (
              <Zeile was="Letzte Position">
                {fmtUhrSek(letzteMeldung.t)} <span className="leise">(±15 m, nur während der Tour)</span>
              </Zeile>
            )}
          </div>

          <div className="panel-abschnitt">
            <h3>Route ({G.gangfolge})</h3>
            <ol className="route">
              <li className={f.tourStart !== null ? 'erledigt' : ''}>
                <span className="uhr">{fmtUhr(p.abfahrt)}</span>
                <span>
                  Abfahrt {G.rampe} {tour.rampe}
                </span>
              </li>
              {f.route.teile
                .filter((x) => x.art !== 'fahrt')
                .map((x, i) => {
                  const bl = x.bezirkId ? lage.bezirk(x.bezirkId) : null;
                  const zustand = bl?.fertig ? 'erledigt' : bl?.beginn !== null && bl?.beginn !== undefined ? 'aktiv' : '';
                  const ankunft = bl?.beginn ?? lage.ankunftBei(tourId, x.s0);
                  return (
                    <li key={i} className={zustand}>
                      <span className="uhr">{fmtUhr(ankunft)}</span>
                      <span>
                        {x.bezirkId ? (
                          <button className="link" onClick={() => waehleUndZeige({ art: 'bezirk', id: x.bezirkId! })}>
                            {x.name}
                          </button>
                        ) : (
                          x.name
                        )}
                        <span className="leise">
                          {' '}
                          {bl?.fertig ? `fertig ${fmtUhr(bl.ende!)}` : `bis ca. ${fmtUhr(lage.ankunftBei(tourId, x.s1))}`}
                          {x.bezirkId && ` · ${ctx.welt.bezirke[x.bezirkId].stopps.length} ${G.stopps}`}
                        </span>
                      </span>
                    </li>
                  );
                })}
              <li className={f.phase === 'zurueck' ? 'erledigt' : ''}>
                <span className="uhr">{fmtUhr(p.rueckkehr)}</span>
                <span>Rückkehr {G.zustellbasis}</span>
              </li>
            </ol>
            <p className="leise klein" style={{ margin: '4px 0 0' }}>
              Erledigt und „jetzt“ aus Scans und Positionen; spätere Zeiten sind Prognosen aus Plan und bisherigem Tempo.
            </p>
          </div>
        </>
      )}

      <div className="panel-abschnitt">
        <h3>
          Nachricht an das Gerät{' '}
          <span className={`marke ${verbunden ? 'scan' : ''}`} title="Geräte-Ansicht im zweiten Fenster">
            {verbunden ? 'Gerät verbunden' : 'Gerät nicht geöffnet'}
          </span>
        </h3>
        <div className="chips" style={{ marginBottom: 6 }}>
          {SCHNELL.map((s) => (
            <button key={s.titel} className="chip text" onClick={() => nachrichtSenden(tourId, s.titel, s.text)}>
              {s.titel}
            </button>
          ))}
        </div>
        <form
          className="nachricht-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!eigeneNachricht.trim()) return;
            nachrichtSenden(tourId, 'Nachricht', eigeneNachricht.trim());
            setEigeneNachricht('');
          }}
        >
          <input value={eigeneNachricht} onChange={(e) => setEigeneNachricht(e.target.value)} placeholder="Eigener Text …" maxLength={160} />
          <button className="knopf klein primaer" type="submit">
            Senden
          </button>
        </form>
        {meine.length > 0 && (
          <ul className="nachrichten">
            {[...meine].reverse().map((n) => (
              <li key={n.id}>
                <span className="uhr">{fmtUhr(n.zeit)}</span> {n.titel}
                <span className={n.bestaetigt !== null ? 'gut' : 'leise'}>{n.bestaetigt !== null ? ` · verstanden ${fmtUhr(n.bestaetigt)}` : ' · noch nicht bestätigt'}</span>
              </li>
            ))}
          </ul>
        )}
        <a className="link klein" href={`#/fahrer/${tourId}`} target="_blank" rel="noreferrer">
          Geräte-Ansicht dieser Tour in neuem Fenster öffnen
        </a>
      </div>
    </div>
  );
}
