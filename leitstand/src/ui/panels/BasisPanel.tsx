import { G } from '../../glossar';
import { behaelterSicht } from '../../core/sicht';
import { useAnsicht } from '../../state/ansicht';
import { useLeitstand } from '../../state/store';
import { basisZeigen } from '../aktionen';
import { PanelKopf, Zeile } from './Gemeinsam';

export function BasisPanel() {
  const { ctx, plan, auswertung: aus, zeit } = useLeitstand();
  const waehlen = useAnsicht((s) => s.waehlen);
  if (!ctx || !plan || !aus) return null;
  const sicht = Object.values(behaelterSicht(ctx, plan, aus, zeit));
  const anRampe = ctx.tag.touren.filter((t) => {
    const a = aus.touren[t.id];
    return !a.aktiv || a.abfahrt === null || zeit < a.abfahrt || zeit >= a.ende;
  }).length;
  return (
    <div className="panel">
      <PanelKopf titel={ctx.welt.basis.name} unter={`${G.halle}, ${ctx.welt.basis.rampen.length} ${G.rampen}, ${G.bereitstellflaeche}, ${G.parkplaetze}`} onSchliessen={() => waehlen(null)} />
      <div className="panel-abschnitt">
        <Zeile was={`${G.behaelterPlural} in der ${G.halle}`}>{sicht.filter((b) => b.status === 'halle').length}</Zeile>
        <Zeile was="Verladen">{sicht.filter((b) => b.status === 'verladen').length}</Zeile>
        <Zeile was="Unterwegs">{sicht.filter((b) => b.status === 'unterwegs').length}</Zeile>
        <Zeile was="Zugestellt">{sicht.filter((b) => b.status === 'zugestellt').length}</Zeile>
        <Zeile was={`${G.fahrzeuge} an der Basis`}>
          {anRampe} von {ctx.tag.touren.length}
        </Zeile>
      </div>
      <button className="knopf" onClick={basisZeigen}>
        {G.rampen} zeigen
      </button>
    </div>
  );
}
