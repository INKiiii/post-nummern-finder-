import { describe, expect, it } from 'vitest';
import { standardAnnahmen } from '../src/config';
import {
  bewertePlan,
  erstelleKontext,
  planAusFolgen,
  summeMinuten,
  tourKosten,
  vergleiche,
  zustellMinuten,
} from '../src/core/modell';
import { rechenwegErsparnis, rechenwegTourKosten, rechenwegTourZeit } from '../src/core/rechenweg';
import type { Plan } from '../src/core/types';
import { demo, miniTag, miniWelt } from './hilfen';

const a = standardAnnahmen();

describe('Bausteine', () => {
  it('Zustellzeit: 1,2 Min/Paket, 3,6 Sek/Brief, 3 Sek/Zeitung', () => {
    const z = zustellMinuten({ pakete: 10, briefe: 100, zeitungen: 20 }, a);
    expect(z.pakete).toBeCloseTo(12, 10);
    expect(z.briefe).toBeCloseTo(6, 10);
    expect(z.zeitungen).toBeCloseTo(1, 10);
    expect(z.summe).toBeCloseTo(19, 10);
  });

  it('Kosten: volle Schicht, Überstunden mit Zuschlag, km, Fahrzeug fix', () => {
    // 6 h Arbeit: volle Schicht wird bezahlt
    const k6 = tourKosten(true, 360, 40, a);
    expect(k6.schicht).toBe(224);
    expect(k6.ueberstunden).toBe(0);
    expect(k6.km).toBeCloseTo(12, 10);
    expect(k6.fahrzeug).toBe(25);
    expect(k6.summe).toBeCloseTo(261, 10);
    // 9 h: 1 h Überstunden × 28 € × 1,25 = 35 €
    const k9 = tourKosten(true, 540, 40, a);
    expect(k9.ueberstunden).toBeCloseTo(35, 10);
    expect(k9.summe).toBeCloseTo(296, 10);
    // keine Behälter → 0 €
    expect(tourKosten(false, 0, 0, a).summe).toBe(0);
  });

  it('Annahmen wirken: Stundensatz und Zuschlag ändern die Kosten', () => {
    const b = { ...a, stundensatz: 30, ueberstundenZuschlagProzent: 50 };
    const k = tourKosten(true, 540, 0, b);
    expect(k.schicht).toBe(240);
    expect(k.ueberstunden).toBeCloseTo(45, 10);
  });
});

describe('Plan bewerten (Mini-Welt, Handrechnung)', () => {
  const welt = miniWelt();

  it('rechnet Zeit, km und Kosten je Tour exakt', () => {
    const ctx = erstelleKontext(welt, miniTag(), a);
    const aus = bewertePlan(ctx, planAusFolgen({ T1: ['X'], T2: ['Y'] }));
    expect(aus.gueltig).toBe(true);
    const t1 = aus.touren.T1;
    // 30 Laden + 18 km/45 km/h = 24 + 3 km/18 km/h = 10 + 19 Zustellung = 83 Min
    expect(t1.min.laden).toBe(30);
    expect(t1.min.fahrtZwischen).toBeCloseTo(24, 10);
    expect(t1.min.fahrtInnen).toBeCloseTo(10, 10);
    expect(t1.min.zustellung).toBeCloseTo(19, 10);
    expect(t1.dauer).toBeCloseTo(83, 10);
    expect(t1.abfahrt).toBe(450);
    expect(t1.ende).toBeCloseTo(503, 10);
    expect(t1.km.gesamt).toBeCloseTo(21, 10);
    expect(t1.kosten.summe).toBeCloseTo(224 + 6.3 + 25, 10);
    const t2 = aus.touren.T2;
    // 30 + 24 km/45 = 32 + 1,8/18 = 6 + 9 = 77 Min
    expect(t2.dauer).toBeCloseTo(77, 10);
    expect(t2.kosten.summe).toBeCloseTo(224 + 25.8 * 0.3 + 25, 10);
    expect(aus.summe.kosten.summe).toBeCloseTo(t1.kosten.summe + t2.kosten.summe, 10);
    expect(aus.summe.aktiveTouren).toBe(2);
    expect(aus.summe.bezahltMin).toBe(960);
  });

  it('Überstunden: alles über 8 h mit 25 % Zuschlag', () => {
    const ctx = erstelleKontext(welt, miniTag({ pakete: 400, briefe: 100, zeitungen: 20 }), a);
    const aus = bewertePlan(ctx, planAusFolgen({ T1: ['X', 'Y'], T2: [] }));
    const t1 = aus.touren.T1;
    // 30 + (9 + 3 + 12) km/45 = 32 + (3 + 1,8) km/18 = 16 + 487 + 9 = 574 Min
    expect(t1.dauer).toBeCloseTo(574, 10);
    expect(t1.ueberstundenMin).toBeCloseTo(94, 10);
    expect(t1.kosten.ueberstunden).toBeCloseTo((94 / 60) * 28 * 1.25, 10);
    // Tour ohne Behälter kostet 0
    expect(aus.touren.T2.aktiv).toBe(false);
    expect(aus.touren.T2.kosten.summe).toBe(0);
  });

  it('Übergabe am Treffpunkt: Wartezeit, Übergabedauer, Behälter wechselt das Fahrzeug', () => {
    const ctx = erstelleKontext(welt, miniTag(), a);
    const ue = { art: 'uebergabe' as const, id: 'u1', treffpunkt: 3, treffpunktName: 'Treffpunkt T' };
    const plan: Plan = {
      touren: {
        T1: { schritte: [{ art: 'bezirk', behaelterId: 'X' }, { ...ue, partner: 'T2', abgeben: ['Y'], aufnehmen: [] }] },
        T2: { schritte: [{ ...ue, partner: 'T1', abgeben: [], aufnehmen: ['Y'] }, { art: 'bezirk', behaelterId: 'Y' }] },
      },
      liegenLassen: [],
    };
    const aus = bewertePlan(ctx, plan);
    expect(aus.fehler).toEqual([]);
    const t1 = aus.touren.T1;
    const t2 = aus.touren.T2;
    expect(t1.ladung).toEqual(['X', 'Y']);
    expect(t2.ladung).toEqual([]);
    // T1: 7:30 ab, 7:42 in X, 8:11 fertig, 8:19 am Treffpunkt. T2: 7:30 ab, 7:50 am Treffpunkt → wartet 29 Min.
    const ue1 = t1.schritte[1];
    const ue2 = t2.schritte[0];
    expect(ue1.ankunft).toBeCloseTo(499, 10);
    expect(ue2.ankunft).toBeCloseTo(470, 10);
    expect(ue2.wartenMin).toBeCloseTo(29, 10);
    expect(ue1.wartenMin).toBeCloseTo(0, 10);
    expect(ue1.ende).toBeCloseTo(509, 10);
    expect(t1.dauer).toBeCloseTo(109, 10);
    expect(t2.dauer).toBeCloseTo(132, 10);
    expect(t2.min.warten).toBeCloseTo(29, 10);
    expect(t2.min.uebergabe).toBe(10);
    expect(t2.zustellt).toEqual(['Y']);
    for (const t of [t1, t2]) expect(summeMinuten(t.min)).toBeCloseTo(t.dauer, 9);
  });

  it('erkennt Fehler: doppelt, vergessen, nicht an Bord, unbesetzte Tour', () => {
    const ctx = erstelleKontext(welt, miniTag(), a);
    expect(bewertePlan(ctx, planAusFolgen({ T1: ['X', 'Y'], T2: ['Y'] })).fehler.join()).toMatch(/mehrfach/);
    expect(bewertePlan(ctx, planAusFolgen({ T1: ['X'], T2: [] })).fehler.join()).toMatch(/keiner Tour/);
    // liegen lassen ist erlaubt und wird gezählt
    const liegen = bewertePlan(ctx, planAusFolgen({ T1: ['X'], T2: [] }, ['Y']));
    expect(liegen.gueltig).toBe(true);
    expect(liegen.liegen.behaelter).toEqual(['Y']);
    expect(liegen.liegen.menge.pakete).toBe(5);

    const tag = miniTag();
    tag.start.T2 = { ...tag.start.T2, besetzt: false };
    expect(bewertePlan(erstelleKontext(welt, tag, a), planAusFolgen({ T1: ['X'], T2: ['Y'] })).fehler.join()).toMatch(/unbesetzt/);

    const unterwegs = miniTag();
    unterwegs.start.T1 = { ...unterwegs.start.T1, mussLaden: false, geladen: ['X'] };
    const f = bewertePlan(erstelleKontext(welt, unterwegs, a), planAusFolgen({ T1: ['X', 'Y'], T2: [] })).fehler.join();
    expect(f).toMatch(/Y ist nicht an Bord/);
  });
});

describe('Demo-Startplan', () => {
  const { ctx, plan } = demo();
  const aus = bewertePlan(ctx, plan);

  it('ist gültig und hat die typischen Schieflagen', () => {
    expect(aus.fehler).toEqual([]);
    expect(aus.summe.aktiveTouren).toBe(6);
    expect(aus.touren.T1.ueberstundenMin).toBeGreaterThan(15);
    expect(aus.touren.T6.dauer).toBeLessThan(5 * 60);
    for (const id of aus.tourIds) expect(summeMinuten(aus.touren[id].min)).toBeCloseTo(aus.touren[id].dauer, 6);
    expect(aus.summe.menge.briefe).toBeGreaterThan(5000);
  });

  it('Ersparnis: €/Jahr = €/Tag × Zustelltage, Rechenweg zeigt die Werte', () => {
    const neu = planAusFolgen({ ...Object.fromEntries(aus.tourIds.map((id) => [id, plan.touren[id].schritte.map((s) => (s.art === 'bezirk' ? s.behaelterId : ''))])), T2: ['LI-N', 'LI-M', 'LI-S', 'EI-S'] });
    const ausNeu = bewertePlan(ctx, neu);
    const d = vergleiche(aus, ausNeu, a);
    expect(d.betroffen).toEqual(['T2']);
    expect(d.km).toBeLessThan(0);
    expect(d.euroTag).toBeCloseTo(-d.km * a.euroProKm, 6);
    expect(d.euroJahr).toBeCloseTo(d.euroTag * 300, 6);
    const r = rechenwegErsparnis(ctx, aus, ausNeu, d);
    expect(r.zeilen.find((z) => z.was === 'Ersparnis je Jahr')!.rechnung).toContain('300 Tage');
    expect(r.zeilen.find((z) => z.was === 'Ersparnis je Jahr')!.annahmen).toContain('zustelltageProJahr');
  });

  it('Rechenweg Zeit und Kosten passen zu den Zahlen', () => {
    const t1 = aus.touren.T1;
    const k = rechenwegTourKosten(ctx, t1);
    const nbsp = (x: string) => x.replace(/\u00a0/g, ' ');
    expect(nbsp(k.zeilen[0].rechnung)).toBe('8 h × 28,00 €/h');
    expect(nbsp(k.zeilen[0].ergebnis)).toBe('224,00 €');
    expect(k.zeilen.at(-1)!.ergebnis).toBe(new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(Math.round(t1.kosten.summe * 100) / 100));
    const z = rechenwegTourZeit(ctx, t1);
    expect(z.zeilen.map((x) => x.was)).toContain('Zustellung Pakete');
    expect(z.hinweise.join()).toMatch(/Überstunden/);
  });
});
