import { G } from '../../glossar';
import { fmtDauer, fmtUhr, fmtZahl } from '../../core/format';
import { behaelterFolge, fahrMinuten, zustellMinuten } from '../../core/modell';
import { behaelterSicht } from '../../core/sicht';
import { tourName } from '../../core/vorschlaege';
import { useAnsicht } from '../../state/ansicht';
import { useLeitstand } from '../../state/store';
import { waehleUndZeige } from '../aktionen';
import { PanelKopf, STATUS_TEXT, Zeile } from './Gemeinsam';

export function BehaelterPanel({ id }: { id: string }) {
  const { ctx, plan, auswertung: aus, zeit, annahmen } = useLeitstand();
  const waehlen = useAnsicht((s) => s.waehlen);
  if (!ctx || !plan || !aus) return null;
  const b = behaelterSicht(ctx, plan, aus, zeit)[id];
  const bz = ctx.welt.bezirke[b.zielbezirk];
  const ort = ctx.welt.ortsteile.find((o) => o.id === bz.ortsteilId)!;
  const tour = ctx.tag.touren.find((t) => t.id === b.tourId);
  const folge = tour ? behaelterFolge(plan, tour.id) : [];
  const schritt = tour ? aus.touren[tour.id].schritte.find((s) => s.schritt.art === 'bezirk' && s.schritt.behaelterId === id) : undefined;
  const z = zustellMinuten(b.inhalt, annahmen);
  const innen = fahrMinuten(bz.innenKm, annahmen.tempoImGebietKmh);
  return (
    <div className="panel">
      <PanelKopf
        titel={
          <>
            {G.behaelter} {id}
          </>
        }
        unter={`${G.rollbehaelter} · ${STATUS_TEXT[b.status]}`}
        farbe={tour?.farbe}
        onSchliessen={() => waehlen(null)}
      />
      <div className="panel-abschnitt">
        <h3>Inhalt</h3>
        <div className="mengen">
          <div>
            <b>{fmtZahl(b.inhalt.pakete)}</b>
            <span>{G.pakete}</span>
          </div>
          <div>
            <b>{fmtZahl(b.inhalt.briefe)}</b>
            <span>{G.briefe}</span>
          </div>
          <div>
            <b>{fmtZahl(b.inhalt.zeitungen)}</b>
            <span>{G.zeitungen}</span>
          </div>
        </div>
      </div>
      <div className="panel-abschnitt">
        <Zeile was="Ziel">
          <button className="link" onClick={() => waehleUndZeige({ art: 'bezirk', id: bz.id })}>
            {bz.name}
          </button>
        </Zeile>
        <Zeile was={G.ortsteil}>{ort.name}</Zeile>
        <Zeile was={G.stopps}>{bz.stopps.length}</Zeile>
        <Zeile was="Zeit im Bezirk">
          {fmtDauer(innen + z.summe)} <span className="leise">({fmtDauer(innen)} Fahrt, {fmtDauer(z.summe)} Zustellung)</span>
        </Zeile>
      </div>
      <div className="panel-abschnitt">
        {tour ? (
          <>
            <Zeile was={G.tour}>
              <button className="link" onClick={() => waehleUndZeige({ art: 'fahrzeug', id: tour.id })}>
                {tourName(ctx, tour.id)} · {tour.pseudonym}
              </button>
            </Zeile>
            <Zeile was={G.rampe}>{tour.rampe}</Zeile>
            <Zeile was={`Position in der ${G.gangfolge}`}>
              {b.gangfolgePos} von {folge.length}
            </Zeile>
            {schritt && (
              <Zeile was="Zustellung geplant">
                {fmtUhr(schritt.ankunft)}–{fmtUhr(schritt.ende)}
              </Zeile>
            )}
          </>
        ) : (
          <Zeile was={G.tour}>keine (bleibt heute liegen)</Zeile>
        )}
        <Zeile was="Status">{STATUS_TEXT[b.status]}</Zeile>
      </div>
    </div>
  );
}
