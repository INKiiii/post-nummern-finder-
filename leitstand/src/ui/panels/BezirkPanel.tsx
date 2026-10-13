import { G } from '../../glossar';
import { fmtDauer, fmtKm, fmtUhr } from '../../core/format';
import { behaelterFolge, fahrMinuten, zustellMinuten } from '../../core/modell';
import { tourName } from '../../core/vorschlaege';
import { useAnsicht } from '../../state/ansicht';
import { useLeitstand } from '../../state/store';
import { waehleUndZeige } from '../aktionen';
import { AusScans, Balken, Geschaetzt, PanelKopf, Zeile } from './Gemeinsam';

export function BezirkPanel({ id }: { id: string }) {
  const { ctx, plan, lage, annahmen } = useLeitstand();
  useLeitstand((s) => s.lageVersion);
  const waehlen = useAnsicht((s) => s.waehlen);
  if (!ctx || !plan || !lage) return null;
  const bz = ctx.welt.bezirke[id];
  const bl = lage.bezirk(id);
  const ort = ctx.welt.ortsteile.find((o) => o.id === bz.ortsteilId)!;
  const behaelter = ctx.tag.behaelterIds.filter((b) => ctx.tag.behaelter[b].zielbezirk === id);
  const haeuser = bz.stopps.reduce((n, s) => n + ctx.welt.stopps[s].haeuser.length, 0);
  const tour = ctx.tag.touren.find((t) => behaelter.some((b) => behaelterFolge(plan, t.id).includes(b)));
  return (
    <div className="panel">
      <PanelKopf titel={bz.name} unter={`${G.zustellbezirk} ${bz.id} · ${G.ortsteil} ${ort.name}`} farbe={tour?.farbe} onSchliessen={() => waehlen(null)} />
      <div className="panel-abschnitt">
        <h3>Fortschritt</h3>
        <Zeile was={G.pakete}>
          {bl.pakete.zugestellt} von {bl.pakete.gesamt}
          {bl.pakete.nicht ? ` (${bl.pakete.nicht} nicht zugestellt)` : ''} <AusScans />
        </Zeile>
        <Balken anteil={bl.pakete.gesamt ? (bl.pakete.zugestellt + bl.pakete.nicht) / bl.pakete.gesamt : 0} />
        <Zeile was={`${G.briefe} und ${G.zeitungen}`}>
          ca. {Math.round(bl.briefeAnteil * 100)} % <Geschaetzt />
        </Zeile>
        <Balken anteil={bl.briefeAnteil} geschaetzt />
        <Zeile was={G.stopps}>
          {bl.fertig ? bz.stopps.length : Math.max(0, bl.stoppIndex + (bl.stoppIndex >= 0 ? 0.5 : 0)).toLocaleString('de-DE')} von {bz.stopps.length} <Geschaetzt />
        </Zeile>
        {bl.beginn !== null && (
          <Zeile was="Begonnen / fertig">
            {fmtUhr(bl.beginn)} / {bl.ende !== null ? fmtUhr(bl.ende) : '…'}
          </Zeile>
        )}
      </div>
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
              <span className="leise">· {fmtDauer(z)} im Bezirk (Plan)</span>
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
      </div>
      <p className="leise klein">
        {G.briefe} werden nicht einzeln gescannt. Ihr Fortschritt ist aus der Position des {G.fahrzeug}s und der {G.gangfolge} geschätzt.
      </p>
    </div>
  );
}
