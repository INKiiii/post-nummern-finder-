import { G } from '../../glossar';
import { fmtDauer, fmtEuro, fmtKm, fmtUhr } from '../../core/format';
import { rechenwegTourKosten, rechenwegTourZeit } from '../../core/rechenweg';
import { behaelterSicht, fahrzeugSicht } from '../../core/sicht';
import { tourName } from '../../core/vorschlaege';
import { useAnsicht } from '../../state/ansicht';
import { useLeitstand } from '../../state/store';
import { waehleUndZeige } from '../aktionen';
import { WertKnopf } from '../Rechenweg';
import { Balken, PanelKopf, Zeile } from './Gemeinsam';

export function FahrzeugPanel({ tourId }: { tourId: string }) {
  const { ctx, plan, auswertung: aus, zeit } = useLeitstand();
  const waehlen = useAnsicht((s) => s.waehlen);
  if (!ctx || !plan || !aus) return null;
  const tour = ctx.tag.touren.find((t) => t.id === tourId)!;
  const fz = ctx.tag.fahrzeuge.find((f) => f.id === tour.fahrzeugId)!;
  const a = aus.touren[tourId];
  const s = fahrzeugSicht(ctx, plan, aus, tourId, zeit);
  const bs = behaelterSicht(ctx, plan, aus, zeit);
  const zuladen = a.ladung.filter((b) => bs[b].status === 'halle');
  return (
    <div className="panel">
      <PanelKopf titel={`${tourName(ctx, tourId)} · ${tour.pseudonym}`} unter={`${G.zustellfahrzeug} ${fz.id} (${fz.typ}) · ${G.rampe} ${tour.rampe}`} farbe={tour.farbe} onSchliessen={() => waehlen(null)} />
      <div className="status-zeile">{s.statusText}</div>

      {a.aktiv && (
        <>
          <div className="panel-abschnitt kacheln">
            <div className="kachel">
              <span className="leise">Abfahrt</span>
              <b>{a.abfahrt !== null ? fmtUhr(a.abfahrt) : '–'}</b>
            </div>
            <div className="kachel">
              <span className="leise">Rückkehr</span>
              <b>{fmtUhr(a.ende)}</b>
            </div>
            <div className="kachel">
              <span className="leise">Arbeitszeit</span>
              <b className={a.ueberstundenMin > 0.5 ? 'warnung' : ''}>
                <WertKnopf rechenweg={() => rechenwegTourZeit(ctx, a)}>{fmtDauer(a.dauer)}</WertKnopf>
              </b>
            </div>
            <div className="kachel">
              <span className="leise">Kosten/Tag</span>
              <b>
                <WertKnopf rechenweg={() => rechenwegTourKosten(ctx, a)}>{fmtEuro(a.kosten.summe, true)}</WertKnopf>
              </b>
            </div>
          </div>

          <div className="panel-abschnitt">
            <Zeile was="Auslastung der Schicht">
              <span className={s.auslastung > 1.005 ? 'warnung' : ''}>{Math.round(s.auslastung * 100)} %</span>
            </Zeile>
            <Balken anteil={s.auslastung} warnung={s.auslastung > 1.005} />
            {a.ueberstundenMin > 0.5 && <div className="warnung klein">{fmtDauer(a.ueberstundenMin)} über der Schicht</div>}
            <Zeile was="Fortschritt">{Math.round(s.fortschritt * 100)} %</Zeile>
            <Balken anteil={s.fortschritt} />
            {s.naechster && (
              <Zeile was="Nächster Stopp">
                {s.naechster.name} · {fmtUhr(s.naechster.ankunft)}
                {!s.naechster.vorOrt && <span className="leise"> (in {fmtDauer(Math.max(0, s.naechster.restMin))})</span>}
              </Zeile>
            )}
            <Zeile was="Strecke">{fmtKm(a.km.gesamt)}</Zeile>
          </div>

          <div className="panel-abschnitt">
            <h3>
              Ladung ({a.ladung.length} {G.behaelterPlural})
            </h3>
            <div className="chips">
              {a.zustellt.map((b) => (
                <button key={b} className="chip" style={{ borderColor: tour.farbe }} onClick={() => waehleUndZeige({ art: 'behaelter', id: b })}>
                  {b}
                </button>
              ))}
            </div>
            {zuladen.length > 0 && (
              <div className="leise klein" style={{ marginTop: 4 }}>
                {zuladen.length} davon stehen noch auf der {G.bereitstellflaeche}.
              </div>
            )}
          </div>

          <div className="panel-abschnitt">
            <h3>Route ({G.gangfolge})</h3>
            <ol className="route">
              <li className={zeit >= (a.abfahrt ?? a.start) ? 'erledigt' : ''}>
                <span className="uhr">{a.abfahrt !== null ? fmtUhr(a.abfahrt) : fmtUhr(a.start)}</span>
                <span>
                  Abfahrt {G.rampe} {tour.rampe}
                </span>
              </li>
              {a.schritte.map((x, i) => {
                const zustand = zeit >= x.ende ? 'erledigt' : zeit >= x.ankunft ? 'aktiv' : '';
                const name =
                  x.schritt.art === 'bezirk' ? ctx.welt.bezirke[ctx.tag.behaelter[x.schritt.behaelterId].zielbezirk].name : `${G.uebergabe}: ${G.treffpunkt} ${x.schritt.treffpunktName}`;
                return (
                  <li key={i} className={zustand}>
                    <span className="uhr">{fmtUhr(x.ankunft)}</span>
                    <span>
                      {x.schritt.art === 'bezirk' ? (
                        <button className="link" onClick={() => waehleUndZeige({ art: 'bezirk', id: ctx.tag.behaelter[(x.schritt as { behaelterId: string }).behaelterId].zielbezirk })}>
                          {name}
                        </button>
                      ) : (
                        name
                      )}
                      <span className="leise">
                        {' '}
                        bis {fmtUhr(x.ende)}
                        {x.schritt.art === 'bezirk' && ` · ${ctx.welt.bezirke[ctx.tag.behaelter[x.schritt.behaelterId].zielbezirk].stopps.length} ${G.stopps}`}
                      </span>
                    </span>
                  </li>
                );
              })}
              <li className={zeit >= a.ende ? 'erledigt' : ''}>
                <span className="uhr">{fmtUhr(a.ende)}</span>
                <span>Rückkehr {G.zustellbasis}</span>
              </li>
            </ol>
          </div>
        </>
      )}
    </div>
  );
}
