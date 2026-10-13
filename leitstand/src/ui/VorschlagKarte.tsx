import type { Kontext } from '../core/modell';
import { VORSCHLAG_NAME, tourName, type Vorschlag } from '../core/vorschlaege';
import { DeltaRaster } from './umplanen/DeltaRaster';

/** Ein Vorschlag mit Δ km, Δ Arbeitszeit, Δ €/Tag, Δ €/Jahr und den betroffenen Touren */
export function VorschlagKarte({ v, ctx, onUebernehmen, onAnsehen }: { v: Vorschlag; ctx: Kontext; onUebernehmen: () => void; onAnsehen?: () => void }) {
  return (
    <div className="vorschlag">
      <div className="art">{VORSCHLAG_NAME[v.art]}</div>
      <h3>{v.titel}</h3>
      <p>{v.text}</p>
      <DeltaRaster ctx={ctx} alt={v.alt} neu={v.neu} delta={v.delta} wiederkehrend={v.wiederkehrend} />
      {v.warnung && (
        <div className="warnung" style={{ fontSize: 13, marginBottom: 6 }}>
          ⚠ {v.warnung}
        </div>
      )}
      <div className="fuss">
        <div className="chips">
          {v.delta.betroffen.map((id) => {
            const t = ctx.tag.touren.find((x) => x.id === id)!;
            return (
              <span key={id} className="chip" style={{ borderColor: t.farbe, color: t.farbe }}>
                {tourName(ctx, id)}
              </span>
            );
          })}
        </div>
        <div className="knopf-reihe">
          {onAnsehen && (
            <button className="knopf klein" onClick={onAnsehen}>
              In 3D ansehen
            </button>
          )}
          <button className="knopf primaer klein" onClick={onUebernehmen}>
            Übernehmen
          </button>
        </div>
      </div>
    </div>
  );
}
