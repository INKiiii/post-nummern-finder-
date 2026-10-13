import { useEffect } from 'react';
import { G } from '../../glossar';
import { tourName } from '../../core/vorschlaege';
import { useAnsicht } from '../../state/ansicht';
import { useLeitstand } from '../../state/store';

/** Hinweisleiste: Ziel-Fahrzeug antippen, kurze Meldungen */
export function Hinweise() {
  const zielWahl = useAnsicht((s) => s.zielWahl);
  const zielWahlSetzen = useAnsicht((s) => s.zielWahlSetzen);
  const ziehen = useAnsicht((s) => s.ziehen);
  const hinweis = useAnsicht((s) => s.hinweis);
  const hinweisSetzen = useAnsicht((s) => s.hinweisSetzen);
  const ctx = useLeitstand((s) => s.ctx);

  useEffect(() => {
    if (!hinweis) return;
    const t = setTimeout(() => hinweisSetzen(null), 3800);
    return () => clearTimeout(t);
  }, [hinweis, hinweisSetzen]);

  if (zielWahl)
    return (
      <div className="hinweis-leiste" role="status">
        <span>
          Jetzt das {G.fahrzeug} antippen, das {G.behaelter} <b>{zielWahl.behaelterId}</b> übernehmen soll.
        </span>
        <button className="knopf klein" onClick={() => zielWahlSetzen(null)}>
          Abbrechen
        </button>
      </div>
    );
  if (ziehen)
    return (
      <div className="hinweis-leiste" role="status">
        <span>
          {G.behaelter} <b>{ziehen.behaelterId}</b>{' '}
          {ziehen.ziel?.art === 'fahrzeug' ? (
            <>
              → <b>{ctx ? tourName(ctx, ziehen.ziel.id) : ziehen.ziel.id}</b> (loslassen für die Vorschau)
            </>
          ) : ziehen.ziel?.art === 'behaelter' ? (
            <>
              ⇄ <b>{ziehen.ziel.id}</b> tauschen (loslassen für die Vorschau)
            </>
          ) : (
            `auf ein ${G.fahrzeug} ziehen und loslassen.`
          )}
        </span>
      </div>
    );
  if (hinweis)
    return (
      <div className="hinweis-leiste" role="status" key={hinweis.nr}>
        <span>{hinweis.text}</span>
      </div>
    );
  return null;
}
