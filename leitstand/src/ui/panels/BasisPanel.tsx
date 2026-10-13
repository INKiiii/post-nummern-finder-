import { G } from '../../glossar';
import { useAnsicht } from '../../state/ansicht';
import { useLeitstand } from '../../state/store';
import { basisZeigen } from '../aktionen';
import { AusScans, PanelKopf, Zeile } from './Gemeinsam';

export function BasisPanel() {
  const { ctx, lage } = useLeitstand();
  useLeitstand((s) => s.lageVersion);
  const waehlen = useAnsicht((s) => s.waehlen);
  if (!ctx || !lage) return null;
  const status = ctx.tag.behaelterIds.map((b) => lage.behaelter(b).status);
  const zaehle = (s: string) => status.filter((x) => x === s).length;
  const anRampe = ctx.tag.touren.filter((t) => lage.fahrzeug(t.id).phase !== 'unterwegs').length;
  return (
    <div className="panel">
      <PanelKopf titel={ctx.welt.basis.name} unter={`${G.halle}, ${ctx.welt.basis.rampen.length} ${G.rampen}, ${G.bereitstellflaeche}, ${G.parkplaetze}`} onSchliessen={() => waehlen(null)} />
      <div className="panel-abschnitt">
        <h3>
          {G.behaelterPlural} <AusScans />
        </h3>
        <Zeile was={`In der ${G.halle}`}>{zaehle('halle')}</Zeile>
        <Zeile was="Verladen">{zaehle('verladen')}</Zeile>
        <Zeile was="Unterwegs">{zaehle('unterwegs')}</Zeile>
        <Zeile was="Zugestellt">{zaehle('zugestellt')}</Zeile>
        <Zeile was={`${G.fahrzeuge} an der Basis`}>
          {anRampe} von {ctx.tag.touren.length}
        </Zeile>
        <Zeile was="Pakete eingegangen">{lage.zaehler.PAKET_EINGANG_BASIS ?? 0}</Zeile>
      </div>
      <button className="knopf" onClick={basisZeigen}>
        {G.rampen} zeigen
      </button>
    </div>
  );
}
