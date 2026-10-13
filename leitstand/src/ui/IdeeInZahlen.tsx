import { useEffect, type ReactNode } from 'react';
import { G } from '../glossar';
import { fmtDauer, fmtDeltaEuro, fmtDeltaKm, fmtDeltaMin, fmtEuro, fmtKm, fmtZahl } from '../core/format';
import { ersparnisAnteile, type Variante, type ZahlenVergleich } from '../core/ideeInZahlen';
import type { Kontext, PlanAuswertung } from '../core/modell';
import {
  KOSTENART_NAME,
  KOSTENARTEN,
  rechenwegErsparnis,
  rechenwegHochrechnung,
  rechenwegKostenart,
  rechenwegOhneTourEinsparung,
  rechenwegPlanKosten,
} from '../core/rechenweg';
import type { Inhalt } from '../core/types';
import { useLeitstand } from '../state/store';
import { AnnahmenPanel } from './AnnahmenPanel';
import { RechenwegInhalt, WertKnopf } from './Rechenweg';

/** In einem fremden Rahmen (z. B. eingebettet) lässt sich meist nicht drucken */
const IM_RAHMEN = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();

const farbe = (x: number) => (Math.abs(x) < 0.005 ? '' : x > 0 ? 'gut' : 'schlecht');

/** „132 Pakete, ≈ 1.890 Briefe (geschätzt), 135 Zeitungen“ */
function mengeText(m: Inhalt): string {
  return `${fmtZahl(m.pakete)} ${G.pakete}, ≈ ${fmtZahl(m.briefe)} ${G.briefe} (geschätzt), ${fmtZahl(m.zeitungen)} ${G.zeitungen}`;
}

/**
 * Seite „Idee in Zahlen“: Was bringt der Leitstand in der Demo-Basis? Alle Zahlen live aus dem
 * Rechenmodell, jede Euro-Zahl mit Rechenweg; druckbar (z. B. als PDF für die Einreichung).
 */
export function IdeeInZahlen() {
  const welt = useLeitstand((s) => s.welt);
  const ctx = useLeitstand((s) => s.ctx);
  const annahmen = useLeitstand((s) => s.annahmen);
  const zahlen = useLeitstand((s) => s.zahlen);
  const laedt = useLeitstand((s) => s.zahlenLaden);
  const anfordern = useLeitstand((s) => s.zahlenAnfordern);
  useEffect(() => {
    if (!welt) return;
    const t = setTimeout(anfordern, 200);
    return () => clearTimeout(t);
  }, [welt, annahmen, anfordern]);

  // Rechenwege mit den aktuellen Annahmen (Namen der Touren aus dem Demo-Tag)
  const rctx: Kontext | null = ctx && { ...ctx, annahmen };

  return (
    <div className="seite zahlen-seite">
      <header className="kopf">
        <div className="titel">
          <h1>Idee in Zahlen</h1>
          <div className="leise" style={{ fontSize: 13 }}>
            Beispielrechnung für die erfundene Zustellbasis „{welt?.name ?? '…'}“ · live aus dem Rechenmodell · jede Euro-Zahl lässt sich antippen
          </div>
        </div>
        <div className="aktionen">
          {laedt && zahlen && <span className="chip">wird neu berechnet …</span>}
          <a className="knopf" href="#/" style={{ textDecoration: 'none' }}>
            ← 3D-{G.leitstand}
          </a>
          {!IM_RAHMEN && (
            <button className="knopf" onClick={() => window.print()}>
              Drucken / PDF
            </button>
          )}
        </div>
      </header>
      {!zahlen || !rctx ? (
        <main className="seite-inhalt">
          <div className="karte">Rechne die Beispieltage durch …</div>
        </main>
      ) : (
        <Inhalt ctx={rctx} />
      )}
    </div>
  );
}

function Inhalt({ ctx }: { ctx: Kontext }) {
  const z = useLeitstand((s) => s.zahlen)!;
  const a = ctx.annahmen;
  const { alltag } = z;
  const alt = alltag.ohne.aus;
  const neu = alltag.mit.aus;
  const d = alltag.delta;
  const anteile = ersparnisAnteile(alt, neu);
  const reserveTag = anteile.ueberstunden + anteile.km;
  const tage = a.zustelltageProJahr;
  const basen = a.zustellbasen;
  const rwAlltag = () => rechenwegErsparnis(ctx, alt, neu, d, true);
  const namen: [string, string] = ['Startplan', `Mit ${G.leitstand}`];
  const tourenFrei = alt.summe.aktiveTouren - neu.summe.aktiveTouren;

  return (
    <main className="seite-inhalt">
      <div className="ergebnis-box zahlen-held">
        <div className="leise klein">Ein normaler Tag in {ctx.welt.name}, mit den Vorschlägen des {G.leitstand}s</div>
        <div className="ergebnis-gross">
          <WertKnopf rechenweg={rwAlltag}>{fmtEuro(d.euroJahr, true)}</WertKnopf> weniger Kosten im Jahr
        </div>
        <div>
          {fmtEuro(d.euroTag)} je Tag × {fmtZahl(tage)} Zustelltage. Alle Daten sind erfunden; die Zahl zeigt, <b>wie</b> der {G.leitstand} rechnet – nicht, was eine echte Basis spart.
        </div>
      </div>

      <div className="kennzahlen zahlen-kennzahlen">
        <Kennzahl label="Ersparnis je Tag" wert={<WertKnopf rechenweg={rwAlltag}>{fmtEuro(d.euroTag)}</WertKnopf>} unter={`${fmtEuro(alt.summe.kosten.summe)} → ${fmtEuro(neu.summe.kosten.summe)}`} />
        <Kennzahl
          label="Überstunden"
          wert={fmtDeltaMin(d.ueberstundenMin)}
          unter={`je Tag · ${fmtZahl((-d.ueberstundenMin / 60) * tage)} h im Jahr`}
        />
        <Kennzahl label="Strecke" wert={fmtDeltaKm(d.km)} unter={`je Tag · ${fmtZahl(-d.km * tage)} km im Jahr`} />
        <Kennzahl
          label={G.touren}
          wert={`${neu.summe.aktiveTouren} statt ${alt.summe.aktiveTouren}`}
          unter={tourenFrei > 0 ? `${tourenFrei} ${G.tour} frei – Reserve für Ausfälle und Spitzentage` : 'gleich viele'}
        />
      </div>

      <div className="karte">
        <h2>Woraus besteht die Ersparnis?</h2>
        <p className="leise klein">
          Startplan: „historisch gewachsen“ ({alltag.ohne.text.replace(/^historisch gewachsen: /, '')}). Mit {G.leitstand}: {alltag.mit.text.replace(/^Vorschläge übernommen: /, '')}. Beide stellen
          alles zu ({mengeText(z.menge)}).
        </p>
        <div className="tabelle-huelle">
          <table className="tabelle">
            <thead>
              <tr>
                <th>Kostenart je Tag</th>
                <th className="r breit">Startplan</th>
                <th className="r breit">Mit {G.leitstand}</th>
                <th className="r">Ersparnis je Tag</th>
                <th className="r">je Jahr</th>
              </tr>
            </thead>
            <tbody>
              {KOSTENARTEN.map((k) => {
                const rw = () => rechenwegKostenart(ctx, k, alt, neu, namen);
                const x = anteile[k];
                return (
                  <tr key={k}>
                    <td>{KOSTENART_NAME[k]}</td>
                    <td className="r zahlen breit">
                      <WertKnopf rechenweg={rw}>{fmtEuro(alt.summe.kosten[k])}</WertKnopf>
                    </td>
                    <td className="r zahlen breit">
                      <WertKnopf rechenweg={rw}>{fmtEuro(neu.summe.kosten[k])}</WertKnopf>
                    </td>
                    <td className={`r zahlen ${farbe(x)}`}>
                      <WertKnopf rechenweg={rw}>{fmtEuro(x)}</WertKnopf>
                    </td>
                    <td className={`r zahlen ${farbe(x)}`}>
                      <WertKnopf rechenweg={rw}>{fmtEuro(x * tage, true)}</WertKnopf>
                    </td>
                  </tr>
                );
              })}
              <tr className="summe">
                <td>Summe</td>
                <td className="r zahlen breit">
                  <WertKnopf rechenweg={() => rechenwegPlanKosten(ctx, alt)}>{fmtEuro(alt.summe.kosten.summe)}</WertKnopf>
                </td>
                <td className="r zahlen breit">
                  <WertKnopf rechenweg={() => rechenwegPlanKosten(ctx, neu)}>{fmtEuro(neu.summe.kosten.summe)}</WertKnopf>
                </td>
                <td className={`r zahlen ${farbe(d.euroTag)}`}>
                  <WertKnopf rechenweg={rwAlltag}>{fmtEuro(d.euroTag)}</WertKnopf>
                </td>
                <td className={`r zahlen ${farbe(d.euroTag)}`}>
                  <WertKnopf rechenweg={rwAlltag}>{fmtEuro(d.euroJahr, true)}</WertKnopf>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {tourenFrei > 0 && (
          <p className="klein" style={{ marginBottom: 0 }}>
            Der größte Teil kommt aus der frei gewordenen {G.tour}. Bleibt sie als Reserve im Dienst, spart der {G.leitstand} immer noch{' '}
            <WertKnopf rechenweg={() => rechenwegOhneTourEinsparung(ctx, alt, neu)}>{fmtEuro(reserveTag * tage, true)}</WertKnopf> im Jahr an Überstunden und Strecke – und fängt Ausfälle
            ohne {G.springer} auf (siehe unten).
          </p>
        )}
      </div>

      <div className="karte">
        <h2>Die einzelnen Vorschläge</h2>
        <p className="leise klein">So schlägt der {G.leitstand} die Änderungen am Startplan vor. Die Vorschläge überschneiden sich; „Gesamtplan“ fasst sie zusammen.</p>
        <div className="tabelle-huelle">
          <table className="tabelle">
            <thead>
              <tr>
                <th>Vorschlag</th>
                <th className="r breit">Δ Strecke</th>
                <th className="r">Δ Über&shy;stunden</th>
                <th className="r">Ersparnis je Tag</th>
                <th className="r breit">je Jahr</th>
              </tr>
            </thead>
            <tbody>
              {z.vorschlaege.map((v) => {
                const rw = () => rechenwegErsparnis(ctx, alt, v.neu, v.delta, true);
                return (
                  <tr key={v.titel} className={v.art === 'gesamt' ? 'summe' : ''}>
                    <td>{v.titel}</td>
                    <td className="r zahlen breit">{fmtDeltaKm(v.delta.km)}</td>
                    <td className="r zahlen">{fmtDeltaMin(v.delta.ueberstundenMin)}</td>
                    <td className={`r zahlen ${farbe(v.delta.euroTag)}`}>
                      <WertKnopf rechenweg={rw}>{fmtEuro(v.delta.euroTag)}</WertKnopf>
                    </td>
                    <td className={`r zahlen breit ${farbe(v.delta.euroTag)}`}>
                      <WertKnopf rechenweg={rw}>{fmtEuro(v.delta.euroJahr, true)}</WertKnopf>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <h2 className="seiten-ueberschrift">Wenn der Tag nicht nach Plan läuft</h2>
      <p className="leise klein" style={{ marginTop: 0 }}>
        Jedes Szenario ist ein einzelner Tag. Es steckt nicht in der Jahressumme oben – wie oft so etwas vorkommt, ist von Basis zu Basis verschieden. Im 3D-{G.leitstand} lässt sich jedes
        Szenario abspielen.
      </p>
      <div className="szenario-raster">
        {z.szenarien.map((s) => (
          <SzenarioKarte key={s.art} ctx={ctx} s={s} />
        ))}
      </div>

      <div className="karte">
        <h2>Hochrechnung</h2>
        <div className="hochrechnung">
          <label className="annahme-zeile">
            <span>
              Zustellbasen <span className="einheit">(Annahme)</span>
            </span>
            <BasenFeld />
          </label>
          <div className="kennzahlen">
            <Kennzahl label="Ersparnis je Jahr" wert={<WertKnopf rechenweg={() => rechenwegHochrechnung(ctx, d)}>{fmtEuro(d.euroJahr * basen, true)}</WertKnopf>} unter={`${fmtZahl(basen)} × ${fmtEuro(d.euroJahr, true)}`} />
            <Kennzahl label="Überstunden weniger" wert={`${fmtZahl((-d.ueberstundenMin / 60) * tage * basen)} h`} unter="im Jahr" />
            <Kennzahl label="Strecke weniger" wert={`${fmtZahl(-d.km * tage * basen)} km`} unter="im Jahr" />
            <Kennzahl label="Touren frei" wert={fmtZahl(tourenFrei * basen)} unter="je Tag" />
          </div>
        </div>
        <p className="warnung klein" style={{ marginBottom: 0 }}>
          ⚠ {ctx.welt.name} ist erfunden. Die Hochrechnung nimmt an, dass jede Basis so viel Spielraum hat wie die Demo-Basis. Ob das stimmt, kann nur ein Pilot mit echten, anonymisierten Daten
          zeigen.
        </p>
      </div>

      <div className="zahlen-zwei">
        <div className="karte">
          <h2>Was es braucht</h2>
          <ul className="liste">
            <li>
              <b>Keine neue Hardware.</b> Der {G.leitstand} liest die Scans, die bei der Arbeit ohnehin entstehen (Handscanner im {G.fahrzeug}).
            </li>
            <li>Eine Schnittstelle: Lesezugriff auf die Scan-Ereignisse; Nachrichten an die Geräte über die vorhandene Nachrichtenfunktion.</li>
            <li>Optional ein Barcode-Etikett am {G.rollbehaelter}.</li>
            <li>Ein Arbeitsplatz mit Browser in der Basis.</li>
          </ul>
          <a href="#/datenquellen">Datenquellen im Detail →</a>
        </div>
        <div className="karte">
          <h2>Datenschutz und Mitbestimmung</h2>
          <ul className="liste">
            <li>Positionen nur auf {G.fahrzeug}ebene und nur während der Tour; nach Schichtende gelöscht.</li>
            <li>Pseudonyme statt Namen, keine Ranglisten, keine Leistungsbewertung einzelner Personen.</li>
            <li>Einführung nur mit Betriebsrat (§ 87 Abs. 1 Nr. 6 BetrVG) und Datenschutzbeauftragten.</li>
          </ul>
        </div>
      </div>

      <div className="karte">
        <h2>Vorschlag für einen Pilot</h2>
        <ol className="liste">
          <li>
            <b>Nachrechnen:</b> Startpläne einer echten Basis mit anonymisierten Scan-Daten durchrechnen – ohne Eingriff in den Betrieb.
          </li>
          <li>
            <b>Planungshilfe:</b> Vorschläge für den nächsten Tag; die Basisleitung entscheidet.
          </li>
          <li>
            <b>Live-Betrieb:</b> Lagebild und Nachrichten an die Geräte – erst nach Zustimmung von Betriebsrat und Datenschutz.
          </li>
        </ol>
      </div>

      <div className="karte">
        <h2>Annahmen</h2>
        <p className="leise klein">Alle Zahlen dieser Seite hängen von diesen Annahmen ab. Wer sie ändert, sieht die Wirkung sofort.</p>
        <div className="annahmen-spalten">
          <AnnahmenPanel />
        </div>
      </div>

      <div className="nur-druck karte">
        <h2>Rechenweg der Hauptzahl</h2>
        <RechenwegInhalt rechenweg={rwAlltag()} />
        <h2 style={{ marginTop: 16 }}>Hochrechnung</h2>
        <RechenwegInhalt rechenweg={rechenwegHochrechnung(ctx, d)} />
      </div>

      <p className="leise klein fusszeile">
        Prototyp „Zustell-{G.leitstand} 3D“ · alle Orte, Namen und Mengen erfunden · keine Daten eines echten Betriebs.
      </p>
    </main>
  );
}

function BasenFeld() {
  const n = useLeitstand((s) => s.annahmen.zustellbasen);
  const setzen = useLeitstand((s) => s.annahmeSetzen);
  return (
    <input
      type="number"
      inputMode="numeric"
      min={1}
      max={1000}
      step={1}
      value={n}
      onChange={(e) => {
        const v = parseInt(e.target.value, 10);
        if (Number.isFinite(v)) setzen('zustellbasen', Math.min(1000, Math.max(1, v)));
      }}
    />
  );
}

function Kennzahl({ label, wert, unter }: { label: string; wert: ReactNode; unter?: string }) {
  return (
    <div className="kennzahl">
      <div className="label">{label}</div>
      <div className="wert">{wert}</div>
      {unter && <div className="vergleich leise">{unter}</div>}
    </div>
  );
}

function SzenarioKarte({ ctx, s }: { ctx: Kontext; s: ZahlenVergleich }) {
  const starten = useLeitstand((x) => x.szenarioStarten);
  const rw = () => rechenwegErsparnis(ctx, s.ohne.aus, s.mit.aus, s.delta, false);
  const abspielen = () => {
    if (s.art === 'alltag') return;
    window.location.hash = '#/';
    void starten(s.art, s.tourId ? { tourId: s.tourId } : undefined);
  };
  return (
    <div className="karte szenario-zahlen">
      <div className="art leise klein">{s.wann}</div>
      <h3>{s.titel}</h3>
      <div className="vergleich-spalten">
        <SpalteVariante ctx={ctx} v={s.ohne} />
        <SpalteVariante ctx={ctx} v={s.mit} />
      </div>
      <p className="kern">{s.kern}</p>
      {s.gerettet.behaelter.length > 0 && (
        <p className="gut klein">
          ✓ {s.gerettet.behaelter.length} {s.gerettet.behaelter.length === 1 ? G.behaelter : G.behaelterPlural} noch heute zugestellt: {mengeText(s.gerettet.menge)}
        </p>
      )}
      <div className="szenario-delta">
        <span className="leise klein">{s.deltaTitel}:</span>
        <span className={farbe(s.delta.euroTag)}>
          <WertKnopf rechenweg={rw}>{fmtDeltaEuro(-s.delta.euroTag)}</WertKnopf> am Tag
        </span>
        <span className={s.delta.ueberstundenMin < -0.5 ? 'gut' : s.delta.ueberstundenMin > 0.5 ? 'schlecht' : ''}>Überstunden {fmtDeltaMin(s.delta.ueberstundenMin)}</span>
        <span>Strecke {fmtDeltaKm(s.delta.km)}</span>
      </div>
      {s.alternative && s.art === 'ausfall' && (
        <p className="klein">
          {s.alternative.titel}: {s.alternative.text} Kosten <WertKnopf rechenweg={() => rechenwegPlanKosten(ctx, s.alternative!.aus)}>{fmtEuro(s.alternative.aus.summe.kosten.summe)}</WertKnopf>{' '}
          – der {G.leitstand} ist{' '}
          <WertKnopf rechenweg={() => rechenwegErsparnis(ctx, s.alternative!.aus, s.mit.aus, s.alternative!.delta, false)}>{fmtEuro(s.alternative.delta.euroTag)}</WertKnopf> günstiger.
        </p>
      )}
      <button className="knopf klein nicht-drucken" onClick={abspielen}>
        Im 3D-{G.leitstand} abspielen
      </button>
    </div>
  );
}

function SpalteVariante({ ctx, v }: { ctx: Kontext; v: Variante }) {
  const p: PlanAuswertung = v.aus;
  const liegen = p.liegen.behaelter.length;
  return (
    <div className="variante">
      <b>{v.titel}</b>
      <div className="leise klein">{v.text}</div>
      <dl>
        <dt>Kosten</dt>
        <dd>
          <WertKnopf rechenweg={() => rechenwegPlanKosten(ctx, p)}>{fmtEuro(p.summe.kosten.summe)}</WertKnopf>
        </dd>
        <dt>Überstunden</dt>
        <dd className={p.summe.ueberstundenMin > 0.5 ? 'warnung' : ''}>{p.summe.ueberstundenMin > 0.5 ? fmtDauer(p.summe.ueberstundenMin) : 'keine'}</dd>
        <dt>Strecke</dt>
        <dd>{fmtKm(p.summe.km)}</dd>
        <dt>bleibt liegen</dt>
        <dd className={liegen ? 'schlecht' : 'gut'}>{liegen ? `${liegen} ${liegen === 1 ? G.behaelter : G.behaelterPlural}` : 'nichts'}</dd>
      </dl>
    </div>
  );
}
