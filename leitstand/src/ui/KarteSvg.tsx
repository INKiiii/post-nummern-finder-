import { useMemo } from 'react';
import type { Kontext, PlanAuswertung } from '../core/modell';
import type { KnotenId, Plan } from '../core/types';
import { THEME } from '../theme';

/** Knotenfolge der ganzen Tour: Basis → Bezirke (mit Weg im Bezirk) → Basis */
export function tourWeg(ctx: Kontext, aus: PlanAuswertung, tourId: string): KnotenId[] {
  const t = aus.touren[tourId];
  if (!t.aktiv) return [];
  const weg: KnotenId[] = [];
  const anhaengen = (teil: KnotenId[]) => {
    if (weg.length && teil.length && weg[weg.length - 1] === teil[0]) weg.push(...teil.slice(1));
    else weg.push(...teil);
  };
  for (const s of t.schritte) {
    anhaengen(ctx.wege.pfad(s.von, s.nach));
    if (s.schritt.art === 'bezirk') {
      const bz = ctx.welt.bezirke[ctx.tag.behaelter[s.schritt.behaelterId].zielbezirk];
      anhaengen(bz.innenWeg);
    }
  }
  if (t.rueckfahrt) anhaengen(ctx.wege.pfad(t.rueckfahrt.von, ctx.welt.basis.knoten));
  return weg;
}

const STRASSE: Record<string, { breite: number; farbe: string }> = {
  haupt: { breite: 0.07, farbe: THEME.szene.strasseHaupt },
  bruecke: { breite: 0.07, farbe: THEME.szene.strasseHaupt },
  land: { breite: 0.055, farbe: THEME.szene.strasseHaupt },
  deich: { breite: 0.045, farbe: THEME.szene.strasseHaupt },
  zufahrt: { breite: 0.04, farbe: THEME.szene.strasseOrt },
  gewerbe: { breite: 0.04, farbe: THEME.szene.strasseOrt },
  ort: { breite: 0.03, farbe: THEME.szene.strasseOrt },
};

const FELD: Record<string, string> = {
  wiese: THEME.szene.wiese,
  acker: THEME.szene.acker,
  raps: THEME.szene.raps,
  weizen: THEME.szene.weizen,
};

/** 2D-Übersicht der Demo-Welt mit den Touren (Prüfansicht für den Rechenkern) */
export function KarteSvg({ ctx, plan, aus, hervor }: { ctx: Kontext; plan: Plan; aus: PlanAuswertung; hervor: string | null }) {
  const { welt } = ctx;
  const H = welt.hoeheKm;

  const grund = useMemo(() => {
    const k = welt.netz.knoten;
    return (
      <>
        {welt.landschaft.felder.map((f, i) => (
          <polygon key={i} points={f.ecken.map((p) => `${p.x},${p.y}`).join(' ')} fill={FELD[f.art]} />
        ))}
        <polyline
          points={welt.landschaft.fluss.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="none"
          stroke={THEME.szene.wasser}
          strokeWidth={welt.landschaft.flussBreiteKm * 1.6}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {welt.landschaft.baeume.map((b, i) => (
          <circle key={i} cx={b.x} cy={b.y} r={0.018 * b.groesse} fill={THEME.szene.wald} />
        ))}
        {welt.netz.kanten.map((e) => {
          const s = STRASSE[e.typ];
          return <line key={e.id} x1={k[e.a].x} y1={k[e.a].y} x2={k[e.b].x} y2={k[e.b].y} stroke={s.farbe} strokeWidth={s.breite} strokeLinecap="round" />;
        })}
        {welt.haeuser.map((h) => (
          <rect key={h.id} x={h.x - 0.012} y={h.y - 0.012} width={0.024} height={0.024} fill="#c98f74" transform={`rotate(${(h.rot * 180) / Math.PI} ${h.x} ${h.y})`} />
        ))}
      </>
    );
  }, [welt]);

  const routen = useMemo(
    () =>
      ctx.tag.touren.map((t) => {
        const weg = tourWeg(ctx, aus, t.id);
        return { id: t.id, farbe: t.farbe, punkte: weg.map((n) => `${welt.netz.knoten[n].x},${welt.netz.knoten[n].y}`).join(' ') };
      }),
    [ctx, aus, plan],
  );

  const basis = welt.basis.pos;
  return (
    <svg className="karte-svg" viewBox={`-0.2 -0.2 ${welt.breiteKm + 0.4} ${H + 0.4}`} role="img" aria-label="Karte Musterhausen">
      <g transform={`translate(0 ${H}) scale(1 -1)`}>
        {grund}
        {routen.map((r) => (
          <polyline
            key={r.id}
            points={r.punkte}
            fill="none"
            stroke={r.farbe}
            strokeWidth={hervor === r.id ? 0.075 : 0.045}
            strokeOpacity={hervor && hervor !== r.id ? 0.18 : 0.9}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {welt.treffpunkte.map((t) => {
          const p = welt.netz.knoten[t.knoten];
          return <circle key={t.id} cx={p.x} cy={p.y} r={0.07} fill="#fff" stroke="#3a4250" strokeWidth={0.025} />;
        })}
        <rect x={basis.x - 0.12} y={basis.y - 0.08} width={0.24} height={0.16} rx={0.03} fill="#2a3240" />
      </g>
      {/* Beschriftung (nicht gespiegelt) */}
      {welt.ortsteile.map((o) => (
        <text key={o.id} x={o.zentrum.x} y={H - o.zentrum.y - o.radius + 0.05} fontSize={0.28} textAnchor="middle" fill="#2a3240" fontWeight={650} style={{ paintOrder: 'stroke', stroke: '#ffffffcc', strokeWidth: 0.08 }}>
          {o.name}
        </text>
      ))}
      <text x={basis.x} y={H - basis.y + 0.42} fontSize={0.26} textAnchor="middle" fill="#2a3240" fontWeight={700} style={{ paintOrder: 'stroke', stroke: '#ffffffcc', strokeWidth: 0.08 }}>
        Zustellbasis
      </text>
    </svg>
  );
}
