/**
 * Rechenmodell: Zeit, Kilometer und Kosten je Tour und Plan.
 *
 *   Zeit je Tour  = Beladen + Fahrzeit (zwischen Gebieten / im Gebiet) + Zustellzeit
 *                   (+ Übergaben und Wartezeit, falls im Tagesverlauf umgeplant wird)
 *   Kosten je Tour = Schicht × Stundensatz (volle Schicht wird bezahlt)
 *                  + Überstunden × Stundensatz × (1 + Zuschlag)
 *                  + km × €/km + Fahrzeug fix.   Eine Tour ohne Behälter kostet 0.
 *   Ersparnis      = Kosten alter Plan − Kosten neuer Plan; pro Jahr × Zustelltage
 *
 * Alle Parameter kommen aus den Annahmen (config.ts).
 */
import { schichtMin, type Annahmen } from '../config';
import { Wegenetz } from './graph';
import type {
  Bisher,
  Inhalt,
  KnotenId,
  Minuten,
  Plan,
  Schritt,
  StartZustand,
  Tag,
  UebergabeSchritt,
  Welt,
} from './types';

export interface Kontext {
  welt: Welt;
  tag: Tag;
  annahmen: Annahmen;
  wege: Wegenetz;
}

export function erstelleKontext(welt: Welt, tag: Tag, annahmen: Annahmen): Kontext {
  return { welt, tag, annahmen, wege: new Wegenetz(welt.netz, tag.sperrungen) };
}

// ---------------------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------------------

export interface ZustellZeit {
  pakete: number;
  briefe: number;
  zeitungen: number;
  summe: number;
}

/** Zustellzeit in Minuten für eine Menge Sendungen */
export function zustellMinuten(inhalt: Inhalt, a: Annahmen): ZustellZeit {
  const pakete = inhalt.pakete * a.minProPaket;
  const briefe = (inhalt.briefe * a.sekProBrief) / 60;
  const zeitungen = (inhalt.zeitungen * a.sekProZeitung) / 60;
  return { pakete, briefe, zeitungen, summe: pakete + briefe + zeitungen };
}

/** Fahrzeit in Minuten */
export function fahrMinuten(km: number, kmh: number): number {
  return (km / kmh) * 60;
}

export interface Kosten {
  schicht: number;
  ueberstunden: number;
  km: number;
  fahrzeug: number;
  summe: number;
}

export const KEINE_KOSTEN: Kosten = { schicht: 0, ueberstunden: 0, km: 0, fahrzeug: 0, summe: 0 };

/** Kosten einer Tour für einen Tag */
export function tourKosten(aktiv: boolean, dauerMin: number, km: number, a: Annahmen): Kosten {
  if (!aktiv) return { ...KEINE_KOSTEN };
  const schicht = a.schichtStunden * a.stundensatz;
  const ueberMin = Math.max(0, dauerMin - schichtMin(a));
  const ueberstunden = (ueberMin / 60) * a.stundensatz * (1 + a.ueberstundenZuschlagProzent / 100);
  const kmKosten = km * a.euroProKm;
  const fahrzeug = a.fahrzeugFixProTag;
  return { schicht, ueberstunden, km: kmKosten, fahrzeug, summe: schicht + ueberstunden + kmKosten + fahrzeug };
}

export function leereMinuten(): Minuten {
  return { laden: 0, fahrtZwischen: 0, fahrtInnen: 0, zustellung: 0, uebergabe: 0, warten: 0 };
}

export function leeresBisher(): Bisher {
  return { kmZwischen: 0, kmInnen: 0, min: leereMinuten(), menge: { pakete: 0, briefe: 0, zeitungen: 0 } };
}

export function summeMinuten(m: Minuten): number {
  return m.laden + m.fahrtZwischen + m.fahrtInnen + m.zustellung + m.uebergabe + m.warten;
}

export function addInhalt(a: Inhalt, b: Inhalt): Inhalt {
  return { pakete: a.pakete + b.pakete, briefe: a.briefe + b.briefe, zeitungen: a.zeitungen + b.zeitungen };
}

/** Startzustand am Morgen: Fahrzeug an der Rampe, Behälter in der Halle */
export function morgenStart(knoten: KnotenId, schichtbeginn: number): StartZustand {
  return {
    zeit: schichtbeginn,
    knoten,
    mussLaden: true,
    geladen: [],
    erledigt: [],
    bisher: leeresBisher(),
    besetzt: true,
    defekt: false,
    schichtbeginn,
    springer: false,
  };
}

// ---------------------------------------------------------------------------------------
// Auswertung eines Plans
// ---------------------------------------------------------------------------------------

export interface SchrittAuswertung {
  schritt: Schritt;
  /** Abfahrt zum Schritt */
  abfahrt: number;
  /** Ankunft am Anfahrpunkt bzw. Treffpunkt */
  ankunft: number;
  /** Beginn der Arbeit (nach einer Wartezeit) */
  beginn: number;
  ende: number;
  von: KnotenId;
  nach: KnotenId;
  anfahrtKm: number;
  anfahrtMin: number;
  innenKm: number;
  innenMin: number;
  zustellMin: number;
  wartenMin: number;
  uebergabeMin: number;
}

export interface TourAuswertung {
  tourId: string;
  aktiv: boolean;
  besetzt: boolean;
  defekt: boolean;
  springer: boolean;
  schichtbeginn: number;
  /** Beginn der (Um-)Planung */
  start: number;
  /** Abfahrt an der Rampe (null, wenn die Tour schon unterwegs war) */
  abfahrt: number | null;
  /** Rückkehr an die Basis (bzw. Ende bei Defekt) */
  ende: number;
  dauer: number;
  ueberstundenMin: number;
  km: { zwischen: number; innen: number; gesamt: number };
  min: Minuten & { gesamt: number };
  /** Zustellzeit nach Sendungsart (ganzer Tag) */
  zustellung: ZustellZeit;
  /** zugestellte Menge (ganzer Tag) */
  menge: Inhalt;
  kosten: Kosten;
  schritte: SchrittAuswertung[];
  rueckfahrt: { abfahrt: number; ankunft: number; km: number; min: number; von: KnotenId } | null;
  /** Behälter, die beim Beladen aus der Halle genommen werden */
  ladung: string[];
  /** Behälter, die diese Tour (ab Start) zustellt, in Gangfolge */
  zustellt: string[];
  /** nach Tourende noch an Bord */
  restAnBord: string[];
}

export interface PlanAuswertung {
  touren: Record<string, TourAuswertung>;
  tourIds: string[];
  summe: {
    km: number;
    kmZwischen: number;
    kmInnen: number;
    /** tatsächliche Arbeitszeit aller aktiven Touren */
    arbeitMin: number;
    /** bezahlte Zeit: volle Schicht je aktiver Tour + Überstunden */
    bezahltMin: number;
    ueberstundenMin: number;
    kosten: Kosten;
    aktiveTouren: number;
    menge: Inhalt;
  };
  /** heute nicht zugestellt */
  liegen: { behaelter: string[]; menge: Inhalt };
  gueltig: boolean;
  fehler: string[];
}

interface Lauf {
  id: string;
  s: StartZustand;
  schritte: Schritt[];
  idx: number;
  t: number;
  knoten: KnotenId;
  anBord: Set<string>;
  kmZw: number;
  kmIn: number;
  min: Minuten;
  zust: ZustellZeit;
  menge: Inhalt;
  aus: SchrittAuswertung[];
  zustellt: string[];
  wartet: { schritt: UebergabeSchritt; abfahrt: number; ankunft: number; von: KnotenId; km: number; fahrMin: number } | null;
  fertig: boolean;
  ende: number;
  rueckfahrt: TourAuswertung['rueckfahrt'];
  aktiv: boolean;
  abfahrt: number | null;
  ladung: string[];
}

/**
 * Bewertet einen Plan vollständig: Zeitplan je Tour (inkl. Übergaben mit Wartezeit),
 * Kilometer, Kosten und Prüfung auf Fehler (Behälter doppelt, nicht an Bord, …).
 */
export function bewertePlan(ctx: Kontext, plan: Plan): PlanAuswertung {
  const { welt, tag, annahmen: a, wege } = ctx;
  const fehler: string[] = [];

  // Wo ist welcher Behälter zu Planungsbeginn?
  const erledigt = new Set<string>();
  const anBordVon = new Map<string, string>();
  for (const t of tag.touren) {
    const s = tag.start[t.id];
    for (const b of s.erledigt) erledigt.add(b);
    for (const b of s.geladen) anBordVon.set(b, t.id);
  }
  const inHalle = (b: string) => !erledigt.has(b) && !anBordVon.has(b);

  // Jeder offene Behälter: genau einmal zugestellt oder liegen gelassen
  const zaehler = new Map<string, number>();
  for (const t of tag.touren)
    for (const s of plan.touren[t.id]?.schritte ?? []) if (s.art === 'bezirk') zaehler.set(s.behaelterId, (zaehler.get(s.behaelterId) ?? 0) + 1);
  for (const b of plan.liegenLassen) zaehler.set(b, (zaehler.get(b) ?? 0) + 1);
  for (const b of tag.behaelterIds) {
    if (erledigt.has(b)) {
      if (zaehler.has(b)) fehler.push(`Behälter ${b} ist schon zugestellt und noch einmal eingeplant.`);
      continue;
    }
    const n = zaehler.get(b) ?? 0;
    if (n === 0) fehler.push(`Behälter ${b} ist keiner Tour zugeordnet.`);
    if (n > 1) fehler.push(`Behälter ${b} ist mehrfach eingeplant.`);
  }

  const laeufe: Lauf[] = tag.touren.map((t) => {
    const s = tag.start[t.id];
    const schritte = plan.touren[t.id]?.schritte ?? [];
    const aktiv = s.besetzt && (schritte.length > 0 || s.geladen.length > 0 || summeMinuten(s.bisher.min) > 0);
    if (!s.besetzt && schritte.length > 0) fehler.push(`Tour ${t.nr} ist unbesetzt, hat aber Aufgaben.`);
    return {
      id: t.id,
      s,
      schritte,
      idx: 0,
      t: s.zeit,
      knoten: s.knoten,
      anBord: new Set(s.geladen),
      kmZw: s.bisher.kmZwischen,
      kmIn: s.bisher.kmInnen,
      min: { ...s.bisher.min },
      zust: { pakete: 0, briefe: 0, zeitungen: 0, summe: 0 },
      menge: { ...s.bisher.menge },
      aus: [],
      zustellt: [],
      wartet: null,
      fertig: !aktiv,
      ende: s.zeit,
      rueckfahrt: null,
      aktiv,
      abfahrt: null,
      ladung: [],
    };
  });
  const lauf = new Map(laeufe.map((l) => [l.id, l]));

  // Beladen: alles, was die Tour zustellt oder abgibt und nicht unterwegs aufnimmt
  for (const l of laeufe) {
    if (!l.aktiv || !l.s.mussLaden) continue;
    const aufgenommen = new Set<string>();
    const ladung: string[] = [];
    for (const s of l.schritte) {
      const liste = s.art === 'bezirk' ? [s.behaelterId] : s.abgeben;
      for (const b of liste) if (!l.anBord.has(b) && !aufgenommen.has(b) && !ladung.includes(b)) ladung.push(b);
      if (s.art === 'uebergabe') for (const b of s.aufnehmen) aufgenommen.add(b);
    }
    for (const b of ladung) {
      if (!inHalle(b)) fehler.push(`Tour ${tourNr(ctx, l.id)} soll Behälter ${b} laden, der nicht mehr in der Halle steht.`);
      l.anBord.add(b);
    }
    l.ladung = ladung;
    l.min.laden += a.ladezeitMin;
    l.t += a.ladezeitMin;
    l.abfahrt = l.t;
  }

  // Touren parallel abarbeiten; an Übergaben warten beide aufeinander
  let fortschritt = true;
  while (fortschritt) {
    fortschritt = false;
    for (const l of laeufe) {
      while (!l.fertig && !l.wartet) {
        fortschritt = true;
        if (l.idx >= l.schritte.length) {
          if (l.s.defekt) {
            l.ende = l.t;
          } else {
            const km = wege.distanz(l.knoten, welt.basis.knoten);
            const m = fahrMinuten(km, a.tempoZwischenKmh);
            l.rueckfahrt = { abfahrt: l.t, ankunft: l.t + m, km, min: m, von: l.knoten };
            l.kmZw += km;
            l.min.fahrtZwischen += m;
            l.t += m;
            l.knoten = welt.basis.knoten;
            l.ende = l.t;
          }
          l.fertig = true;
          break;
        }
        const s = l.schritte[l.idx];
        if (s.art === 'bezirk') {
          const bz = welt.bezirke[tag.behaelter[s.behaelterId]?.zielbezirk];
          const stamm = tag.behaelter[s.behaelterId];
          if (!bz || !stamm) {
            fehler.push(`Unbekannter Behälter ${s.behaelterId}.`);
            l.idx++;
            continue;
          }
          if (l.s.defekt) fehler.push(`Tour ${tourNr(ctx, l.id)} hat einen Defekt und kann ${s.behaelterId} nicht zustellen.`);
          if (!l.anBord.has(s.behaelterId)) fehler.push(`Behälter ${s.behaelterId} ist nicht an Bord von Tour ${tourNr(ctx, l.id)}.`);
          const abfahrt = l.t;
          const km = wege.distanz(l.knoten, bz.anfahrpunkt);
          if (!Number.isFinite(km)) fehler.push(`Bezirk ${bz.id} ist von Tour ${tourNr(ctx, l.id)} aus nicht erreichbar.`);
          const anfahrtMin = fahrMinuten(km, a.tempoZwischenKmh);
          const innenMin = fahrMinuten(bz.innenKm, a.tempoImGebietKmh);
          const z = zustellMinuten(stamm.inhalt, a);
          const ankunft = abfahrt + anfahrtMin;
          const ende = ankunft + innenMin + z.summe;
          l.aus.push({
            schritt: s,
            abfahrt,
            ankunft,
            beginn: ankunft,
            ende,
            von: l.knoten,
            nach: bz.anfahrpunkt,
            anfahrtKm: km,
            anfahrtMin,
            innenKm: bz.innenKm,
            innenMin,
            zustellMin: z.summe,
            wartenMin: 0,
            uebergabeMin: 0,
          });
          l.kmZw += km;
          l.kmIn += bz.innenKm;
          l.min.fahrtZwischen += anfahrtMin;
          l.min.fahrtInnen += innenMin;
          l.min.zustellung += z.summe;
          l.zust = { pakete: l.zust.pakete + z.pakete, briefe: l.zust.briefe + z.briefe, zeitungen: l.zust.zeitungen + z.zeitungen, summe: l.zust.summe + z.summe };
          l.menge = addInhalt(l.menge, stamm.inhalt);
          l.anBord.delete(s.behaelterId);
          l.zustellt.push(s.behaelterId);
          l.t = ende;
          l.knoten = bz.anfahrpunkt;
          l.idx++;
        } else {
          let km = 0;
          if (l.s.defekt) {
            if (s.treffpunkt !== l.knoten) fehler.push(`Tour ${tourNr(ctx, l.id)} hat einen Defekt; die Übergabe muss am Standort stattfinden.`);
          } else km = wege.distanz(l.knoten, s.treffpunkt);
          const m = fahrMinuten(km, a.tempoZwischenKmh);
          l.wartet = { schritt: s, abfahrt: l.t, ankunft: l.t + m, von: l.knoten, km, fahrMin: m };
          l.kmZw += km;
          l.min.fahrtZwischen += m;
          l.t += m;
          l.knoten = s.treffpunkt;
        }
      }
    }
    // Übergaben auflösen, sobald beide Seiten da sind
    for (const l of laeufe) {
      if (!l.wartet) continue;
      const s = l.wartet.schritt;
      const p = lauf.get(s.partner);
      if (!p || !p.wartet || p.wartet.schritt.id !== s.id) continue;
      const ps = p.wartet.schritt;
      if (
        ps.partner !== l.id ||
        ps.treffpunkt !== s.treffpunkt ||
        !gleicheMenge(ps.abgeben, s.aufnehmen) ||
        !gleicheMenge(ps.aufnehmen, s.abgeben)
      ) {
        fehler.push(`Übergabe ${s.id} passt bei Tour ${tourNr(ctx, l.id)} und Tour ${tourNr(ctx, p.id)} nicht zusammen.`);
      }
      const treffen = Math.max(l.wartet.ankunft, p.wartet.ankunft);
      for (const [x, y] of [
        [l, p],
        [p, l],
      ] as const) {
        const w = x.wartet!;
        const warten = treffen - w.ankunft;
        x.min.warten += warten;
        x.min.uebergabe += a.uebergabeMin;
        for (const b of w.schritt.abgeben) {
          if (!x.anBord.has(b)) fehler.push(`Behälter ${b} ist bei der Übergabe nicht an Bord von Tour ${tourNr(ctx, x.id)}.`);
          x.anBord.delete(b);
          y.anBord.add(b);
        }
        x.aus.push({
          schritt: w.schritt,
          abfahrt: w.abfahrt,
          ankunft: w.ankunft,
          beginn: treffen,
          ende: treffen + a.uebergabeMin,
          von: w.von,
          nach: w.schritt.treffpunkt,
          anfahrtKm: w.km,
          anfahrtMin: w.fahrMin,
          innenKm: 0,
          innenMin: 0,
          zustellMin: 0,
          wartenMin: warten,
          uebergabeMin: a.uebergabeMin,
        });
      }
      for (const x of [l, p]) {
        x.t = treffen + a.uebergabeMin;
        x.idx++;
        x.wartet = null;
      }
      fortschritt = true;
    }
  }
  for (const l of laeufe) {
    if (l.wartet) {
      fehler.push(`Tour ${tourNr(ctx, l.id)} wartet vergeblich am Treffpunkt ${l.wartet.schritt.treffpunktName}.`);
      l.ende = l.t;
    }
  }

  // Ergebnis je Tour
  const touren: Record<string, TourAuswertung> = {};
  const summe: PlanAuswertung['summe'] = {
    km: 0,
    kmZwischen: 0,
    kmInnen: 0,
    arbeitMin: 0,
    bezahltMin: 0,
    ueberstundenMin: 0,
    kosten: { ...KEINE_KOSTEN },
    aktiveTouren: 0,
    menge: { pakete: 0, briefe: 0, zeitungen: 0 },
  };
  const restAnBord: string[] = [];
  for (const l of laeufe) {
    const dauer = l.aktiv ? l.ende - l.s.schichtbeginn : 0;
    const kmGesamt = l.kmZw + l.kmIn;
    const kosten = tourKosten(l.aktiv, dauer, kmGesamt, a);
    const ueber = l.aktiv ? Math.max(0, dauer - schichtMin(a)) : 0;
    // Zustellzeit des ganzen Tages: bisher (anteilig nicht aufgeschlüsselt) + ab Start
    const bisherZust = l.s.bisher.min.zustellung;
    const bisherMenge = zustellMinuten(l.s.bisher.menge, a);
    const faktor = bisherMenge.summe > 0 ? bisherZust / bisherMenge.summe : 0;
    const zustellung: ZustellZeit = {
      pakete: l.zust.pakete + bisherMenge.pakete * faktor,
      briefe: l.zust.briefe + bisherMenge.briefe * faktor,
      zeitungen: l.zust.zeitungen + bisherMenge.zeitungen * faktor,
      summe: l.zust.summe + bisherZust,
    };
    const rest = [...l.anBord];
    restAnBord.push(...rest);
    touren[l.id] = {
      tourId: l.id,
      aktiv: l.aktiv,
      besetzt: l.s.besetzt,
      defekt: l.s.defekt,
      springer: l.s.springer,
      schichtbeginn: l.s.schichtbeginn,
      start: l.s.zeit,
      abfahrt: l.abfahrt,
      ende: l.aktiv ? l.ende : l.s.zeit,
      dauer,
      ueberstundenMin: ueber,
      km: { zwischen: l.kmZw, innen: l.kmIn, gesamt: kmGesamt },
      min: { ...l.min, gesamt: summeMinuten(l.min) },
      zustellung,
      menge: l.menge,
      kosten,
      schritte: l.aus,
      rueckfahrt: l.rueckfahrt,
      ladung: l.ladung,
      zustellt: l.zustellt,
      restAnBord: rest,
    };
    if (l.aktiv) {
      summe.aktiveTouren++;
      summe.arbeitMin += dauer;
      summe.bezahltMin += schichtMin(a) + ueber;
    }
    summe.km += kmGesamt;
    summe.kmZwischen += l.kmZw;
    summe.kmInnen += l.kmIn;
    summe.ueberstundenMin += ueber;
    summe.menge = addInhalt(summe.menge, l.menge);
    for (const k of ['schicht', 'ueberstunden', 'km', 'fahrzeug', 'summe'] as const) summe.kosten[k] += kosten[k];
  }

  // Nicht zugestellt: liegen gelassen, an Bord geblieben oder nie geladen
  const zugestellt = new Set<string>([...erledigt]);
  for (const l of laeufe) for (const b of l.zustellt) zugestellt.add(b);
  const liegenIds = tag.behaelterIds.filter((b) => !zugestellt.has(b));
  for (const b of restAnBord) {
    if (!plan.liegenLassen.includes(b)) fehler.push(`Behälter ${b} bleibt an Bord und wird nicht zugestellt.`);
  }
  let liegenMenge: Inhalt = { pakete: 0, briefe: 0, zeitungen: 0 };
  for (const b of liegenIds) liegenMenge = addInhalt(liegenMenge, tag.behaelter[b].inhalt);

  return {
    touren,
    tourIds: tag.touren.map((t) => t.id),
    summe,
    liegen: { behaelter: liegenIds, menge: liegenMenge },
    gueltig: fehler.length === 0,
    fehler: [...new Set(fehler)],
  };
}

function gleicheMenge(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

function tourNr(ctx: Kontext, id: string): number | string {
  return ctx.tag.touren.find((t) => t.id === id)?.nr ?? id;
}

// ---------------------------------------------------------------------------------------
// Vergleich zweier Pläne
// ---------------------------------------------------------------------------------------

export interface Delta {
  km: number;
  arbeitMin: number;
  bezahltMin: number;
  ueberstundenMin: number;
  euroTag: number;
  euroJahr: number;
  aktiveTouren: number;
  /** Touren, deren Zeit, Strecke oder Behälter sich ändern */
  betroffen: string[];
  /** nicht zugestellte Behälter: neu − alt */
  liegen: number;
}

/** Änderung von alt nach neu (negativ = weniger). euroTag positiv heißt: neu ist billiger (Ersparnis). */
export function vergleiche(alt: PlanAuswertung, neu: PlanAuswertung, a: Annahmen): Delta {
  const betroffen: string[] = [];
  for (const id of neu.tourIds) {
    const x = alt.touren[id];
    const y = neu.touren[id];
    if (!x || !y) continue;
    const anders =
      x.aktiv !== y.aktiv ||
      Math.abs(x.ende - y.ende) > 0.01 ||
      Math.abs(x.km.gesamt - y.km.gesamt) > 0.001 ||
      x.zustellt.join() !== y.zustellt.join() ||
      x.schritte.length !== y.schritte.length;
    if (anders) betroffen.push(id);
  }
  const euroTag = alt.summe.kosten.summe - neu.summe.kosten.summe;
  return {
    km: neu.summe.km - alt.summe.km,
    arbeitMin: neu.summe.arbeitMin - alt.summe.arbeitMin,
    bezahltMin: neu.summe.bezahltMin - alt.summe.bezahltMin,
    ueberstundenMin: neu.summe.ueberstundenMin - alt.summe.ueberstundenMin,
    euroTag,
    euroJahr: euroTag * a.zustelltageProJahr,
    aktiveTouren: neu.summe.aktiveTouren - alt.summe.aktiveTouren,
    betroffen,
    liegen: neu.liegen.behaelter.length - alt.liegen.behaelter.length,
  };
}

/** Behälter der Touren in Gangfolge (nur Bezirksschritte) */
export function behaelterFolge(plan: Plan, tourId: string): string[] {
  return (plan.touren[tourId]?.schritte ?? []).flatMap((s) => (s.art === 'bezirk' ? [s.behaelterId] : []));
}

/** Plan aus reinen Behälterfolgen (ohne Übergaben) */
export function planAusFolgen(folgen: Record<string, string[]>, liegenLassen: string[] = []): Plan {
  const touren: Plan['touren'] = {};
  for (const [id, folge] of Object.entries(folgen)) touren[id] = { schritte: folge.map((b) => ({ art: 'bezirk' as const, behaelterId: b })) };
  return { touren, liegenLassen: [...liegenLassen] };
}

export function kopierePlan(plan: Plan): Plan {
  return structuredClone(plan);
}
