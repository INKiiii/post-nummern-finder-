import { G } from '../../glossar';
import { fmtDauer, fmtKm, fmtUhr } from '../../core/format';
import { behaelterFolge, fahrMinuten, zustellMinuten } from '../../core/modell';
import { tourName } from '../../core/vorschlaege';
import { useAnsicht } from '../../state/ansicht';
import { useLeitstand } from '../../state/store';
import { waehleUndZeige } from '../aktionen';
import { PanelKopf, Zeile } from './Gemeinsam';

export function BezirkPanel({ id }: { id: string }) {
  const { ctx, plan, auswertung: aus, annahmen } = useLeitstand();
  const waehlen = useAnsicht((s) => s.waehlen);
  if (!ctx || !plan || !aus) return null;
  const bz = ctx.welt.bezirke[id];
  const ort = ctx.welt.ortsteile.find((o) => o.id === bz.ortsteilId)!;
  const behaelter = ctx.tag.behaelterIds.filter((b) => ctx.tag.behaelter[b].zielbezirk === id);
  const haeuser = bz.stopps.reduce((n, s) => n + ctx.welt.stopps[s].haeuser.length, 0);
  const tour = ctx.tag.touren.find((t) => behaelter.some((b) => behaelterFolge(plan, t.id).includes(b)));
  const schritt = tour ? aus.touren[tour.id].schritte.find((s) => s.schritt.art === 'bezirk' && behaelter.includes(s.schritt.behaelterId)) : undefined;
  return (
    <div className="panel">
      <PanelKopf titel={bz.name} unter={`${G.zustellbezirk} ${bz.id} · ${G.ortsteil} ${ort.name}`} farbe={tour?.farbe} onSchliessen={() => waehlen(null)} />
      <div className="panel-abschnitt">
        <Zeile was={G.stopps}>{bz.stopps.length}</Zeile>
        <Zeile was="Häuser">{haeuser}</Zeile>
        <Zeile was="Weg im Bezirk">{fmtKm(bz.innenKm)}</Zeile>
        <Zeile was="Straßen">{bz.strassen.join(', ')}</Zeile>
      </div>
      <div className="panel-abschnitt">
        {behaelter.map((b) => {
          const z = zustellMinuten(ctx.tag.behaelter[b].inhalt, annahmen).summe + fahrMinuten(bz.innenKm, annahmen.tempoImGebietKmh);
          return (
            <Zeile key={b} was={G.behaelter}>
              <button className="link" onClick={() => waehleUndZeige({ art: 'behaelter', id: b })}>
                {b}
              </button>{' '}
              <span className="leise">· {fmtDauer(z)} im Bezirk</span>
            </Zeile>
          );
        })}
        {tour ? (
          <Zeile was={G.tour}>
            <button className="link" onClick={() => waehleUndZeige({ art: 'fahrzeug', id: tour.id })}>
              {tourName(ctx, tour.id)} · {tour.pseudonym}
            </button>
          </Zeile>
        ) : (
          <Zeile was={G.tour}>keine</Zeile>
        )}
        {schritt && (
          <Zeile was="Geplant">
            {fmtUhr(schritt.ankunft)}–{fmtUhr(schritt.ende)}
          </Zeile>
        )}
      </div>
      <p className="leise klein">Die Häuser sind erfunden; jedes Haus steht für einen {G.stopp} mit mehreren Haushalten.</p>
    </div>
  );
}
