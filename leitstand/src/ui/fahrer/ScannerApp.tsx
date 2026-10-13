/**
 * Geräte-Ansicht im Stil einer einfachen Scanner-App (Hochformat, große Knöpfe, ohne Logos).
 * Läuft in einem eigenen Fenster und spricht nur über die Schnittstelle „FahrerGeraet“
 * (im Prototyp: BroadcastChannel) mit dem Leitstand.
 */
import { useEffect, useMemo, useState } from 'react';
import { G } from '../../glossar';
import { DemoTourDataSource } from '../../core/demoQuelle';
import { fmtUhr } from '../../core/format';
import type { FahrerNachricht } from '../../core/quellen';
import type { ScanEreignis } from '../../core/scan';
import { fmtUhrSek } from '../../core/scan';
import { paketeFuer, stoppAdresse, stoppMengen } from '../../core/sendungen';
import type { Tag, TourPlan, Welt } from '../../core/types';
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
  const [scans, setScans] = useState<ScanEreignis[]>([]);
  const [uhr, setUhr] = useState<{ zeit: number; laeuft: boolean } | null>(null);
  const [nachrichten, setNachrichten] = useState<FahrerNachricht[]>([]);
  const [bestaetigt, setBestaetigt] = useState<Set<string>>(new Set());
  const [verbunden, setVerbunden] = useState(false);
  const [seite, setSeite] = useState<Seite>('start');
  const [kanal, setKanal] = useState<GeraeteKanal | null>(null);

  useEffect(() => {
    const k = new GeraeteKanal(tourId, (m: VonZentrale) => {
      setVerbunden(true);
      switch (m.typ) {
        case 'tour':
          setPlan(m.plan);
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

  // Stoppliste aus Plan und eigenen Scans
  const stopps = useMemo(() => {
    if (!plan) return [];
    const zugestellt = new Map<string, string>();
    for (const e of scans) if (e.art === 'ZUSTELLUNG' || e.art === 'NICHT_ZUGESTELLT') zugestellt.set(e.sendung, e.art);
    const liste: Array<{ stoppId: number; adresse: string; bezirk: string; pakete: number; offenePakete: number; briefe: number; erledigt: boolean }> = [];
    for (const s of plan.schritte) {
      if (s.art !== 'bezirk') continue;
      const b = daten.tag.behaelter[s.behaelterId];
      const bz = daten.welt.bezirke[b.zielbezirk];
      const mengen = stoppMengen(daten.welt, daten.tag, s.behaelterId);
      const pakete = paketeFuer(daten.welt, daten.tag, s.behaelterId);
      for (const st of bz.stopps) {
        const hier = pakete.filter((p) => p.stoppId === st);
        liste.push({
          stoppId: st,
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
      if (x.pakete > 0 && x.offenePakete < x.pakete) letzter = i;
    });
    liste.forEach((x, i) => {
      x.erledigt = i < letzter || (x.pakete > 0 && x.offenePakete === 0);
    });
    return liste;
  }, [plan, scans, daten]);

  const tourGestartet = scans.some((e) => e.art === 'TOUR_START');
  const tourEnde = scans.some((e) => e.art === 'TOUR_ENDE');
  const naechster = stopps.find((x) => !x.erledigt);
  const offen = nachrichten.filter((n) => n.bestaetigungNoetig && !bestaetigt.has(n.id));
  const pakete = scans.filter((e) => e.art === 'PAKET_IN_FAHRZEUG').length;
  const zugestellt = scans.filter((e) => e.art === 'ZUSTELLUNG').length;
  const nicht = scans.filter((e) => e.art === 'NICHT_ZUGESTELLT').length;

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
            <div className="geraet-karte gross">
              <div className="geraet-klein">{tourEnde ? 'Tour beendet' : tourGestartet ? 'Nächster Stopp' : 'Vor der Abfahrt'}</div>
              {naechster && !tourEnde ? (
                <>
                  <div className="geraet-adresse">{naechster.adresse}</div>
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
          </>
        )}

        {seite === 'stopps' && (
          <Unterseite titel="Stoppliste" zurueck={() => setSeite('start')}>
            <ol className="geraet-liste">
              {stopps.map((x, i) => (
                <li key={`${x.stoppId}-${i}`} className={x.erledigt ? 'erledigt' : x === naechster ? 'naechster' : ''}>
                  <span className="haken">{x.erledigt ? '✓' : i + 1}</span>
                  <span>
                    <b>{x.adresse}</b>
                    <small>
                      {x.pakete ? `${x.pakete} ${x.pakete === 1 ? G.paket : G.pakete} · ` : ''}ca. {x.briefe} {G.briefe}
                    </small>
                  </span>
                </li>
              ))}
            </ol>
          </Unterseite>
        )}

        {seite === 'nachrichten' && (
          <Unterseite titel="Nachrichten" zurueck={() => setSeite('start')}>
            {nachrichten.length === 0 && <p className="geraet-hinweis">Keine Nachrichten.</p>}
            <ol className="geraet-liste">
              {[...nachrichten].reverse().map((n) => (
                <li key={n.id}>
                  <span className="haken">{bestaetigt.has(n.id) ? '✓' : '!'}</span>
                  <span>
                    <b>{n.titel}</b>
                    <small>
                      {fmtUhr(n.zeit)} · {n.text}
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
          <div className="geraet-klein">Neue Nachricht vom {G.leitstand}</div>
          <div className="geraet-meldung-titel">{offen[0].titel}</div>
          <div className="geraet-meldung-text">{offen[0].text}</div>
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
