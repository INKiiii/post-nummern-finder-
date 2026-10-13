/**
 * Geräte-Ansicht im Stil einer einfachen Scanner-App (Hochformat, große Knöpfe, ohne Logos).
 * Läuft in einem eigenen Fenster und spricht nur über die Schnittstelle „FahrerGeraet“
 * (im Prototyp: BroadcastChannel) mit dem Leitstand.
 */
import { useEffect, useMemo, useState } from 'react';
import { G } from '../../glossar';
import { DemoTourDataSource } from '../../core/demoQuelle';
import { fmtUhr } from '../../core/format';
import type { PunktArt } from '../../core/benachrichtigung';
import type { FahrerNachricht } from '../../core/quellen';
import type { ScanEreignis } from '../../core/scan';
import { fmtUhrSek } from '../../core/scan';
import { paketeFuer, stoppAdresse, stoppMengen } from '../../core/sendungen';
import type { Tag, TourPlan, Welt } from '../../core/types';
import { ortName } from '../../core/uebergabe';
import { GeraeteKanal, type VonZentrale } from '../../geraet/kanal';

interface Daten {
  welt: Welt;
  tag: Tag;
}

export function ScannerApp({ tourId }: { tourId: string | null }) {
  const [daten, setDaten] = useState<Daten | null>(null);
  useEffect(() => {
    void new DemoTourDataSource().ladeTag().then(({ welt, tag }) => setDaten({ welt, tag }));
  }, []);
  return (
    <div className="geraet-huelle">
      <div className="geraet">{!daten ? <div className="geraet-leer">Lade …</div> : tourId ? <TourAnsicht daten={daten} tourId={tourId} /> : <TourWahl daten={daten} />}</div>
    </div>
  );
}

function TourWahl({ daten }: { daten: Daten }) {
  return (
    <div className="geraet-bildschirm">
      <div className="geraet-leiste">
        <b>Anmelden</b>
      </div>
      <div className="geraet-inhalt">
        <p className="geraet-hinweis">Für welche {G.tour} ist dieses Gerät?</p>
        <div className="geraet-raster">
          {daten.tag.touren.map((t) => (
            <a key={t.id} className="geraet-knopf" href={`#/fahrer/${t.id}`} style={{ ['--tourfarbe' as string]: t.farbe }}>
              {G.tour} {t.nr}
              <small>
                {t.fahrzeugId} · {G.rampe} {t.rampe}
              </small>
            </a>
          ))}
        </div>
        <p className="geraet-hinweis klein">Am besten neben dem {G.leitstand} öffnen (zweites Fenster im selben Browser).</p>
      </div>
    </div>
  );
}

type Seite = 'start' | 'stopps' | 'nachrichten' | 'scans';

function TourAnsicht({ daten, tourId }: { daten: Daten; tourId: string }) {
  const tour = daten.tag.touren.find((t) => t.id === tourId);
  const [plan, setPlan] = useState<TourPlan | null>(null);
  const [zeiten, setZeiten] = useState<Record<string, number>>({});
  const [scans, setScans] = useState<ScanEreignis[]>([]);
  const [uhr, setUhr] = useState<{ zeit: number; laeuft: boolean } | null>(null);
  const [nachrichten, setNachrichten] = useState<FahrerNachricht[]>([]);
  const [bestaetigt, setBestaetigt] = useState<Set<string>>(new Set());
  const [verbunden, setVerbunden] = useState(false);
  const [seite, setSeite] = useState<Seite>('start');
  const [kanal, setKanal] = useState<GeraeteKanal | null>(null);
  const [panne, setPanne] = useState<'frage' | 'gemeldet' | null>(null);

  useEffect(() => {
    const k = new GeraeteKanal(tourId, (m: VonZentrale) => {
      setVerbunden(true);
      switch (m.typ) {
        case 'tour':
          setPlan(m.plan);
          setZeiten(m.uebergabeZeiten ?? {});
          break;
        case 'scan':
          setScans((s) => [...s, m.e]);
          break;
        case 'zeit':
          setUhr({ zeit: m.zeit, laeuft: m.laeuft });
          break;
        case 'nachricht':
          setNachrichten((n) => (n.some((x) => x.id === m.n.id) ? n : [...n, m.n]));
          break;
        case 'verlauf':
          setScans(m.scans);
          setNachrichten(m.nachrichten);
          setBestaetigt(new Set(m.bestaetigt));
          break;
        case 'neustart':
          setScans([]);
          setNachrichten([]);
          setBestaetigt(new Set());
          k.anmelden();
          break;
      }
    });
    setKanal(k);
    k.anmelden();
    const leben = setInterval(() => k.lebenszeichen(), 5000);
    const nochmal = setInterval(() => {
      // falls der Leitstand erst später geöffnet wird
      setVerbunden((v) => {
        if (!v) k.anmelden();
        return v;
      });
    }, 2000);
    const tschuess = () => k.schliessen();
    window.addEventListener('beforeunload', tschuess);
    return () => {
      clearInterval(leben);
      clearInterval(nochmal);
      window.removeEventListener('beforeunload', tschuess);
      k.schliessen();
    };
  }, [tourId]);

  // ersetzte Umplanungen brauchen keine Bestätigung mehr
  const ersetzt = useMemo(() => new Set(nachrichten.flatMap((n) => n.ersetzt ?? [])), [nachrichten]);
  // Behälter, die mit einer (gültigen) Umplanung neu dazugekommen sind
  const neuDurchUmplanung = useMemo(
    () => new Set(nachrichten.filter((n) => !ersetzt.has(n.id)).flatMap((n) => (n.punkte ?? []).filter((p) => p.art === 'neu' && p.behaelterId).map((p) => p.behaelterId!))),
    [nachrichten, ersetzt],
  );

  // Stoppliste aus Plan und eigenen Scans, mit Übergaben an Treffpunkten dazwischen
  const zeilen = useMemo(() => {
    if (!plan) return [];
    const zugestellt = new Map<string, string>();
    for (const e of scans) if (e.art === 'ZUSTELLUNG' || e.art === 'NICHT_ZUGESTELLT') zugestellt.set(e.sendung, e.art);
    const liste: Zeile[] = [];
    for (const s of plan.schritte) {
      if (s.art === 'uebergabe') {
        const partner = daten.tag.touren.find((t) => t.id === s.partner);
        liste.push({ art: 'uebergabe', id: s.id, treffpunkt: s.treffpunktName, zeit: zeiten[s.id] ?? null, partner: partner ? `${G.tour} ${partner.nr}` : s.partner, abgeben: s.abgeben, aufnehmen: s.aufnehmen, erledigt: false });
        continue;
      }
      const b = daten.tag.behaelter[s.behaelterId];
      const bz = daten.welt.bezirke[b.zielbezirk];
      const mengen = stoppMengen(daten.welt, daten.tag, s.behaelterId);
      const pakete = paketeFuer(daten.welt, daten.tag, s.behaelterId);
      for (const st of bz.stopps) {
        const hier = pakete.filter((p) => p.stoppId === st);
        liste.push({
          art: 'stopp',
          stoppId: st,
          behaelterId: s.behaelterId,
          adresse: stoppAdresse(daten.welt, st),
          bezirk: bz.name,
          pakete: hier.length,
          offenePakete: hier.filter((p) => !zugestellt.has(p.id)).length,
          briefe: Math.round(mengen.get(st)!.briefe),
          erledigt: false,
        });
      }
    }
    // erledigt: alle Pakete gescannt oder ein späterer Stopp hatte schon einen Scan
    let letzter = -1;
    liste.forEach((x, i) => {
      if (x.art === 'stopp' && x.pakete > 0 && x.offenePakete < x.pakete) letzter = i;
    });
    // Übergabe erledigt: übernommene Behälter wurden unterwegs ins Fahrzeug gescannt
    const unterwegs = scans.findIndex((e) => e.art === 'TOUR_START');
    const umgeladen = new Set(scans.slice(unterwegs < 0 ? scans.length : unterwegs).flatMap((e) => (e.art === 'BEHAELTER_VERLADEN' ? [e.behaelter] : [])));
    liste.forEach((x, i) => {
      if (x.art === 'stopp') x.erledigt = i < letzter || (x.pakete > 0 && x.offenePakete === 0);
      else x.erledigt = i < letzter || (x.aufnehmen.length > 0 && x.aufnehmen.every((b) => umgeladen.has(b))) || (x.zeit !== null && !!uhr && uhr.zeit > x.zeit + 15);
    });
    return liste;
  }, [plan, scans, daten, zeiten, uhr]);

  const stopps = zeilen.filter((x): x is StoppZeile => x.art === 'stopp');
  const tourGestartet = scans.some((e) => e.art === 'TOUR_START');
  const tourEnde = scans.some((e) => e.art === 'TOUR_ENDE');
  const naechsteZeile = zeilen.find((x) => !x.erledigt);
  const naechster = stopps.find((x) => !x.erledigt);
  const offen = nachrichten.filter((n) => n.bestaetigungNoetig && !bestaetigt.has(n.id) && !ersetzt.has(n.id));
  const pakete = scans.filter((e) => e.art === 'PAKET_IN_FAHRZEUG').length;
  const zugestellt = scans.filter((e) => e.art === 'ZUSTELLUNG').length;
  const nicht = scans.filter((e) => e.art === 'NICHT_ZUGESTELLT').length;

  // Stoppliste: gleich beim nächsten Halt anfangen
  useEffect(() => {
    if (seite === 'stopps') document.querySelector('.geraet-liste .naechster')?.scrollIntoView({ block: 'center' });
  }, [seite]);

  if (!tour) return <div className="geraet-leer">Unbekannte {G.tour}</div>;

  return (
    <div className="geraet-bildschirm" style={{ ['--tourfarbe' as string]: tour.farbe }}>
      <div className="geraet-leiste">
        <b>
          {G.tour} {tour.nr}
        </b>
        <span>{tour.fahrzeugId}</span>
        <span className="geraet-uhr">{uhr ? fmtUhr(uhr.zeit) : '--:--'}</span>
        <span className={`geraet-punkt ${verbunden ? 'an' : ''}`} title={verbunden ? 'mit Leitstand verbunden' : 'keine Verbindung'} />
      </div>

      {!verbunden && <div className="geraet-warnung">Keine Verbindung zum {G.leitstand}. Bitte den {G.leitstand} im anderen Fenster öffnen.</div>}

      <div className="geraet-inhalt">
        {seite === 'start' && (
          <>
            {naechsteZeile?.art === 'uebergabe' && !tourEnde ? (
              <div className="geraet-karte gross uebergabe">
                <div className="geraet-klein">Nächster Halt: Übergabe{naechsteZeile.zeit !== null ? ` um ${fmtUhr(naechsteZeile.zeit)}` : ''}</div>
                <div className="geraet-adresse">{ortName(naechsteZeile.treffpunkt)}</div>
                <UebergabeText z={naechsteZeile} />
              </div>
            ) : (
              <div className="geraet-karte gross">
                <div className="geraet-klein">{tourEnde ? 'Tour beendet' : tourGestartet ? 'Nächster Stopp' : 'Vor der Abfahrt'}</div>
                {naechster && !tourEnde ? (
                  <>
                    <div className="geraet-adresse">
                      {naechster.adresse}
                      {neuDurchUmplanung.has(naechster.behaelterId) && <span className="geraet-neu">neu</span>}
                    </div>
                    <div className="geraet-klein">{naechster.bezirk}</div>
                    <div className="geraet-mengen">
                      <span>
                        <b>{naechster.offenePakete}</b> {naechster.offenePakete === 1 ? G.paket : G.pakete}
                      </span>
                      <span>
                        ca. <b>{naechster.briefe}</b> {G.briefe}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="geraet-adresse">{tourEnde ? 'Zurück an der Basis' : '–'}</div>
                )}
              </div>
            )}
            <div className="geraet-zahlen">
              <div>
                <b>{pakete}</b>
                <span>geladen</span>
              </div>
              <div>
                <b>{zugestellt}</b>
                <span>zugestellt</span>
              </div>
              <div>
                <b>{nicht}</b>
                <span>nicht zugestellt</span>
              </div>
            </div>
            <div className="geraet-raster">
              <button className="geraet-knopf" onClick={() => setSeite('stopps')}>
                Stoppliste
                <small>
                  {stopps.filter((x) => x.erledigt).length} von {stopps.length}
                </small>
              </button>
              <button className="geraet-knopf" onClick={() => setSeite('nachrichten')}>
                Nachrichten
                <small>{offen.length ? `${offen.length} neu` : `${nachrichten.length} gesamt`}</small>
              </button>
              <button className="geraet-knopf" onClick={() => setSeite('scans')}>
                Letzte Scans
                <small>{scans.length}</small>
              </button>
              <a className="geraet-knopf leise" href="#/fahrer">
                Abmelden
                <small>Tour wechseln</small>
              </a>
            </div>
            {tourGestartet && !tourEnde && (
              <div className="geraet-panne">
                {panne === null && (
                  <button className="geraet-knopf warnung" onClick={() => setPanne('frage')}>
                    Panne melden
                    <small>Fahrzeug kann nicht weiterfahren</small>
                  </button>
                )}
                {panne === 'frage' && (
                  <div className="geraet-karte">
                    <div className="geraet-klein">Panne wirklich melden? Der {G.leitstand} plant die {G.behaelterPlural} um.</div>
                    <div className="geraet-raster">
                      <button
                        className="geraet-knopf warnung"
                        onClick={() => {
                          kanal?.stoerungMelden();
                          setPanne('gemeldet');
                        }}
                      >
                        Ja, melden
                      </button>
                      <button className="geraet-knopf leise" onClick={() => setPanne(null)}>
                        Abbrechen
                      </button>
                    </div>
                  </div>
                )}
                {panne === 'gemeldet' && <div className="geraet-hinweis">Panne gemeldet. Bitte nach dem laufenden {G.bezirk} anhalten und auf Nachricht warten.</div>}
              </div>
            )}
          </>
        )}

        {seite === 'stopps' && (
          <Unterseite titel="Stoppliste" zurueck={() => setSeite('start')}>
            <ol className="geraet-liste">
              {zeilen.map((x, i) =>
                x.art === 'uebergabe' ? (
                  <li key={`u-${x.id}`} className={`uebergabe ${x.erledigt ? 'erledigt' : x === naechsteZeile ? 'naechster' : ''}`}>
                    <span className="haken">{x.erledigt ? '✓' : '⇄'}</span>
                    <span>
                      <b>
                        Übergabe{x.zeit !== null ? ` ${fmtUhr(x.zeit)}` : ''} · {x.treffpunkt}
                      </b>
                      <UebergabeText z={x} klein />
                    </span>
                  </li>
                ) : (
                  <li key={`${x.stoppId}-${i}`} className={x.erledigt ? 'erledigt' : x === naechsteZeile ? 'naechster' : ''}>
                    <span className="haken">{x.erledigt ? '✓' : stopps.indexOf(x) + 1}</span>
                    <span>
                      <b>
                        {x.adresse}
                        {neuDurchUmplanung.has(x.behaelterId) && <span className="geraet-neu">neu</span>}
                      </b>
                      <small>
                        {x.pakete ? `${x.pakete} ${x.pakete === 1 ? G.paket : G.pakete} · ` : ''}ca. {x.briefe} {G.briefe}
                      </small>
                    </span>
                  </li>
                ),
              )}
            </ol>
          </Unterseite>
        )}

        {seite === 'nachrichten' && (
          <Unterseite titel="Nachrichten" zurueck={() => setSeite('start')}>
            {nachrichten.length === 0 && <p className="geraet-hinweis">Keine Nachrichten.</p>}
            <ol className="geraet-liste">
              {[...nachrichten].reverse().map((n) => (
                <li key={n.id} className={ersetzt.has(n.id) ? 'erledigt' : ''}>
                  <span className="haken">{bestaetigt.has(n.id) ? '✓' : ersetzt.has(n.id) ? '–' : '!'}</span>
                  <span>
                    <b>{n.titel}</b>
                    <small>
                      {fmtUhr(n.zeit)} · {ersetzt.has(n.id) ? 'ersetzt durch eine neuere Umplanung' : n.punkte ? n.punkte.map((p) => p.text).join(' · ') : n.text}
                    </small>
                  </span>
                </li>
              ))}
            </ol>
          </Unterseite>
        )}

        {seite === 'scans' && (
          <Unterseite titel="Letzte Scans" zurueck={() => setSeite('start')}>
            <ol className="geraet-liste scans">
              {scans
                .filter((e) => e.art !== 'POSITION')
                .slice(-40)
                .reverse()
                .map((e) => (
                  <li key={e.nr}>
                    <span className="haken klein">{fmtUhrSek(e.zeit).slice(0, 5)}</span>
                    <span>
                      <b>{e.art.replace(/_/g, ' ')}</b>
                      <small>{'sendung' in e ? e.sendung : 'behaelter' in e ? `${G.behaelter} ${e.behaelter}` : tour.fahrzeugId}</small>
                    </span>
                  </li>
                ))}
            </ol>
          </Unterseite>
        )}
      </div>

      {offen.length > 0 && (
        <div className="geraet-meldung" role="alertdialog" aria-label="Neue Nachricht">
          <div className="geraet-klein">
            {offen[0].punkte ? 'Neue Umplanung' : 'Neue Nachricht'} vom {G.leitstand} · {fmtUhr(offen[0].zeit)}
          </div>
          <div className="geraet-meldung-titel">{offen[0].titel}</div>
          {offen[0].punkte ? (
            <ul className="geraet-punkte">
              {offen[0].punkte.map((p, i) => (
                <li key={i} className={`punkt-${p.art}`}>
                  <span className="symbol">{SYMBOL[p.art]}</span>
                  <span>{p.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="geraet-meldung-text">{offen[0].text}</div>
          )}
          <button
            className="geraet-verstanden"
            onClick={() => {
              kanal?.bestaetigen(offen[0].id, uhr?.zeit ?? offen[0].zeit);
              setBestaetigt((b) => new Set([...b, offen[0].id]));
            }}
          >
            Verstanden
          </button>
        </div>
      )}
    </div>
  );
}

function Unterseite({ titel, zurueck, children }: { titel: string; zurueck: () => void; children: React.ReactNode }) {
  return (
    <div className="geraet-unterseite">
      <button className="geraet-zurueck" onClick={zurueck}>
        ‹ {titel}
      </button>
      {children}
    </div>
  );
}

interface StoppZeile {
  art: 'stopp';
  stoppId: number;
  behaelterId: string;
  adresse: string;
  bezirk: string;
  pakete: number;
  offenePakete: number;
  briefe: number;
  erledigt: boolean;
}

interface UebergabeZeile {
  art: 'uebergabe';
  id: string;
  treffpunkt: string;
  zeit: number | null;
  partner: string;
  abgeben: string[];
  aufnehmen: string[];
  erledigt: boolean;
}

type Zeile = StoppZeile | UebergabeZeile;

const SYMBOL: Record<PunktArt, string> = {
  neu: '+',
  abgeben: '→',
  entfaellt: '−',
  bleibt: '•',
  uebergabeEntfaellt: '×',
  reihenfolge: '↕',
  tourEntfaellt: '×',
  tourNeu: '+',
};

/** Was bei einer Übergabe zu tun ist */
function UebergabeText({ z, klein = false }: { z: UebergabeZeile; klein?: boolean }) {
  const teile = [
    z.abgeben.length ? `${G.behaelter} ${z.abgeben.join(', ')} abgeben an ${z.partner}` : '',
    z.aufnehmen.length ? `${G.behaelter} ${z.aufnehmen.join(', ')} übernehmen von ${z.partner}` : '',
  ].filter(Boolean);
  return klein ? <small>{teile.join(' · ')}</small> : <div className="geraet-klein">{teile.join(' · ')}</div>;
}
