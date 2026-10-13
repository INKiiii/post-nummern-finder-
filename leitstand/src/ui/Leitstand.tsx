import { useEffect, useState, useSyncExternalStore } from 'react';
import { G } from '../glossar';
import { fmtDauer, fmtEuro, fmtUhr } from '../core/format';
import { rechenwegErsparnis, rechenwegPlanKosten } from '../core/rechenweg';
import { tourName } from '../core/vorschlaege';
import { Szene } from '../szene/Szene';
import { useAnsicht } from '../state/ansicht';
import { useLeitstand } from '../state/store';
import { basisZeigen, ganzeKarte, waehleUndZeige } from './aktionen';
import { EreignisPanel } from './EreignisPanel';
import { InfoDialog } from './InfoDialog';
import { LabelEbene } from './LabelEbene';
import { BasisPanel } from './panels/BasisPanel';
import { BehaelterPanel } from './panels/BehaelterPanel';
import { BezirkPanel } from './panels/BezirkPanel';
import { FahrzeugPanel } from './panels/FahrzeugPanel';
import { Balken } from './panels/Gemeinsam';
import { SzenarienPanel } from './panels/SzenarienPanel';
import { VorschlaegePanel } from './panels/VorschlaegePanel';
import { Hinweise } from './umplanen/Hinweise';
import { demoLos } from './demo/DemoOverlay';
import { useDemo } from './demo/regie';
import { VorschauKarte } from './umplanen/VorschauKarte';
import { WertKnopf } from './Rechenweg';
import { useZeitTasten } from './takt';
import { Zeitleiste } from './Zeitleiste';

const SCHMAL = '(max-width: 819px)';

/** Szenario im Kopf auf dem Handy: nur ein Stichwort */
const KURZ = { ausfall: 'Ausfall', stau: 'Stau', defekt: 'Panne', spitzentag: 'Spitzentag' } as const;

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

function ereignisseAnfangs(): boolean {
  try {
    return localStorage.getItem('leitstand.ereignisse') !== 'aus';
  } catch {
    return true;
  }
}

/** Hauptansicht: 3D-Szene mit Bedienelementen darüber */
export function Leitstand() {
  const schmal = useSchmal();
  const s = useLeitstand();
  const ansicht = useAnsicht();
  const [info, setInfo] = useState(false);
  const [menue, setMenue] = useState(false);
  const [blattOffen, setBlattOffen] = useState(true);
  const [blattTab, setBlattTab] = useState<'touren' | 'vorschlaege' | 'ereignisse' | 'szenarien'>('touren');
  const [rechtsAnsicht, setRechtsAnsicht] = useState<'vorschlaege' | 'szenarien' | null>(null);
  const vorschlaegeOffen = rechtsAnsicht === 'vorschlaege';
  const demoAktiv = useDemo((d) => d.aktiv);
  useZeitTasten();
  const [ereignisse, setEreignisseRoh] = useState(ereignisseAnfangs);
  const setEreignisse = (an: boolean) => {
    setEreignisseRoh(an);
    try {
      localStorage.setItem('leitstand.ereignisse', an ? 'an' : 'aus');
    } catch {
      /* ohne Speicher geht es auch */
    }
  };

  useEffect(() => {
    const taste = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'Escape') {
        const a = useAnsicht.getState();
        if (a.zielWahl) a.zielWahlSetzen(null);
        else if (useLeitstand.getState().vorschau) useLeitstand.getState().vorschauSetzen(null);
        else a.waehlen(null);
      }
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

  // Wunsch von außen (Demo): Vorschläge oder Szenarien zeigen
  const seitenWunsch = ansicht.seitenWunsch;
  useEffect(() => {
    if (!seitenWunsch) return;
    if (schmal) {
      setBlattTab(seitenWunsch.ansicht);
      setBlattOffen(true);
    } else setRechtsAnsicht(seitenWunsch.ansicht);
  }, [seitenWunsch, schmal]);

  // Handy: zum Antippen des Ziel-Fahrzeugs das Blatt einklappen, danach wieder öffnen
  const zielWahlAktiv = !!ansicht.zielWahl;
  useEffect(() => {
    if (!schmal) return;
    setBlattOffen(!zielWahlAktiv);
  }, [zielWahlAktiv, schmal]);

  const grob = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
  const { ctx, plan, auswertung: aus, startAuswertung: start, lage, prognose, zeit } = s;
  if (!ctx || !plan || !aus || !start || !lage) return <div className="laden">Lade Demo-Welt …</div>;

  const tagLaeuft = ctx.tag.touren.some((t) => lage.fahrzeug(t.id).tourStart !== null);
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
  const ueberstunden = tagLaeuft && prognose ? prognose.summe.ueberstundenMin : aus.summe.ueberstundenMin;

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

  const anzahlVorschlaege = s.vorschlaege.filter((v) => v.delta.euroTag > 0.5 || v.art === 'ausfall' || v.delta.ueberstundenMin < -0.5).length;
  const vorschlaegeZeigen = () => {
    ansicht.waehlen(null);
    setRechtsAnsicht('vorschlaege');
    setBlattTab('vorschlaege');
    setBlattOffen(true);
  };
  const szenarienZeigen = () => {
    ansicht.waehlen(null);
    setRechtsAnsicht('szenarien');
    setBlattTab('szenarien');
    setBlattOffen(true);
  };
  const szenarien = <SzenarienPanel onSchliessen={() => (schmal ? setBlattTab('touren') : setRechtsAnsicht(null))} onGestartet={vorschlaegeZeigen} />;
  const rechts =
    panel ??
    (rechtsAnsicht === 'vorschlaege' ? (
      <VorschlaegePanel onSchliessen={() => setRechtsAnsicht(null)} />
    ) : rechtsAnsicht === 'szenarien' ? (
      szenarien
    ) : null);

  // Lage: Behälter, die ohne Umplanung heute liegen blieben (Ausfall, Panne)
  const liegen = prognose?.liegen.behaelter ?? [];
  const lageWarnung =
    liegen.length > 0 ? (
      <div className="lage-warnung">
        <b>
          {liegen.length} {liegen.length === 1 ? G.behaelter : G.behaelterPlural} {liegen.length === 1 ? 'bleibt' : 'bleiben'} heute liegen
        </b>
        <span>{liegen.join(', ')}</span>
        <button className="knopf klein primaer" onClick={vorschlaegeZeigen}>
          Vorschläge ansehen
        </button>
      </div>
    ) : null;

  const kennzahlen = (
    <div className="kennzahlen-leiste">
      <div className="kz">
        <span className="leise">Kosten/Tag (Plan)</span>
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
        <span className="leise">Überstunden{tagLaeuft ? ' (Prognose)' : ''}</span>
        <b className={ueberstunden > 0.5 ? 'warnung' : 'gut'}>{fmtDauer(ueberstunden)}</b>
      </div>
    </div>
  );

  const tourenListe = (
    <div className="touren-liste">
      {ctx.tag.touren.map((t) => {
        const p = lage.prognose(t.id, zeit);
        const pa = prognose?.touren[t.id];
        const besetzt = ctx.tag.start[t.id].besetzt;
        const schicht = s.annahmen.schichtStunden * 60;
        const auslastung = pa?.aktiv ? pa.dauer / schicht : 0;
        const aktiv = a?.art === 'fahrzeug' && a.id === t.id;
        const briefOffen = s.nachrichten.some((n) => n.tourId === t.id && n.punkte && n.bestaetigt === null && !n.ersetztDurch);
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
              <b>
                {tourName(ctx, t.id)}
                {briefOffen && (
                  <span className="brief-offen" title="Umplanung gesendet, noch nicht bestätigt">
                    ✉ offen
                  </span>
                )}
              </b>
              <span className={`leise ${!besetzt || lage.fahrzeug(t.id).defekt ? 'schlecht' : ''}`}>{pa?.aktiv || !besetzt ? p.statusText : 'entfällt'}</span>
            </span>
            <span className="rechts">
              {pa?.aktiv ? (
                <>
                  <span className={`zahlen ${auslastung > 1.005 ? 'warnung' : ''}`}>bis {fmtUhr(p.rueckkehr)}</span>
                  <Balken anteil={p.phase === 'unterwegs' || p.phase === 'zurueck' ? p.fortschritt : auslastung} warnung={auslastung > 1.005} />
                </>
              ) : (
                <span className="leise">–</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className={`leitstand ${ereignisse && !schmal ? 'mit-ereignissen' : ''}`}>
      <Szene />
      <LabelEbene />

      {(schmal || grob) && (
        <div className={`zoom-knoepfe ${schmal ? 'schmal' : ''} ${demoAktiv ? 'mit-demo' : ''}`}>
          <button className="knopf symbol" onClick={() => ansicht.zoomen(0.5)} aria-label="Hineinzoomen" title="Hineinzoomen">
            +
          </button>
          <button className="knopf symbol" onClick={() => ansicht.zoomen(2)} aria-label="Herauszoomen" title="Herauszoomen">
            −
          </button>
          <button className="knopf symbol" onClick={ganzeKarte} aria-label="Ganze Karte" title="Ganze Karte">
            ⤢
          </button>
        </div>
      )}

      <header className="ls-kopf glas">
        <div className="ls-titel">
          <b>
            Zustell-{G.leitstand} <span className="leise">· {ctx.welt.name}</span>
          </b>
          {s.szenario ? (
            <span className="szenario-chip">
              <span className="lang">Szenario: {s.szenario.titel}</span>
              <span className="kurz">{KURZ[s.szenario.art]}</span>
              <button onClick={() => void s.szenarioBeenden()} aria-label="Szenario beenden" title="Szenario beenden (normaler Tag)">
                ✕
              </button>
            </span>
          ) : (
            <span className="leise klein">{ctx.tag.datum} · alle Daten erfunden · Lage nur aus Scan-Ereignissen</span>
          )}
        </div>
        <div className="uhr-anzeige" title="Simulationsuhr">
          {fmtUhr(zeit)}
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
          <button className="knopf nur-breit demo-start" onClick={demoLos} disabled={demoAktiv} title="Geführte Demo, gut 2 Minuten">
            ▶ Demo
          </button>
          <button
            className={`knopf nur-breit ${rechtsAnsicht === 'szenarien' && !panel ? 'an' : ''}`}
            onClick={() => (rechtsAnsicht === 'szenarien' && !panel ? setRechtsAnsicht(null) : szenarienZeigen())}
            aria-pressed={rechtsAnsicht === 'szenarien' && !panel}
          >
            Szenarien
          </button>
          <button
            className={`knopf nur-breit ${vorschlaegeOffen && !panel ? 'an' : ''}`}
            onClick={() => (vorschlaegeOffen && !panel ? setRechtsAnsicht(null) : vorschlaegeZeigen())}
            aria-pressed={vorschlaegeOffen && !panel}
          >
            Vorschläge{anzahlVorschlaege > 0 && <span className="zaehler">{anzahlVorschlaege}</span>}
          </button>
          <button className={`knopf nur-breit ${ereignisse ? 'an' : ''}`} onClick={() => setEreignisse(!ereignisse)} aria-pressed={ereignisse}>
            Ereignisse
          </button>
          <button className="knopf symbol" onClick={s.rueckgaengig} disabled={s.verlaufIndex <= 0} title="Rückgängig (Strg+Z)" aria-label="Rückgängig">
            ↶
          </button>
          <button className="knopf symbol" onClick={s.wiederholen} disabled={s.verlaufIndex >= s.verlauf.length - 1} title="Wiederholen (Strg+Umschalt+Z)" aria-label="Wiederholen">
            ↷
          </button>
          <div className="menue-huelle">
            <button className="knopf symbol" onClick={() => setMenue(!menue)} aria-label="Menü" aria-expanded={menue}>
              ☰
            </button>
            {menue && (
              <div className="menue glas" onClick={() => setMenue(false)}>
                <button onClick={demoLos} disabled={demoAktiv}>
                  ▶ Demo starten (geführt, gut 2 Minuten)
                </button>
                <a href="#/zahlen">Idee in Zahlen: was der Leitstand bringt</a>
                <a href="#/datenquellen">Datenquellen: was der Leitstand braucht</a>
                <a href="#/fahrer" target="_blank" rel="noreferrer">
                  Geräte-Ansicht (Fahrer) in neuem Fenster
                </a>
                <button onClick={() => setInfo(true)}>Info und Datenschutz</button>
                <button onClick={() => setEreignisse(!ereignisse)}>{ereignisse ? '✓ ' : ''}Ereignisstrom einblenden</button>
                <button onClick={() => ansicht.tourDaecherSetzen(!ansicht.tourDaecher)}>{ansicht.tourDaecher ? '✓ ' : ''}Dächer in Tourfarbe</button>
                <button onClick={() => s.fahrerSimulierenSetzen(!s.fahrerSimulieren)}>{s.fahrerSimulieren ? '✓ ' : ''}Fahrer ohne Geräte-Fenster simulieren</button>
                <button onClick={() => ansicht.qualitaetSetzen(ansicht.qualitaet === 'hoch' ? 'niedrig' : 'hoch')}>
                  Grafik: {ansicht.qualitaet === 'hoch' ? 'hoch' : 'sparsam'} (umschalten)
                </button>
                <button onClick={szenarienZeigen}>Szenarien (Ausfall, Stau, Panne, Spitzentag)</button>
                <button onClick={ganzeKarte}>Ganze Karte</button>
                <button onClick={s.zumStartplan} disabled={plan === s.startplan}>
                  Startplan
                </button>
                <button onClick={s.tagNeuStarten}>Tag neu starten</button>
                <a href="#/kern">Rechenkern (2D-Prüfansicht)</a>
              </div>
            )}
          </div>
        </div>
      </header>

      {schmal ? (
        // Handy: Uhr und Blatt am unteren Rand
        <section className={`ls-blatt glas ${blattOffen ? 'offen' : ''}`}>
          <button className="griff" onClick={() => setBlattOffen(!blattOffen)} aria-label={blattOffen ? 'Einklappen' : 'Ausklappen'}>
            <span />
          </button>
          <div className="blatt-uhr">
            <Zeitleiste kompakt />
          </div>
          {blattOffen && !panel && !s.vorschau && (
            <div className="blatt-tabs umschalter" role="tablist">
              <button className={blattTab === 'touren' ? 'an' : ''} onClick={() => setBlattTab('touren')}>
                {G.touren}
              </button>
              <button className={blattTab === 'vorschlaege' ? 'an' : ''} onClick={() => setBlattTab('vorschlaege')}>
                Vorschläge{anzahlVorschlaege > 0 && <span className="zaehler">{anzahlVorschlaege}</span>}
              </button>
              <button className={blattTab === 'ereignisse' ? 'an' : ''} onClick={() => setBlattTab('ereignisse')}>
                Ereignisse
              </button>
            </div>
          )}
          {(blattOffen || s.vorschau) && (
            <div className="blatt-inhalt" key={s.vorschau ? 'vorschau' : a ? `${a.art}:${a.id}` : blattTab}>
              {s.vorschau ? (
                <VorschauKarte />
              ) : (
                (panel ??
                (blattTab === 'touren' ? (
                  <>
                    {kennzahlen}
                    {lageWarnung}
                    {tourenListe}
                  </>
                ) : blattTab === 'vorschlaege' ? (
                  <VorschlaegePanel onSchliessen={() => setBlattTab('touren')} />
                ) : blattTab === 'szenarien' ? (
                  szenarien
                ) : (
                  <EreignisPanel />
                )))
              )}
            </div>
          )}
        </section>
      ) : (
        // breite Bildschirme: links Kennzahlen und Touren, rechts die Auswahl, unten Uhr und Ereignisse
        <>
          <aside className="ls-links glas">
            {kennzahlen}
            {lageWarnung}
            <h3 className="abschnitt-titel">{G.touren}</h3>
            {tourenListe}
          </aside>
          {rechts && <aside className="ls-rechts glas">{rechts}</aside>}
          {s.vorschau && (
            <div className="ls-vorschau glas">
              <VorschauKarte />
            </div>
          )}
          <div className="ls-uhr glas">
            <Zeitleiste />
          </div>
          {ereignisse && (
            <aside className="ls-ereignisse glas">
              <EreignisPanel onSchliessen={() => setEreignisse(false)} />
            </aside>
          )}
        </>
      )}

      <Hinweise />
      {info && <InfoDialog onSchliessen={() => setInfo(false)} />}
    </div>
  );
}
