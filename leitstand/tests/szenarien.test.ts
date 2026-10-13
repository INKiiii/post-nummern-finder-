import { describe, expect, it } from 'vitest';
import { standardAnnahmen } from '../src/config';
import { erzeugeDemoTag } from '../src/core/demo';
import { Lagebild, zusammenfuehren } from '../src/core/lagebild';
import { bewertePlan, erstelleKontext, type Kontext } from '../src/core/modell';
import { SimulierteScanner } from '../src/core/simulation';
import { punktSegment } from '../src/core/welt';
import { mitAusfall, mitSperrung, STAU_STRASSE } from '../src/core/szenarien';
import type { Plan, Tag } from '../src/core/types';
import { erzeugeVorschlaege } from '../src/core/vorschlaege';
import { demo, demoWelt } from './hilfen';

/** ein Tag wie im Leitstand: Simulation, Lagebild, Umplanen ab jetzt */
function tag(t: Tag, plan: Plan) {
  const welt = demoWelt();
  let ctx = erstelleKontext(welt, t, standardAnnahmen());
  const sim = new SimulierteScanner(ctx, plan, {});
  const lage = new Lagebild(ctx, plan);
  const bis = (z: number) => {
    for (const e of sim.vorspulen(z)) lage.anwenden(e);
  };
  const live = (z: number) => {
    const start = lage.startZustaende(z);
    const c: Kontext = { ...ctx, tag: { ...ctx.tag, start } };
    const rest = lage.restplan(start);
    return { start, ctx: c, rest, aus: bewertePlan(c, rest) };
  };
  const anwenden = (z: number, neu: Plan, neuerTag?: Tag) => {
    if (neuerTag) ctx = erstelleKontext(welt, neuerTag, standardAnnahmen());
    const commits = lage.planSetzen(ctx, neu, z);
    sim.planAktualisieren(ctx, neu, z, commits);
  };
  return { welt, sim, lage, bis, live, anwenden, get ctx() {
    return ctx;
  } };
}

describe('Szenarien', () => {
  it('Zusteller fällt aus: Behälter bleiben liegen, „Ausfall auffangen“ verteilt alles, abends ist alles zugestellt', () => {
    const d = demo();
    const t = mitAusfall(d.ctx.tag, 'T3', null);
    const a = tag(t, d.plan);
    a.bis(6 * 60 + 50);
    const { ctx, rest, aus, start } = a.live(6 * 60 + 50);
    const t3 = d.plan.touren.T3.schritte.map((x) => (x.art === 'bezirk' ? x.behaelterId : ''));
    expect(aus.gueltig).toBe(true);
    expect([...aus.liegen.behaelter].sort()).toEqual([...t3].sort());
    const v = erzeugeVorschlaege(ctx, rest)[0];
    expect(v.art).toBe('ausfall');
    expect(v.titel).toContain('Tour 3');
    expect(v.neu.liegen.behaelter).toHaveLength(0);
    // vor Schichtbeginn gilt der neue Plan als Plan des Tages
    const b = tag(t, zusammenfuehren(d.plan, v.plan, start));
    b.bis(18 * 60);
    for (const x of t3) expect(b.lage.behaelter(x).status).toBe('zugestellt');
    expect(b.lage.fahrzeug('T3').tourStart).toBeNull();
  });

  it('Zusteller fällt aus, Springer übernimmt eine Stunde später', () => {
    const d = demo();
    const t = mitAusfall(d.ctx.tag, 'T3', 60);
    const a = tag(t, d.plan);
    a.bis(18 * 60);
    expect(a.lage.fahrzeug('T3').tourStart!).toBeGreaterThan(8 * 60 + 20);
    for (const s of d.plan.touren.T3.schritte) if (s.art === 'bezirk') expect(a.lage.behaelter(s.behaelterId).status).toBe('zugestellt');
    expect(bewertePlan(erstelleKontext(a.welt, t, standardAnnahmen()), d.plan).touren.T3.springer).toBe(true);
  });

  it('Stau: Mittelbrücke gesperrt – die Fahrzeuge fahren außen herum, alles wird zugestellt, aber später', () => {
    const d = demo();
    const ohne = tag(d.ctx.tag, d.plan);
    ohne.bis(18 * 60);
    const a = tag(d.ctx.tag, d.plan);
    const z = 9 * 60 + 30;
    a.bis(z);
    const gesperrt = mitSperrung(a.ctx.tag, a.welt, STAU_STRASSE);
    expect(gesperrt.sperrungen.length).toBeGreaterThan(0);
    a.anwenden(z, d.plan, gesperrt);
    // die Brücke (beide Enden) wird ab etwas später nicht mehr befahren
    const kante = a.welt.netz.kanten[gesperrt.sperrungen[0]];
    const k1 = a.welt.netz.knoten[kante.a];
    const k2 = a.welt.netz.knoten[kante.b];
    for (const t of d.ctx.tag.touren) {
      for (let m = z + 20; m < 17 * 60; m += 2) {
        const p = a.sim.wahrePosition(t.id, m);
        if (p) expect(punktSegment(p, k1, k2)).toBeGreaterThan(0.005);
      }
    }
    a.bis(18 * 60);
    for (const b of d.ctx.tag.behaelterIds) expect(a.lage.behaelter(b).status).toBe('zugestellt');
    const spaeter = d.ctx.tag.touren.filter((t) => a.lage.fahrzeug(t.id).tourEnde! > ohne.lage.fahrzeug(t.id).tourEnde! + 3);
    expect(spaeter.length).toBeGreaterThan(0);
  });

  it('Panne mittags: Fahrzeug bleibt stehen, die anderen holen die Behälter am Standort ab', () => {
    const d = demo();
    const a = tag(d.ctx.tag, d.plan);
    const z = 11 * 60 + 30;
    a.bis(z);
    const anBordVorher = [...a.lage.fahrzeug('T2').behaelter];
    expect(a.lage.defektMelden('T2', z)).not.toBeNull();
    a.sim.defektSetzen('T2');
    a.anwenden(z, a.lage.plan);
    a.bis(z + 1);
    const { ctx, rest, aus, start } = a.live(z + 1);
    expect(start.T2.defekt).toBe(true);
    expect(aus.gueltig).toBe(true);
    const offen = start.T2.geladen;
    expect(offen.length).toBeGreaterThan(0);
    expect(offen.every((b) => aus.liegen.behaelter.includes(b))).toBe(true);
    const v = erzeugeVorschlaege(ctx, rest, { wiederkehrend: false })[0];
    expect(v.art).toBe('ausfall');
    expect(v.titel).toBe('Panne Tour 2 auffangen');
    expect(v.uebergaben.length).toBeGreaterThan(0);
    expect(v.uebergaben.every((u) => u.treffpunkt.name === 'Standort E-02')).toBe(true);
    expect(v.neu.liegen.behaelter.length).toBeLessThan(aus.liegen.behaelter.length);
    a.anwenden(z + 1, zusammenfuehren(a.lage.plan, v.plan, start, a.lage.uebergabenErledigt));
    a.bis(18 * 60);
    const uebergeben = v.uebergaben.flatMap((u) => u.abgeben);
    for (const b of uebergeben) expect(a.lage.bezirk(a.ctx.tag.behaelter[b].zielbezirk).fertig).toBe(true);
    // das Fahrzeug steht noch am Standort (abgeschleppt), nicht an der Rampe
    const f = a.lage.fahrzeug('T2');
    expect(f.phase).toBe('zurueck');
    expect(a.lage.pose('T2', 18 * 60).anRampe).toBe(false);
    expect(anBordVorher.length).toBeGreaterThanOrEqual(offen.length);
  });

  it('Spitzentag +40 %: Überstunden im Startplan, die Vorschläge bauen sie ab', () => {
    const welt = demoWelt();
    const { tag: t, plan } = erzeugeDemoTag(welt, { mengenFaktor: 1.4 });
    const ctx = erstelleKontext(welt, t, standardAnnahmen());
    const alt = bewertePlan(ctx, plan);
    expect(alt.summe.ueberstundenMin).toBeGreaterThan(60);
    const v = erzeugeVorschlaege(ctx, plan);
    expect(Math.min(...v.map((x) => x.neu.summe.ueberstundenMin))).toBeLessThan(alt.summe.ueberstundenMin);
  });
});
