import { useLayoutEffect, useMemo } from 'react';
import { G } from '../glossar';
import { gleicheAuswahl, useAnsicht } from '../state/ansicht';
import { useLeitstand } from '../state/store';
import { labelRef, setzeAnker } from '../szene/beschriftung';
import { labelText } from '../szene/Fahrzeuge';
import { S } from '../szene/koord';
import { halleMitte } from '../szene/layout';

/** Alle Beschriftungen der Szene als DOM-Ebene über dem Canvas */
export function LabelEbene() {
  const { ctx, lage, zeit } = useLeitstand();
  const lageVersion = useLeitstand((s) => s.lageVersion);
  const { kameraAbstand: abstand, auswahl, tipp } = useAnsicht();

  // feste Ankerpunkte
  useLayoutEffect(() => {
    if (!ctx) return;
    const { welt } = ctx;
    for (const o of welt.ortsteile) setzeAnker(`ort:${o.id}`, o.zentrum.x * S, 3, -o.zentrum.y * S);
    for (const t of welt.treffpunkte) {
      const k = welt.netz.knoten[t.knoten];
      setzeAnker(`treff:${t.id}`, k.x * S, 1.6, -k.y * S);
    }
    const m = halleMitte(welt);
    setzeAnker('basis', m.x, 2.4, m.z);
  }, [ctx]);

  const fahrzeuge = useMemo(() => {
    void lageVersion;
    if (!ctx || !lage) return [];
    return ctx.tag.touren.map((t) => ({ t, p: lage.prognose(t.id, zeit), besetzt: ctx.tag.start[t.id].besetzt }));
  }, [ctx, lage, zeit, lageVersion]);

  if (!ctx) return null;
  const { welt } = ctx;
  const treffGross = Math.min(8, Math.max(1, abstand / 60));
  return (
    <div className="label-ebene" aria-hidden="true">
      {welt.ortsteile.map((o) => (
        <div key={o.id} ref={labelRef(`ort:${o.id}`)} data-aus={abstand > 90 ? '0' : '1'} className="label">
          <div className="szene-label ort">{o.name}</div>
        </div>
      ))}
      {welt.treffpunkte.map((t) => (
        <div key={t.id} ref={labelRef(`treff:${t.id}`)} data-aus={abstand < 260 ? '0' : '1'} className="label" style={{ marginTop: -treffGross * 6 }}>
          <div className="szene-label treff">
            {G.treffpunkt} {t.name}
          </div>
        </div>
      ))}
      <div ref={labelRef('basis')} data-aus={abstand > 70 ? '0' : '1'} className="label">
        <div className="szene-label basis">{G.zustellbasis}</div>
      </div>
      {fahrzeuge.map(({ t, p, besetzt }) => {
        const anBasis = p.phase !== 'unterwegs';
        const gewaehlt = gleicheAuswahl(auswahl, { art: 'fahrzeug', id: t.id });
        const zeigen = !anBasis || abstand < 140 || gewaehlt;
        const grau = !besetzt;
        return (
          <div key={t.id} ref={labelRef(`fz:${t.id}`)} data-aus={zeigen ? '0' : '1'} className="label">
            <div className={`fahrzeug-label ${gewaehlt ? 'aktiv' : ''}`} style={{ ['--tourfarbe' as string]: grau ? '#8a919b' : t.farbe }}>
              <span className="nr">{t.nr}</span>
              {labelText(p, zeit, besetzt)}
            </div>
          </div>
        );
      })}
      <div ref={labelRef('tipp')} data-aus={tipp ? '0' : '1'} className="label">
        <div className="szene-tipp">{tipp}</div>
      </div>
    </div>
  );
}
