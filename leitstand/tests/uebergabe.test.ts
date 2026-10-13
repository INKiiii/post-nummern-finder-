import { describe, expect, it } from 'vitest';
import { Lagebild, zusammenfuehren } from '../src/core/lagebild';
import { bewertePlan, type Kontext } from '../src/core/modell';
import { baueRoute, uebergabenAbgleichen, zeitBeiS, zeitplan } from '../src/core/route';
import { SimulierteScanner } from '../src/core/simulation';
import { tauschUebergaben, uebergabeZiele, type UebergabeErgebnis } from '../src/core/uebergabe';
import { erzeugeVorschlaege, optionenFuerBehaelter, tauschOptionen, umplanOptionen } from '../src/core/vorschlaege';
import type { Plan } from '../src/core/types';
import { demo } from './hilfen';

const ZEHN = 10 * 60;

function lauf(opt: { barcode?: boolean } = {}) {
  const d = demo();
  const sim = new SimulierteScanner(d.ctx, d.plan, { behaelterBarcode: opt.barcode ?? true });
  const lage = new Lagebild(d.ctx, d.plan);
  const bis = (t: number) => {
    for (const e of sim.vorspulen(t)) lage.anwenden(e);
  };
  const live = (t: number) => {
    const start = lage.startZustaende(t);
    const ctx: Kontext = { ...d.ctx, tag: { ...d.ctx.tag, start } };
    const rest = lage.restplan(start);
    return { start, ctx, rest, alt: bewertePlan(ctx, rest) };
  };
  /** Restplan übernehmen wie im Leitstand */
  const uebernehmen = (t: number, rest: Plan, start: ReturnType<typeof live>['start']) => {
    const tagesplan = zusammenfuehren(lage.plan, rest, start, lage.uebergabenErledigt);
    const commits = lage.planSetzen(d.ctx, tagesplan, t);
    sim.planAktualisieren(d.ctx, tagesplan, t, commits);
    return tagesplan;
  };
  return { ...d, sim, lage, bis, live, uebernehmen };
}

/** beste machbare Übergabe eines Behälters von Tour 1 um 10:00 */
function besteVonT1(l: ReturnType<typeof lauf>): { u: UebergabeErgebnis; x: string } {
  const { ctx, rest, alt, start } = l.live(ZEHN);
  let best: { u: UebergabeErgebnis; x: string } | null = null;
  for (const x of start.T1.geladen) {
    for (const u of uebergabeZiele(ctx, rest, x, alt)) {
      if (u.auswertung.touren[u.info.nach].ueberstundenMin > 0.5) continue;
      if (!best || u.delta.euroTag > best.u.delta.euroTag) best = { u, x };
    }
  }
  expect(best).not.toBeNull();
  return best!;
}

describe('Übergaben am Treffpunkt', () => {
  it('Abgleich: wer zuerst ankommt, wartet', () => {
    const { ctx } = demo();
    const tp = ctx.welt.treffpunkte[0];
    const schritt = (id: string) => ({ art: 'treffpunkt' as const, knoten: tp.knoten, name: tp.name, uebergabeId: id });
    const r1 = baueRoute(ctx, ctx.welt.basis.knoten, [schritt('U1')], true);
    const r2 = baueRoute(ctx, ctx.welt.basis.knoten, [schritt('U1')], true);
    const p = { kmhFahrt: () => 45, kmhInnen: () => 18, halt: () => 1, treffpunkt: () => 10 };
    const z1 = zeitplan(r1, 8 * 60, p);
    const z2 = zeitplan(r2, 8 * 60 + 25, p);
    const { zeitplaene, treffen } = uebergabenAbgleichen(
      new Map([
        ['A', { route: r1, zp: z1 }],
        ['B', { route: r2, zp: z2 }],
      ]),
    );
    const s = r1.teile.find((t) => t.art === 'treffpunkt')!.s0;
    const ankunftB = zeitBeiS(z2, s).ankunft;
    expect(treffen.get('U1')).toBeCloseTo(ankunftB, 6);
    // A wartet 25 Minuten, danach 10 Minuten Übergabe; beide fahren gleichzeitig weiter
    expect(zeitBeiS(zeitplaene.get('A')!, s).abfahrt).toBeCloseTo(ankunftB + 10, 6);
    expect(zeitBeiS(zeitplaene.get('B')!, s).abfahrt).toBeCloseTo(ankunftB + 10, 6);
  });

  it('planeUebergabe: gültiger Plan, nur eine Seite wartet, Behälter wechselt die Tour', () => {
    const l = lauf();
    l.bis(ZEHN);
    const { u, x } = besteVonT1(l);
    expect(u.auswertung.gueltig).toBe(true);
    expect(u.info.zeit).toBeGreaterThan(ZEHN);
    expect(Math.min(...Object.values(u.info.wartenMin))).toBeCloseTo(0, 6);
    expect(u.auswertung.touren[u.info.nach].zustellt).toContain(x);
    expect(u.auswertung.touren.T1.zustellt).not.toContain(x);
    // Tour 1 ist überlastet; die Übergabe nimmt ihr Arbeit ab
    expect(u.auswertung.touren.T1.ende).toBeLessThan(l.live(ZEHN).alt.touren.T1.ende);
  });

  it('Tauschen über eine Übergabe: beide Behälter wechseln', () => {
    const l = lauf();
    l.bis(ZEHN);
    const { ctx, rest, alt, start } = l.live(ZEHN);
    const x = start.T1.geladen[0];
    const liste = tauschUebergaben(ctx, rest, x, alt);
    expect(liste.length).toBeGreaterThan(3);
    const t = liste[0];
    expect(t.auswertung.gueltig).toBe(true);
    expect(t.info.aufnehmen).toHaveLength(1);
    expect(t.auswertung.touren.T1.zustellt).toContain(t.info.aufnehmen[0]);
    expect(t.auswertung.touren[t.info.nach].zustellt).toContain(x);
  });

  for (const barcode of [true, false]) {
    it(`Simulation und Lagebild: Übergabe findet statt und wird erkannt (${barcode ? 'mit' : 'ohne'} Etikett)`, () => {
      const ohne = lauf({ barcode });
      ohne.bis(18 * 60);
      const endeOhne = ohne.lage.fahrzeug('T1').tourEnde!;

      const l = lauf({ barcode });
      l.bis(ZEHN);
      const { u, x } = besteVonT1(l);
      const { start } = l.live(ZEHN);
      const tagesplan = l.uebernehmen(ZEHN, u.plan, start);
      // der Tagesplan bleibt als Ganzes bewertbar (vom Morgen aus)
      expect(bewertePlan(l.ctx, tagesplan).gueltig).toBe(true);
      const nach = l.ctx.tag.touren.find((t) => t.id === u.info.nach)!;

      // kurz nach der Übergabe: Behälter im neuen Fahrzeug, Restplan gültig
      l.bis(u.info.zeit + 25);
      const b = l.lage.behaelter(x);
      expect(b.fahrzeugId).toBe(nach.fahrzeugId);
      expect(b.umgeladen?.vonFahrzeug).toBe(l.ctx.tag.touren.find((t) => t.id === 'T1')!.fahrzeugId);
      expect(Math.abs(b.umgeladen!.zeit - u.info.zeit)).toBeLessThan(30);
      expect(l.lage.uebergabenErledigt.has(u.info.id)).toBe(true);
      expect(l.lage.fahrzeug('T1').behaelter).not.toContain(x);
      const spaeter = l.live(u.info.zeit + 25);
      expect(spaeter.alt.fehler).toEqual([]);
      // der Behälter steht im Restplan des neuen Fahrzeugs (oder sein Bezirk läuft schon)
      const imRest = spaeter.rest.touren[nach.id].schritte.some((s) => s.art === 'bezirk' && s.behaelterId === x);
      expect(imRest || spaeter.start[nach.id].erledigt.includes(x)).toBe(true);
      expect(spaeter.start[nach.id].geladen.includes(x) || spaeter.start[nach.id].erledigt.includes(x)).toBe(true);
      expect(spaeter.rest.touren.T1.schritte.some((s) => s.art === 'uebergabe')).toBe(false);
      // Zusammenführen behält die erledigte Übergabe im Tagesplan
      const wieder = zusammenfuehren(l.lage.plan, spaeter.rest, spaeter.start, l.lage.uebergabenErledigt);
      expect(wieder.touren.T1.schritte.some((s) => s.art === 'uebergabe' && s.id === u.info.id)).toBe(true);

      // Tagesende: alles zugestellt, der Behälter vom neuen Fahrzeug
      l.bis(18 * 60);
      for (const t of l.ctx.tag.touren) if (l.ctx.tag.start[t.id].besetzt) expect(l.lage.fahrzeug(t.id).phase).toBe('zurueck');
      const bz = l.lage.bezirk(l.ctx.tag.behaelter[x].zielbezirk);
      expect(bz.fertig).toBe(true);
      expect(l.lage.fahrzeug(nach.id).pakete.geladen).toBeGreaterThan(ohne.lage.fahrzeug(nach.id).pakete.geladen);
      expect(l.lage.fahrzeug('T1').pakete.geladen).toBeLessThan(ohne.lage.fahrzeug('T1').pakete.geladen);
      // Tour 1 kommt früher zurück als ohne Übergabe
      expect(l.lage.fahrzeug('T1').tourEnde!).toBeLessThan(endeOhne - 10);
    });
  }

  it('Umplanen an der Rampe: schon verladener Behälter wird ins andere Fahrzeug umgeladen', () => {
    const l = lauf();
    const t = 7 * 60 + 15;
    l.bis(t);
    const x = l.lage.fahrzeug('T1').behaelter[0];
    expect(x).toBeDefined();
    const { ctx, rest, start } = l.live(t);
    const opt = optionenFuerBehaelter(ctx, rest, x).find((o) => o.tourId === 'T2')!;
    expect(opt.auswertung.gueltig).toBe(true);
    l.uebernehmen(t, opt.plan, start);
    // spätestens bis zur Abfahrt ist er umgeladen
    l.bis(7 * 60 + 40);
    const b = l.lage.behaelter(x);
    const t2 = l.ctx.tag.touren.find((y) => y.id === 'T2')!;
    expect(b.fahrzeugId).toBe(t2.fahrzeugId);
    expect(b.umgeladen).not.toBeNull();
    expect(l.lage.fahrzeug('T1').behaelter).not.toContain(x);
    l.bis(18 * 60);
    expect(l.lage.bezirk(l.ctx.tag.behaelter[x].zielbezirk).fertig).toBe(true);
    expect(l.lage.behaelter(x).status).toBe('zugestellt');
  });

  it('Vorschlag „Überlastung abbauen“ unterwegs: per Übergabe am Treffpunkt', () => {
    const l = lauf();
    l.bis(ZEHN);
    const { ctx, rest } = l.live(ZEHN);
    const liste = erzeugeVorschlaege(ctx, rest, { wiederkehrend: false });
    const v = liste.find((x) => x.art === 'ueberlastung');
    expect(v).toBeDefined();
    expect(v!.uebergaben).toHaveLength(1);
    expect(v!.delta.ueberstundenMin).toBeLessThan(-0.5);
    expect(v!.text).toContain('Übergabe');
    expect(v!.aenderungen).toHaveLength(1);
  });

  it('Andere Tour und Tauschen: in der Halle direkt, unterwegs per Übergabe', () => {
    const d = demo();
    const x = d.plan.touren.T1.schritte[0];
    if (x.art !== 'bezirk') throw new Error('Bezirk erwartet');
    const halle = umplanOptionen(d.ctx, d.plan, x.behaelterId);
    expect(halle.length).toBeGreaterThan(3);
    expect(halle.every((o) => o.uebergabe === null)).toBe(true);
    expect(halle.filter((o) => o.beste)).toHaveLength(1);
    const tausch = tauschOptionen(d.ctx, d.plan, x.behaelterId);
    expect(tausch.length).toBeGreaterThan(5);
    expect(tausch[0].auswertung.touren.T1.zustellt).toContain(tausch[0].partner);

    const l = lauf();
    l.bis(ZEHN);
    const { ctx, rest, start } = l.live(ZEHN);
    const anBord = start.T1.geladen[0];
    const unterwegs = umplanOptionen(ctx, rest, anBord);
    expect(unterwegs.find((o) => o.aktuell)?.tourId).toBe('T1');
    expect(unterwegs.filter((o) => !o.aktuell).every((o) => o.uebergabe !== null)).toBe(true);
    expect(tauschOptionen(ctx, rest, anBord).every((o) => o.uebergabe !== null)).toBe(true);
  });
});
