import { useEffect, useState, useSyncExternalStore } from 'react';
import { G } from '../glossar';
import { fmtDauer, fmtEuro, fmtUhr } from '../core/format';
import { rechenwegErsparnis, rechenwegPlanKosten } from '../core/rechenweg';
import { fahrzeugSicht } from '../core/sicht';
import { tourName } from '../core/vorschlaege';
import { Szene } from '../szene/Szene';
import { useAnsicht } from '../state/ansicht';
import { useLeitstand } from '../state/store';
import { basisZeigen, ganzeKarte, waehleUndZeige } from './aktionen';
import { InfoDialog } from './InfoDialog';
import { LabelEbene } from './LabelEbene';
import { BasisPanel } from './panels/BasisPanel';
import { BehaelterPanel } from './panels/BehaelterPanel';
import { BezirkPanel } from './panels/BezirkPanel';
import { FahrzeugPanel } from './panels/FahrzeugPanel';
import { Balken } from './panels/Gemeinsam';
import { WertKnopf } from './Rechenweg';

const SCHMAL = '(max-width: 819px)';

function useSchmal(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(SCHMAL);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(SCHMAL).matches,
  );
}

/** Hauptansicht: 3D-Szene mit Bedienelementen darüber */
export function Leitstand() {
  const schmal = useSchmal();
  const s = useLeitstand();
  const ansicht = useAnsicht();
  const [info, setInfo] = useState(false);
  const [menue, setMenue] = useState(false);
  const [blattOffen, setBlattOffen] = useState(true);

  useEffect(() => {
    const taste = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useAnsicht.getState().waehlen(null);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) useLeitstand.getState().wiederholen();
        else useLeitstand.getState().rueckgaengig();
      }
    };
    window.addEventListener('keydown', taste);
    return () => window.removeEventListener('keydown', taste);
  }, []);

  useEffect(() => {
    if (ansicht.auswahl) setBlattOffen(true);
  }, [ansicht.auswahl]);

  const { ctx, plan, auswertung: aus, startAuswertung: start } = s;
  if (!ctx || !plan || !aus || !start) return <div className="laden">Lade Demo-Welt …</div>;

  const ersparnis = start.summe.kosten.summe - aus.summe.kosten.summe;
  const deltaStart = {
    km: aus.summe.km - start.summe.km,
    arbeitMin: aus.summe.arbeitMin - start.summe.arbeitMin,
    bezahltMin: aus.summe.bezahltMin - start.summe.bezahltMin,
    ueberstundenMin: aus.summe.ueberstundenMin - start.summe.ueberstundenMin,
    euroTag: ersparnis,
    euroJahr: ersparnis * s.annahmen.zustelltageProJahr,
    aktiveTouren: aus.summe.aktiveTouren - start.summe.aktiveTouren,
    betroffen: aus.tourIds,
    liegen: 0,
  };

  const a = ansicht.auswahl;
  const panel =
    a?.art === 'behaelter' ? (
      <BehaelterPanel id={a.id} />
    ) : a?.art === 'fahrzeug' ? (
      <FahrzeugPanel tourId={a.id} />
    ) : a?.art === 'bezirk' ? (
      <BezirkPanel id={a.id} />
    ) : a?.art === 'basis' ? (
      <BasisPanel />
    ) : null;

  const kennzahlen = (
    <div className="kennzahlen-leiste">
      <div className="kz">
        <span className="leise">Kosten/Tag</span>
        <b>
          <WertKnopf rechenweg={() => rechenwegPlanKosten(ctx, aus)}>{fmtEuro(aus.summe.kosten.summe, true)}</WertKnopf>
        </b>
      </div>
      <div className="kz">
        <span className="leise">Ersparnis/Jahr</span>
        <b className={ersparnis > 0.005 ? 'gut' : ''}>
          <WertKnopf rechenweg={() => rechenwegErsparnis(ctx, start, aus, deltaStart)}>{fmtEuro(Math.max(0, deltaStart.euroJahr), true)}</WertKnopf>
        </b>
      </div>
      <div className="kz">
        <span className="leise">{G.touren}</span>
        <b>{aus.summe.aktiveTouren}</b>
      </div>
      <div className="kz">
        <span className="leise">Überstunden</span>
        <b className={aus.summe.ueberstundenMin > 0.5 ? 'warnung' : 'gut'}>{fmtDauer(aus.summe.ueberstundenMin)}</b>
      </div>
    </div>
  );

  const tourenListe = (
    <div className="touren-liste">
      {ctx.tag.touren.map((t) => {
        const ta = aus.touren[t.id];
        const fs = fahrzeugSicht(ctx, plan, aus, t.id, s.zeit);
        const aktiv = a?.art === 'fahrzeug' && a.id === t.id;
        return (
          <button
            key={t.id}
            className={`tour-zeile ${aktiv ? 'aktiv' : ''}`}
            style={{ ['--tourfarbe' as string]: t.farbe }}
            onClick={() => waehleUndZeige({ art: 'fahrzeug', id: t.id })}
            onMouseEnter={() => ansicht.hovern({ art: 'fahrzeug', id: t.id })}
            onMouseLeave={() => ansicht.hovern(null)}
          >
            <span className="farbe" />
            <span className="name">
              <b>{tourName(ctx, t.id)}</b>
              <span className="leise">{t.pseudonym}</span>
            </span>
            <span className="rechts">
              {ta.aktiv ? (
                <>
                  <span className={`zahlen ${ta.ueberstundenMin > 0.5 ? 'warnung' : ''}`}>bis {fmtUhr(ta.ende)}</span>
                  <Balken anteil={fs.auslastung} warnung={fs.auslastung > 1.005} />
                </>
              ) : (
                <span className="leise">entfällt</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="leitstand">
      <Szene />
      <LabelEbene />

      <header className="ls-kopf glas">
        <div className="ls-titel">
          <b>
            Zustell-{G.leitstand} <span className="leise">· {ctx.welt.name}</span>
          </b>
          <span className="leise klein">
            {ctx.tag.datum} · alle Daten erfunden
          </span>
        </div>
        <div className="uhr-anzeige" title="Simulationsuhr">
          {fmtUhr(s.zeit)}
        </div>
        <div className="ls-aktionen">
          <div className="umschalter" role="group" aria-label="Ansicht">
            <button className={!ansicht.draufsicht ? 'an' : ''} onClick={() => ansicht.draufsichtSetzen(false)}>
              3D
            </button>
            <button className={ansicht.draufsicht ? 'an' : ''} onClick={() => ansicht.draufsichtSetzen(true)}>
              Draufsicht
            </button>
          </div>
          <button className="knopf" onClick={basisZeigen}>
            Basis zeigen
          </button>
          <button className="knopf nur-breit" onClick={ganzeKarte}>
            Ganze Karte
          </button>
          <button className="knopf symbol" onClick={s.rueckgaengig} disabled={s.verlaufIndex <= 0} title="Rückgängig (Strg+Z)" aria-label="Rückgängig">
            ↶
          </button>
          <button className="knopf symbol" onClick={s.wiederholen} disabled={s.verlaufIndex >= s.verlauf.length - 1} title="Wiederholen (Strg+Umschalt+Z)" aria-label="Wiederholen">
            ↷
          </button>
          <button className="knopf nur-breit" onClick={s.zumStartplan} disabled={plan === s.startplan}>
            Startplan
          </button>
          <div className="menue-huelle">
            <button className="knopf symbol" onClick={() => setMenue(!menue)} aria-label="Menü" aria-expanded={menue}>
              ☰
            </button>
            {menue && (
              <div className="menue glas" onClick={() => setMenue(false)}>
                <button onClick={() => setInfo(true)}>Info und Datenschutz</button>
                <button onClick={() => ansicht.tourDaecherSetzen(!ansicht.tourDaecher)}>{ansicht.tourDaecher ? '✓ ' : ''}Dächer in Tourfarbe</button>
                <button onClick={() => ansicht.qualitaetSetzen(ansicht.qualitaet === 'hoch' ? 'niedrig' : 'hoch')}>
                  Grafik: {ansicht.qualitaet === 'hoch' ? 'hoch' : 'sparsam'} (umschalten)
                </button>
                <button onClick={ganzeKarte}>Ganze Karte</button>
                <button onClick={s.zumStartplan} disabled={plan === s.startplan}>
                  Startplan
                </button>
                <a href="#/kern">Rechenkern (2D-Prüfansicht)</a>
              </div>
            )}
          </div>
        </div>
      </header>

      {schmal ? (
        // Handy: Blatt am unteren Rand
        <section className={`ls-blatt glas ${blattOffen ? 'offen' : ''}`}>
          <button className="griff" onClick={() => setBlattOffen(!blattOffen)} aria-label={blattOffen ? 'Einklappen' : 'Ausklappen'}>
            <span />
          </button>
          {blattOffen && (
            <div className="blatt-inhalt" key={a ? `${a.art}:${a.id}` : 'liste'}>
              {panel ?? (
                <>
                  {kennzahlen}
                  {tourenListe}
                </>
              )}
            </div>
          )}
        </section>
      ) : (
        // breite Bildschirme: links Kennzahlen und Touren, rechts die Auswahl
        <>
          <aside className="ls-links glas">
            {kennzahlen}
            <h3 className="abschnitt-titel">{G.touren}</h3>
            {tourenListe}
          </aside>
          {panel && <aside className="ls-rechts glas">{panel}</aside>}
        </>
      )}

      {info && <InfoDialog onSchliessen={() => setInfo(false)} />}
    </div>
  );
}
