/**
 * Drehbuch der geführten Demo (gut 2 Minuten): ein normaler Tag mit Beladen, Prognose,
 * Vorschlag mit Vorschau und Rechenweg, Nachricht an die Fahrer/innen, Übergabe am
 * Treffpunkt, Panne, „Idee in Zahlen“ und Datenschutz. Alles läuft über dieselben
 * Aktionen wie die Bedienung von Hand.
 */
import { G } from '../../glossar';
import { uebergabeZeiten } from '../../core/benachrichtigung';
import { fmtDauer, fmtEuro, fmtUhr } from '../../core/format';
import { rechenwegErsparnis } from '../../core/rechenweg';
import { ortName } from '../../core/uebergabe';
import { tourName, type Vorschlag } from '../../core/vorschlaege';
import { S } from '../../szene/koord';
import { useAnsicht } from '../../state/ansicht';
import { simUhr, useLeitstand } from '../../state/store';
import { basisZeigen, ganzeKarte, vorschauOeffnen, waehleUndZeige } from '../aktionen';
import { useRechenwegDialog } from '../Rechenweg';
import type { Drehbuch } from './regie';

const L = () => useLeitstand.getState();
const A = () => useAnsicht.getState();

/** Name einer Tour im aktuellen Tag */
const tour = (id: string | null) => (L().ctx ? tourName(L().ctx!, id) : (id ?? ''));

export const DREHBUCH: Drehbuch = {
  anzahl: 11,
  ende: {
    titel: 'Ende der Demo',
    text: 'Alles Gezeigte ist simuliert, alle Daten sind erfunden. Zum Ausprobieren: Szenarien, Vorschläge, Umplanen per Ziehen oder Antippen, Geräte-Ansicht im Menü.',
  },
  ablauf: async (d) => {
    let vorschlag: Vorschlag | undefined;

    // 1 · Überblick
    await d.schritt(7000, async () => {
      d.zeige(`Zustell-${G.leitstand} 3D`, 'Ein Prototyp. Die Zustellbasis ist erfunden, alles läuft in einer Simulation.');
      useRechenwegDialog.getState().schliessen();
      A().waehlen(null);
      A().folgenSetzen(null);
      A().draufsichtSetzen(false);
      await L().szenarioBeenden();
      ganzeKarte();
      const { ctx } = L();
      if (ctx)
        d.zeige(
          `Zustell-${G.leitstand} 3D`,
          `Ein Prototyp für die erfundene Basis „${ctx.welt.name}“: ${ctx.tag.touren.length} ${G.touren}, ${ctx.tag.behaelterIds.length} ${G.rollbehaelterPlural}. Alle Daten sind simuliert.`,
        );
    });

    // 2 · Beladen an den Rampen
    await d.schritt(12000, () => {
      basisZeigen();
      L().zeitSetzen(6 * 60 + 57);
      d.uhr(60);
      d.zeige('07:00 · Beladen', `Jeder Verladescan zeigt, welcher ${G.rollbehaelter} in welches ${G.fahrzeug} kommt. Die Behälter selbst haben keinen Tracker.`);
    });

    // 3 · Unterwegs
    await d.schritt(10000, () => {
      ganzeKarte();
      d.uhr(240);
      d.zeige('Unterwegs', `Die Position kommt nur vom Handscanner im ${G.fahrzeug} – einmal pro Minute und nur während der Tour. Jedes Haus leuchtet kurz bei einer Zustellung.`);
    });

    // 4 · Prognose um 10:00
    await d.schritt(9000, () => {
      d.uhrStopp();
      L().zeitSetzen(10 * 60);
      const p = L().prognose;
      if (!p) return;
      const id = p.tourIds.reduce((a, b) => (p.touren[b].ueberstundenMin > p.touren[a].ueberstundenMin ? b : a));
      // dieselbe Rückkehrzeit wie in der Tourliste und im Panel
      const rueckkehr = L().lage?.prognose(id, simUhr.zeit).rueckkehr ?? p.touren[id].ende;
      waehleUndZeige({ art: 'fahrzeug', id });
      d.zeige(
        '10:00 · Prognose',
        p.touren[id].ueberstundenMin > 0.5
          ? `${tour(id)} kommt laut Prognose erst gegen ${fmtUhr(rueckkehr)} zurück – mit Überstunden. Die Prognose rechnet mit dem Tempo, das die Scans bisher zeigen.`
          : `Die Prognose rechnet mit dem Tempo, das die Scans bisher zeigen: ${tour(id)} kommt gegen ${fmtUhr(rueckkehr)} zurück.`,
      );
    });

    // 5 · Vorschlag und Vorschau
    await d.schritt(13000, async () => {
      A().seiteZeigen('vorschlaege');
      d.zeige(`Der ${G.leitstand} schlägt vor`, 'Aus der Lage ab jetzt rechnet er, was sich lohnt – Entscheidung bleibt bei der Basisleitung.');
      await d.wartenAuf(() => !L().vorschlaegeLaden && L().vorschlaege.length > 0, 9000);
      const liste = L().vorschlaege;
      vorschlag = liste.find((v) => v.art === 'ueberlastung' && v.uebergaben.length > 0) ?? liste.find((v) => v.art !== 'gesamt') ?? liste[0];
      if (!vorschlag) return;
      await d.warte(2500);
      vorschauOeffnen(L().vorschauAusVorschlag(vorschlag));
      const u = vorschlag.uebergaben[0];
      const frueher = u ? vorschlag.alt.touren[u.von].ende - vorschlag.neu.touren[u.von].ende : 0;
      const was = u
        ? `${G.behaelter} ${u.abgeben.join(', ')}: ${tour(u.von)} → ${tour(u.nach)}, Übergabe ${fmtUhr(u.zeit)} am ${ortName(u.treffpunkt.name)}.` +
          (frueher > 0.5 ? ` ${tour(u.von)} ist damit ${fmtDauer(frueher)} früher fertig.` : '')
        : vorschlag.text;
      d.zeige(vorschlag.titel, `${was} Die Vorschau zeigt die neuen Wege in 3D und rechnet Δ km, Δ Zeit und Δ € aus.`);
    });

    // 6 · Rechenweg
    await d.schritt(9000, async () => {
      const v = L().vorschau;
      const ctx = L().ctxLive;
      if (v && ctx) useRechenwegDialog.getState().zeigen(rechenwegErsparnis(ctx, v.alt, v.neu, v.delta, v.wiederkehrend));
      d.zeige('Wie kommt die Zahl zustande?', 'Jede Euro-Zahl lässt sich antippen: Rechenweg mit den eingesetzten Werten. Alle Annahmen sind markiert und änderbar.');
      await d.warte(8000);
      useRechenwegDialog.getState().schliessen();
    });

    // 7 · Übernehmen: Nachricht an die Geräte
    await d.schritt(9000, () => {
      useRechenwegDialog.getState().schliessen();
      L().fahrerSimulierenSetzen(true);
      const u = vorschlag?.uebergaben[0];
      if (L().vorschau) L().vorschauUebernehmen();
      if (u) waehleUndZeige({ art: 'fahrzeug', id: u.nach });
      d.uhr(60);
      d.zeige(
        'Übernehmen',
        u
          ? `${tour(u.von)} und ${tour(u.nach)} bekommen sofort eine Nachricht auf den Handscanner – was sich ändert, wann und wo die Übergabe ist – und bestätigen mit „Verstanden“.`
          : 'Die betroffenen Fahrer/innen bekommen sofort eine Nachricht auf den Handscanner und bestätigen mit „Verstanden“.',
      );
    });

    // 8 · Übergabe am Treffpunkt
    await d.schritt(14000, async () => {
      const u = vorschlag?.uebergaben[0];
      const { welt } = L();
      if (!u || !welt) {
        d.zeige('Unterwegs', 'Die Touren fahren nach dem neuen Plan weiter.');
        return;
      }
      d.uhrStopp();
      const t = uebergabeZeiten(L().prognose).get(u.id) ?? u.zeit;
      if (simUhr.zeit < t - 1) L().zeitSetzen(t - 1);
      const k = welt.netz.knoten[u.treffpunkt.knoten];
      A().waehlen(null);
      A().folgenSetzen(null);
      const schmal = window.innerWidth < 820;
      A().fliegen({ ziel: [k.x * S, 0, -k.y * S], distanz: schmal ? 45 : 26, polar: 0.95 });
      d.zeige(
        `Übergabe am ${ortName(u.treffpunkt.name)}`,
        `Geplant ${fmtUhr(t)}: ${tour(u.von)} gibt ${G.behaelter} ${u.abgeben.join(', ')} an ${tour(u.nach)} ab. Einen eigenen Scan braucht es dafür nicht – der Ladescan im anderen ${G.fahrzeug} zeigt, dass es geklappt hat.`,
      );
      // bis der Ladescan im anderen Fahrzeug kommt (die Simulation weicht etwas vom Plan ab)
      d.uhr(60);
      const b = u.abgeben[0] ?? u.aufnehmen[0];
      await d.wartenAuf(() => !!L().lage?.behaelter(b).umgeladen, 20000);
      // langsamer, damit man das Umladen sieht (der Bogen dauert 2 Sim-Minuten)
      d.uhr(15);
      await d.warte(9000);
    });

    // 9 · Panne
    await d.schritt(17000, async () => {
      d.uhrStopp();
      await L().szenarioStarten('defekt', { tourId: 'T2' });
      const sz = L().szenario;
      const id = sz?.art === 'defekt' ? sz.tourId : undefined;
      if (!id) {
        d.zeige('Panne', `Gerade ist kein ${G.fahrzeug} mit ${G.behaelterPlural} unterwegs.`);
        return;
      }
      waehleUndZeige({ art: 'fahrzeug', id });
      d.zeige(
        `${fmtUhr(simUhr.zeit)} · Panne bei ${tour(id)}`,
        `Das ${G.fahrzeug} fährt den laufenden ${G.bezirk} zu Ende und bleibt dann stehen. Was noch an Bord ist, bliebe heute liegen.`,
      );
      const passt = (v: Vorschlag) => v.art === 'ausfall' && v.titel.startsWith('Panne');
      await d.wartenAuf(() => !L().vorschlaegeLaden && L().vorschlaege.some(passt), 9000);
      await d.warte(3500);
      const v = L().vorschlaege.find(passt);
      if (!v) return;
      vorschauOeffnen(L().vorschauAusVorschlag(v));
      d.zeige(v.titel, `${v.text} Wer übernimmt, bekommt die Übergabe als Nachricht aufs Gerät.`);
      await d.warte(7500);
      if (L().vorschau) L().vorschauUebernehmen();
      d.uhr(60);
      d.zeige('Übernommen', 'Der neue Plan gilt ab jetzt. Die Übergabe am Standort steht in der Stoppliste der übernehmenden Tour.');
    });

    // 10 · Idee in Zahlen
    await d.schritt(13000, async () => {
      d.uhrStopp();
      A().folgenSetzen(null);
      window.location.hash = '#/zahlen';
      window.scrollTo(0, 0);
      d.zeige('Idee in Zahlen', 'Und an einem ganz normalen Tag?');
      L().zahlenAnfordern();
      await d.wartenAuf(() => !!L().zahlen && !L().zahlenLaden, 9000);
      const z = L().zahlen;
      if (z)
        d.zeige(
          'Idee in Zahlen',
          `Mit den Vorschlägen kostet ein normaler Tag ${fmtEuro(z.alltag.delta.euroTag)} weniger – ${fmtEuro(z.alltag.delta.euroJahr, true)} im Jahr. Jede Zahl mit Rechenweg, jede Annahme änderbar.`,
        );
      await d.warte(6500);
      document.querySelector('.seiten-ueberschrift')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // 11 · Datenschutz
    await d.schritt(10000, () => {
      document.querySelector('.zahlen-zwei')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      d.zeige(
        'Keine neue Hardware · Datenschutz von Anfang an',
        'Nur Scans, die ohnehin entstehen. Positionen nur fahrzeugbezogen und nur während der Tour, Pseudonyme statt Namen, keine Ranglisten. Einführung nur mit Betriebsrat (§ 87 Abs. 1 Nr. 6 BetrVG).',
      );
    });
  },
};
