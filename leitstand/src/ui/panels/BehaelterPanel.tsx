import { G } from '../../glossar';
import { fmtDauer, fmtUhr, fmtZahl } from '../../core/format';
import { behaelterFolge, fahrMinuten, zustellMinuten } from '../../core/modell';
import { tourName } from '../../core/vorschlaege';
import { useAnsicht } from '../../state/ansicht';
import { useLeitstand } from '../../state/store';
import { waehleUndZeige } from '../aktionen';
import { AusScans, Balken, Geschaetzt, PanelKopf, STATUS_TEXT, Zeile } from './Gemeinsam';

export function BehaelterPanel({ id }: { id: string }) {
  const { ctx, plan, lage, annahmen } = useLeitstand();
  useLeitstand((s) => s.lageVersion);
  const waehlen = useAnsicht((s) => s.waehlen);
  if (!ctx || !plan || !lage) return null;
  const stamm = ctx.tag.behaelter[id];
  const b = lage.behaelter(id);
  const bz = ctx.welt.bezirke[stamm.zielbezirk];
  const bl = lage.bezirk(bz.id);
  const ort = ctx.welt.ortsteile.find((o) => o.id === bz.ortsteilId)!;
  const tour = ctx.tag.touren.find((t) => behaelterFolge(plan, t.id).includes(id));
  const folge = tour ? behaelterFolge(plan, tour.id) : [];
  const fz = b.fahrzeugId ? ctx.tag.touren.find((t) => t.fahrzeugId === b.fahrzeugId) : undefined;
  const z = zustellMinuten(stamm.inhalt, annahmen);
  const innen = fahrMinuten(bz.innenKm, annahmen.tempoImGebietKmh);
  const teil = tour ? lage.fahrzeug(tour.id).route.teile.find((x) => x.behaelterId === id) : undefined;
  return (
    <div className="panel">
      <PanelKopf titel={`${G.behaelter} ${id}`} unter={`${G.rollbehaelter} · ${STATUS_TEXT[b.status]}`} farbe={tour?.farbe} onSchliessen={() => waehlen(null)} />
      <div className="panel-abschnitt">
        <h3>Inhalt</h3>
        <div className="mengen">
          <div>
            <b>{fmtZahl(stamm.inhalt.pakete)}</b>
            <span>{G.pakete}</span>
          </div>
          <div>
            <b>{fmtZahl(stamm.inhalt.briefe)}</b>
            <span>{G.briefe}</span>
          </div>
          <div>
            <b>{fmtZahl(stamm.inhalt.zeitungen)}</b>
            <span>{G.zeitungen}</span>
          </div>
        </div>
      </div>
      <div className="panel-abschnitt">
        <h3>Wo ist der {G.behaelter}?</h3>
        <Zeile was="Status">{STATUS_TEXT[b.status]}</Zeile>
        <Zeile was="Position">
          {fz ? (
            <button className="link" onClick={() => waehleUndZeige({ art: 'fahrzeug', id: fz.id })}>
              im {G.fahrzeug} {b.fahrzeugId}
            </button>
          ) : (
            `${G.bereitstellflaeche}, ${G.rampe} ${tour?.rampe ?? '–'}`
          )}
        </Zeile>
        {b.quelle && (
          <Zeile was="Erkannt über">
            {b.quelle === 'barcode' ? 'Verladescan (Barcode am Behälter)' : 'Ladescans seiner Pakete'} <AusScans />
          </Zeile>
        )}
        <p className="leise klein" style={{ margin: '4px 0 0' }}>
          {G.behaelterPlural} haben keinen eigenen Tracker. Ihre Position ist die des {G.fahrzeug}s, in das sie verladen wurden.
        </p>
      </div>
      <div className="panel-abschnitt">
        <h3>Zustellung im Bezirk</h3>
        <Zeile was={G.pakete}>
          {bl.pakete.zugestellt} von {bl.pakete.gesamt} zugestellt{bl.pakete.nicht ? `, ${bl.pakete.nicht} nicht` : ''} <AusScans />
        </Zeile>
        <Balken anteil={bl.pakete.gesamt ? (bl.pakete.zugestellt + bl.pakete.nicht) / bl.pakete.gesamt : 0} />
        <Zeile was={G.briefe}>
          ca. {Math.round(bl.briefeAnteil * 100)} % <Geschaetzt />
        </Zeile>
        <Balken anteil={bl.briefeAnteil} geschaetzt />
        {bl.beginn !== null && (
          <Zeile was="Im Bezirk">
            {fmtUhr(bl.beginn)}–{bl.ende !== null ? fmtUhr(bl.ende) : '…'}
          </Zeile>
        )}
        {tour && teil && bl.beginn === null && (
          <Zeile was="Ankunft (Prognose)">{fmtUhr(lage.ankunftBei(tour.id, teil.s0))}</Zeile>
        )}
      </div>
      <div className="panel-abschnitt">
        <Zeile was="Ziel">
          <button className="link" onClick={() => waehleUndZeige({ art: 'bezirk', id: bz.id })}>
            {bz.name}
          </button>
        </Zeile>
        <Zeile was={G.ortsteil}>{ort.name}</Zeile>
        <Zeile was={G.stopps}>{bz.stopps.length}</Zeile>
        <Zeile was="Zeit im Bezirk (Plan)">
          {fmtDauer(innen + z.summe)} <span className="leise">({fmtDauer(innen)} Fahrt, {fmtDauer(z.summe)} Zustellung)</span>
        </Zeile>
        {tour ? (
          <>
            <Zeile was={G.tour}>
              <button className="link" onClick={() => waehleUndZeige({ art: 'fahrzeug', id: tour.id })}>
                {tourName(ctx, tour.id)} · {tour.pseudonym}
              </button>
            </Zeile>
            <Zeile was={G.rampe}>{tour.rampe}</Zeile>
            <Zeile was={`Position in der ${G.gangfolge}`}>
              {folge.indexOf(id) + 1} von {folge.length}
            </Zeile>
          </>
        ) : (
          <Zeile was={G.tour}>keine (bleibt heute liegen)</Zeile>
        )}
      </div>
    </div>
  );
}
