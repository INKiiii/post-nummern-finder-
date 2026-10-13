import { useMemo, useState } from 'react';
import { G } from '../glossar';
import { fmtDauer, fmtDeltaEuro, fmtDeltaKm, fmtEuro, fmtKm, fmtUhr, fmtZahl } from '../core/format';
import { behaelterFolge } from '../core/modell';
import { rechenwegErsparnis, rechenwegPlanKosten, rechenwegTourKosten, rechenwegTourZeit } from '../core/rechenweg';
import { optionenFuerBehaelter, tourName } from '../core/vorschlaege';
import { useLeitstand } from '../state/store';
import { AnnahmenPanel } from './AnnahmenPanel';
import { KarteSvg } from './KarteSvg';
import { WertKnopf } from './Rechenweg';
import { VorschlagKarte } from './VorschlagKarte';

/**
 * Prüfansicht für den Rechenkern (Phase 1): Demo-Welt als 2D-Karte, Touren mit Zeit und
 * Kosten, Vorschläge des Optimierers und „Andere Tour“ für einzelne Behälter.
 */
export function KernAnsicht() {
  const s = useLeitstand();
  const [hervor, setHervor] = useState<string | null>(null);
  const [behaelter, setBehaelter] = useState<string | null>(null);
  const { ctx, plan, auswertung: aus, startAuswertung: start } = s;

  const optionen = useMemo(() => (ctx && plan && behaelter ? optionenFuerBehaelter(ctx, plan, behaelter) : []), [ctx, plan, behaelter]);

  if (!ctx || !plan || !aus || !start) return <div style={{ padding: 24 }}>Lade Demo-Welt …</div>;

  const ersparnisSeitStart = start.summe.kosten.summe - aus.summe.kosten.summe;
  const deltaStart = {
    km: aus.summe.km - start.summe.km,
    arbeitMin: aus.summe.arbeitMin - start.summe.arbeitMin,
    bezahltMin: aus.summe.bezahltMin - start.summe.bezahltMin,
    ueberstundenMin: aus.summe.ueberstundenMin - start.summe.ueberstundenMin,
    euroTag: ersparnisSeitStart,
    euroJahr: ersparnisSeitStart * s.annahmen.zustelltageProJahr,
    aktiveTouren: aus.summe.aktiveTouren - start.summe.aktiveTouren,
    betroffen: aus.tourIds,
    liegen: 0,
  };

  return (
    <>
      <header className="kopf">
        <div className="titel">
          <h1>Zustell-{G.leitstand} 3D · Prototyp</h1>
          <div className="leise" style={{ fontSize: 13 }}>
            Phase 1: Rechenkern mit Demo-Welt „{ctx.welt.name}“ · alle Daten erfunden · {ctx.tag.datum}
          </div>
        </div>
        <div className="aktionen">
          <button className="knopf" onClick={s.rueckgaengig} disabled={s.verlaufIndex <= 0} title="Rückgängig">
            ↶ Rückgängig
          </button>
          <button className="knopf" onClick={s.wiederholen} disabled={s.verlaufIndex >= s.verlauf.length - 1} title="Wiederholen">
            ↷ Wiederholen
          </button>
          <button className="knopf" onClick={s.zumStartplan} disabled={plan === s.startplan}>
            Startplan
          </button>
        </div>
      </header>

      <main className="raster">
        <section>
          <div className="karte">
            <div className="karte-kopf">
              <h2>Kennzahlen des aktuellen Plans</h2>
              <span className="leise" style={{ fontSize: 12 }}>
                Stand: {s.verlauf[s.verlaufIndex]?.label}
              </span>
            </div>
            <div className="kennzahlen">
              <div className="kennzahl">
                <div className="label">Kosten je Tag</div>
                <div className="wert">
                  <WertKnopf rechenweg={() => rechenwegPlanKosten(ctx, aus)}>{fmtEuro(aus.summe.kosten.summe)}</WertKnopf>
                </div>
                <div className={`vergleich ${ersparnisSeitStart > 0.005 ? 'gut' : 'leise'}`}>
                  {Math.abs(ersparnisSeitStart) > 0.005 ? (
                    <WertKnopf rechenweg={() => rechenwegErsparnis(ctx, start, aus, deltaStart)}>{fmtDeltaEuro(-ersparnisSeitStart)} ggü. Start</WertKnopf>
                  ) : (
                    'wie Startplan'
                  )}
                </div>
              </div>
              <div className="kennzahl">
                <div className="label">Ersparnis je Jahr</div>
                <div className={`wert ${ersparnisSeitStart > 0.005 ? 'gut' : ''}`}>
                  <WertKnopf rechenweg={() => rechenwegErsparnis(ctx, start, aus, deltaStart)}>{fmtEuro(Math.max(0, deltaStart.euroJahr), true)}</WertKnopf>
                </div>
                <div className="vergleich leise">× {fmtZahl(s.annahmen.zustelltageProJahr)} Zustelltage</div>
              </div>
              <div className="kennzahl">
                <div className="label">Aktive {G.touren}</div>
                <div className="wert">{aus.summe.aktiveTouren}</div>
                <div className="vergleich leise">{fmtKm(aus.summe.km)} gesamt</div>
              </div>
              <div className="kennzahl">
                <div className="label">Überstunden</div>
                <div className={`wert ${aus.summe.ueberstundenMin > 0.5 ? 'warnung' : 'gut'}`}>{fmtDauer(aus.summe.ueberstundenMin)}</div>
                <div className="vergleich leise">Arbeitszeit {fmtDauer(aus.summe.arbeitMin)}</div>
              </div>
            </div>
            {!aus.gueltig && <div className="schlecht" style={{ marginTop: 8 }}>{aus.fehler.join(' ')}</div>}
          </div>

          <div className="karte">
            <div className="karte-kopf">
              <h2>{ctx.welt.name}: {ctx.welt.ortsteile.length} {G.ortsteile}, {ctx.welt.bezirkIds.length} {G.zustellbezirke}</h2>
            </div>
            <KarteSvg ctx={ctx} plan={plan} aus={aus} hervor={hervor} />
            <div className="legende">
              {ctx.tag.touren.map((t) => (
                <span key={t.id} className="tour-marke" style={{ ['--tourfarbe' as string]: t.farbe }} onMouseEnter={() => setHervor(t.id)} onMouseLeave={() => setHervor(null)}>
                  {tourName(ctx, t.id)}
                </span>
              ))}
              <span className="leise">○ {G.treffpunkt} · ■ {G.zustellbasis}</span>
            </div>
          </div>

          <div className="karte">
            <div className="karte-kopf">
              <h2>{G.touren}</h2>
              <span className="leise" style={{ fontSize: 12 }}>
                {G.behaelter} antippen → „Andere {G.tour}“
              </span>
            </div>
            <div className="tabelle-huelle">
              <table className="tabelle">
                <thead>
                  <tr>
                    <th>{G.tour}</th>
                    <th>{G.behaelterPlural} in {G.gangfolge}</th>
                    <th className="r">Rückkehr</th>
                    <th className="r">Zeit</th>
                    <th className="r">km</th>
                    <th className="r">Kosten</th>
                  </tr>
                </thead>
                <tbody>
                  {ctx.tag.touren.map((t) => {
                    const a = aus.touren[t.id];
                    return (
                      <tr key={t.id} onMouseEnter={() => setHervor(t.id)} onMouseLeave={() => setHervor(null)}>
                        <td>
                          <span className="tour-marke" style={{ ['--tourfarbe' as string]: t.farbe }}>
                            {tourName(ctx, t.id)}
                          </span>
                          <div className="leise" style={{ fontSize: 12 }}>
                            {t.pseudonym} · {G.rampe} {t.rampe}
                          </div>
                        </td>
                        <td>
                          <div className="chips">
                            {behaelterFolge(plan, t.id).map((b) => (
                              <button key={b} className="chip" onClick={() => setBehaelter(b)} style={b === behaelter ? { borderColor: t.farbe } : undefined}>
                                {b}
                              </button>
                            ))}
                            {!a.aktiv && <span className="leise">entfällt</span>}
                          </div>
                        </td>
                        <td className="r zahlen">{a.aktiv ? fmtUhr(a.ende) : '–'}</td>
                        <td className={`r ${a.ueberstundenMin > 0.5 ? 'warnung' : ''}`}>
                          {a.aktiv ? <WertKnopf rechenweg={() => rechenwegTourZeit(ctx, a)}>{fmtDauer(a.dauer)}</WertKnopf> : '–'}
                        </td>
                        <td className="r zahlen">{a.aktiv ? fmtKm(a.km.gesamt) : '–'}</td>
                        <td className="r">
                          <WertKnopf rechenweg={() => rechenwegTourKosten(ctx, a)}>{fmtEuro(a.kosten.summe)}</WertKnopf>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {behaelter && (
              <BehaelterOptionen
                id={behaelter}
                optionen={optionen}
                onSchliessen={() => setBehaelter(null)}
                onWahl={(o) => {
                  s.planSetzen(o.plan, `${G.behaelter} ${behaelter} → ${tourName(ctx, o.tourId)}`);
                  setBehaelter(null);
                }}
              />
            )}
          </div>
        </section>

        <section>
          <div className="karte">
            <div className="karte-kopf">
              <h2>Vorschläge</h2>
              <span className="leise" style={{ fontSize: 12 }}>
                {s.vorschlaegeLaden ? 'rechnet …' : `${s.vorschlaege.length} gefunden`}
              </span>
            </div>
            {s.vorschlaege.length === 0 && !s.vorschlaegeLaden && <div className="leise">Keine Verbesserung gefunden. Der Plan ist gut.</div>}
            {s.vorschlaege.map((v) => (
              <VorschlagKarte key={v.id} v={v} ctx={ctx} onUebernehmen={() => s.planSetzen(v.plan, v.titel)} />
            ))}
          </div>

          <div className="karte">
            <div className="karte-kopf">
              <h2>Annahmen</h2>
            </div>
            <AnnahmenPanel />
            <div className="hinweis-box">Beispielrechnung mit erfundenen Daten. Die Zahlen zeigen das Prinzip, keine echten Kosten eines Betriebs.</div>
          </div>
        </section>
      </main>
    </>
  );
}

function BehaelterOptionen({
  id,
  optionen,
  onSchliessen,
  onWahl,
}: {
  id: string;
  optionen: ReturnType<typeof optionenFuerBehaelter>;
  onSchliessen: () => void;
  onWahl: (o: ReturnType<typeof optionenFuerBehaelter>[number]) => void;
}) {
  const ctx = useLeitstand((s) => s.ctx)!;
  const b = ctx.tag.behaelter[id];
  const bz = ctx.welt.bezirke[b.zielbezirk];
  return (
    <div className="vorschlag" style={{ marginTop: 12 }}>
      <div className="karte-kopf">
        <div>
          <div className="art">
            {G.behaelter} {id} · {bz.name}
          </div>
          <div className="leise" style={{ fontSize: 13 }}>
            {fmtZahl(b.inhalt.pakete)} {G.pakete} · {fmtZahl(b.inhalt.briefe)} {G.briefe} · {fmtZahl(b.inhalt.zeitungen)} {G.zeitungen}
          </div>
        </div>
        <button className="knopf klein" onClick={onSchliessen}>
          Schließen
        </button>
      </div>
      <h3 style={{ margin: '4px 0 6px' }}>Andere {G.tour}</h3>
      <div className="tabelle-huelle">
        <table className="tabelle">
          <thead>
            <tr>
              <th>{G.tour}</th>
              <th className="r">Dauer danach</th>
              <th className="r">Δ km</th>
              <th className="r">Δ €/Jahr</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {optionen.map((o) => (
              <tr key={o.tourId}>
                <td>
                  {tourName(ctx, o.tourId)}
                  {o.aktuell && <span className="leise"> (aktuell)</span>}
                  {o.beste && <div className="gut" style={{ fontSize: 12, fontWeight: 650 }}>Beste Wahl</div>}
                </td>
                <td className={`r zahlen ${o.ueberstundenDanach > 0.5 ? 'warnung' : ''}`}>{fmtDauer(o.dauerDanach)}</td>
                <td className="r zahlen">{o.aktuell ? '–' : fmtDeltaKm(o.delta.km)}</td>
                <td className={`r zahlen ${o.delta.euroJahr > 0.5 ? 'gut' : o.delta.euroJahr < -0.5 ? 'schlecht' : ''}`}>{o.aktuell ? '–' : fmtDeltaEuro(-o.delta.euroJahr, true)}</td>
                <td className="r">
                  {!o.aktuell && (
                    <button className={`knopf klein ${o.beste ? 'primaer' : ''}`} onClick={() => onWahl(o)} disabled={!o.machbar && !o.beste}>
                      {o.machbar ? 'Wählen' : 'Schicht reicht nicht'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
