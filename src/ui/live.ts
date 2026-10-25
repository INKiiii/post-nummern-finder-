// Live-Modus (Hauptbildschirm): Karte über den ganzen Bildschirm, darüber schwebend oben die
// Straße und je Seite das nächste Haus (groß, mit Entfernung), unten Ziel und Knöpfe.
// Seitenfarben ziehen sich durch: links blau, rechts orange – oben im Kopf und auf der Karte
// (das nächste Haus je Seite ist dort genauso farbig hinterlegt). Während der Fahrt rein
// anzeigend: keine Pop-ups; Eingaben nur im Stand.

import { h, overlay } from './dom';
import { show } from './app';
import { icon, type IconName } from './icons';
import { state } from '../data';
import { findHouse, drivewayFor, distanceToStreet, nearestStreets } from '../core';
import { gps, type Fix } from '../gps';
import { formatDistance } from '../guidance';
import { MapView } from '../mapview';
import { currentMatch, forceStreet, getTarget, matcher, onMatch, setTarget } from '../session';
import { houseMarks, upcomingNumbers, targetInfo, type Preview, type TargetInfo, type Upcoming } from '../preview';
import { ApproachAlert, beep, soundEnabled, unlockAudio } from '../approach';
import { passBeepEnabled } from '../settings';
import { keepAwake } from '../wakelock';
import { locationDeniedBox } from './location';
import { emptyHouseInfo, getHouseInfo, houseKey, isEmpty, summarize } from '../houseinfo';
import { openEditor } from './editor';
import { hereMenu, longPressMenu } from './points';
import { inTour, nextTourStreet, tourSuggestions } from '../tour';
import { onStatusChange, statusSummary, type StatusSummary } from '../status';
import type { Match } from '../matcher';
import type { FindResult, Street } from '../types';

/** Ab dieser Geschwindigkeit (m/s, ~11 km/h) sind Eingaben gesperrt: „Eingabe im Stand“. */
export const DRIVING_SPEED = 3;
/** Ab dieser Ungenauigkeit (m) gibt es einen deutlichen Hinweis. */
export const GPS_WARN_M = 15;

export function liveScreen(root: HTMLElement) {
  void keepAwake();
  const map = new MapView({ live: true });

  // ---------- Kopf: Straße + nächstes Haus je Seite ----------
  const streetEl = h('div', { class: 'lt-street' });
  const placeEl = h('div', { class: 'lt-place' });
  const nameBtn = h('button', { class: 'lt-namebtn', 'aria-label': 'Straße korrigieren' }, streetEl, placeEl);
  const gpsEl = h('div', { class: 'lt-gps' });
  const leftEl = h('div', { class: 'lt-side lt-left' });
  const rightEl = h('div', { class: 'lt-side lt-right' });
  const previewEl = h('div', { class: 'lt-preview' }, leftEl, rightEl);
  const msgEl = h('div', { class: 'lt-msg' });
  const deniedEl = locationDeniedBox(true);
  const head = h(
    'header',
    { class: 'live-top hud' },
    h('div', { class: 'lt-row1' }, h('div', { class: 'lt-name' }, nameBtn), gpsEl),
    previewEl,
    msgEl,
    deniedEl,
  );

  // ---------- Ziel (unten, direkt unter dem Fahrzeug) ----------
  const tIcon = h('div', { class: 'dir-icon' });
  const tDist = h('div', { class: 'dist' });
  const tSide = h('div', { class: 'side' });
  const tNr = h('div', { class: 'goal-nr' });
  const tStreetName = h('div', { class: 'goal-street' });
  const tTags = h('span', { class: 'tag-list' });
  const tInfo = h('button', { class: 'tag lt-info' });
  const tClose = h('button', { class: 'round-btn lt-close', 'aria-label': 'Ziel löschen' }, icon('close', 22));
  const tagsEl = h('div', { class: 'tags' }, tStreetName, tTags, tInfo);
  const targetCard = h(
    'section',
    { class: 'live-target dircard' },
    h('div', { class: 'lt-trow' }, tIcon, h('div', { class: 'dir-text' }, tDist, tSide), tNr, tClose),
    tagsEl,
  );

  // ---------- Leiste unten ----------
  const searchBtn = h('button', { class: 'pill-btn next lb-search' }, icon('search', 24), h('span', null, 'Nr. suchen'));
  const hereBtn = h('button', { class: 'pill-btn here lb-here' }, icon('pin', 24), h('span', null, 'Hier'));
  const zoomOut = h('button', { class: 'sq-btn', 'aria-label': 'Weiter weg' }, icon('minus', 26));
  const zoomIn = h('button', { class: 'sq-btn', 'aria-label': 'Näher heran' }, icon('plus', 26));
  const recenterBtn = h('button', { class: 'sq-btn accent', 'aria-label': 'Zurück zur Position' }, icon('locate', 26));
  // Ansicht: Navi (geneigt, Blick in Fahrtrichtung) oder flach – gemerkt
  const viewBtn = h('button', { class: 'sq-btn view-btn' });
  const renderViewBtn = () => {
    const navi = map.getMode() === 'navi';
    viewBtn.textContent = navi ? '2D' : '3D';
    viewBtn.setAttribute('aria-label', navi ? 'Flache Karte' : 'Navi-Ansicht (Blick in Fahrtrichtung)');
  };
  renderViewBtn();
  const menuBadge = h('span', { class: 'badge-attn', 'aria-hidden': 'true' }, '!');
  const menuBtn = h('button', { class: 'sq-btn menu-btn', 'aria-label': 'Menü' }, icon('menu', 26), menuBadge);
  menuBadge.hidden = true;
  const renderBadge = async () => {
    const st = await statusSummary();
    menuBadge.hidden = !st.attention;
    menuBtn.setAttribute('aria-label', st.attention ? 'Menü (Hinweis)' : 'Menü');
  };
  const bar = h('footer', { class: 'live-bar' }, searchBtn, hereBtn, menuBtn);
  const bottom = h('div', { class: 'live-bottom' }, targetCard, bar);
  map.controls.append(zoomIn, zoomOut, viewBtn, recenterBtn);
  recenterBtn.hidden = true;

  root.append(map.root, head, bottom);

  // Freier Kartenbereich zwischen Kopf und Leiste: danach richten sich Fahrzeug und Sicht voraus.
  // Quer (Laptop, Handy quer) stehen Kopf und Leiste als Spalte links, die Karte nutzt den Rest.
  const sideLayout = matchMedia('(orientation: landscape) and (min-width: 600px)');
  const measure = () => {
    const r = map.root.getBoundingClientRect();
    if (!r.height) return;
    const hr = head.getBoundingClientRect();
    const br = bottom.getBoundingClientRect();
    if (sideLayout.matches) map.setInsets(0, 0, Math.max(hr.right, br.right) - r.left + 4);
    else map.setInsets(hr.bottom - r.top + 4, r.bottom - br.top + 4);
  };
  const ro = new ResizeObserver(measure);
  ro.observe(head);
  ro.observe(bottom);
  ro.observe(map.root);

  // ---------- Ziel auflösen ----------
  let tStreet: Street | null = null;
  let tRes: FindResult | null = null;
  let tDrive: ReturnType<typeof drivewayFor> = null;
  let tIndex: unknown = null;
  let tKey = '';
  const alert = new ApproachAlert();
  let wasPassed = false;

  const resolveTarget = () => {
    const t = getTarget();
    const key = t ? `${t.streetId}|${t.number}` : '';
    if (key === tKey && tIndex === state.index) return;
    if (key !== tKey) wasPassed = false;
    tKey = key;
    tIndex = state.index;
    tStreet = t ? state.index.streets.get(t.streetId) ?? null : null;
    if (!t || !tStreet) {
      tRes = null;
      tDrive = null;
      return;
    }
    const m = currentMatch();
    tRes = findHouse(tStreet, t.number, m ? m.pos : null);
    tDrive = t.number ? drivewayFor(tStreet, t.number, tRes) : null;
  };

  // ---------- Darstellung ----------
  const numText = (u: Upcoming) => (u.n.user ? `•${u.n.label}` : u.n.label);
  const numCls = (u: Upcoming) => (u.n.source === 'osm-interp' ? ' est' : '') + (u.n.user ? ' user' : '');
  /** Entfernung zum nächsten Haus: „jetzt“, wenn man daneben ist, sonst in 5-m-Schritten */
  const distText = (ahead: number) => (ahead <= 6 ? 'jetzt' : `${Math.max(10, Math.round(ahead / 5) * 5)} m`);
  const sideCard = (el: HTMLElement, side: 'left' | 'right', list: Upcoming[], wait = false) => {
    const [first, ...rest] = list;
    const cap = h('div', { class: 'lt-cap' }, side === 'left' ? '◀ LINKS' : 'RECHTS ▶');
    if (!first) {
      // gleiche Höhe wie mit Nummern: der Kopf springt nicht (und die Karte darunter auch nicht)
      el.replaceChildren(
        cap,
        h('div', { class: 'lt-main' }, h('span', { class: 'lt-none' }, wait ? '…' : 'keine')),
        h('div', { class: 'lt-rest lt-then' }, wait ? 'nach ein paar Metern' : ''),
      );
      return;
    }
    const now = first.ahead <= 6;
    const restEls: (HTMLElement | string)[] = [];
    rest.forEach((u, i) => {
      if (i) restEls.push(h('span', { class: 'lt-dot' }, '·'));
      restEls.push(h('span', { class: 'lt-num' + numCls(u) }, numText(u)));
    });
    el.replaceChildren(
      cap,
      h(
        'div',
        { class: 'lt-main' },
        h('span', { class: 'lt-num lt-next' + numCls(first) }, numText(first)),
        h('span', { class: 'lt-dist' + (now ? ' now' : '') }, distText(first.ahead)),
      ),
      h('div', { class: 'lt-rest' }, ...(restEls.length ? [h('span', { class: 'lt-then' }, 'dann '), ...restEls] : [])),
    );
  };

  const renderHead = (m: Match | null, fix: Fix | null): Preview | null => {
    deniedEl.hidden = !gps.denied;
    if (gps.denied) {
      streetEl.textContent = 'Kein Standort';
      placeEl.textContent = '';
      gpsEl.replaceChildren();
      previewEl.hidden = true;
      msgEl.hidden = true;
      return null;
    }
    // GPS-Genauigkeit: immer sichtbar, ab 15 m deutlicher Hinweis
    if (!fix) {
      gpsEl.className = 'lt-gps warn';
      gpsEl.replaceChildren(icon('locate', 16), 'GPS sucht …');
    } else if (fix.accuracy > GPS_WARN_M) {
      gpsEl.className = 'lt-gps warn';
      gpsEl.replaceChildren(icon('warn', 16), `ungenau ±${Math.round(fix.accuracy)} m`);
    } else {
      gpsEl.className = 'lt-gps';
      gpsEl.replaceChildren(h('span', { class: 'gps-dot' }), `GPS ±${Math.round(fix.accuracy)} m`);
    }
    const st = m?.street ?? null;
    if (!st) {
      streetEl.textContent = fix ? 'Keine Straße erkannt' : 'Warte auf Standort …';
      streetEl.classList.remove('long');
      placeEl.textContent = '';
      previewEl.hidden = true;
      msgEl.hidden = !fix;
      msgEl.replaceChildren(
        !state.packages.length && !state.ustreets.length
          ? h('button', { class: 'lt-msg-btn', onClick: () => show('regions') }, 'Kein Gebiet geladen – hier tippen')
          : nearestStreets(state.index, fix?.lat ?? 0, fix?.lon ?? 0, 2000, 1).length
            ? h('span', null, 'Keine Straße in der Nähe (über 25 m).')
            : h('button', { class: 'lt-msg-btn', onClick: () => show('regions') }, 'Gebiet fehlt hier – Gebiete laden'),
      );
      return null;
    }
    streetEl.textContent = st.name;
    streetEl.classList.toggle('long', st.name.length > 18);
    // Tour: Teil und nächste Straße der heutigen Reihenfolge
    const t = inTour(st);
    const next = t ? nextTourStreet(state.index, st) : null;
    placeEl.textContent = [st.place, t ? `Tour ${t.part}` : '', next ? `danach ${next.street.name}` : ''].filter(Boolean).join(' · ');
    const p = upcomingNumbers(matcher, m);
    if (!p) {
      if (st.numbers.length) {
        // Richtung noch unklar (z. B. gleich nach dem Abbiegen): Platzhalter statt Kopf umbauen
        previewEl.hidden = false;
        msgEl.hidden = true;
        sideCard(leftEl, 'left', [], true);
        sideCard(rightEl, 'right', [], true);
      } else {
        previewEl.hidden = true;
        msgEl.hidden = false;
        msgEl.textContent = 'Keine Hausnummern bekannt.';
      }
      return null;
    }
    msgEl.hidden = true;
    previewEl.hidden = false;
    sideCard(leftEl, 'left', p.left);
    sideCard(rightEl, 'right', p.right);
    return p;
  };

  type DirKind = 'right' | 'left' | 'straight' | 'behind' | 'here' | 'wait' | 'other';
  const ICONS: Record<DirKind, IconName> = {
    right: 'turnRight',
    left: 'turnLeft',
    straight: 'straight',
    behind: 'uturn',
    here: 'check',
    wait: 'locate',
    other: 'flag',
  };
  const paint = (kind: DirKind, dist: string, label: string) => {
    targetCard.className = `live-target dircard dir-${kind}`;
    tIcon.replaceChildren(icon(ICONS[kind], 30));
    tDist.textContent = dist;
    tDist.classList.toggle('long', dist.length > 7);
    tSide.textContent = label;
  };
  const SIDE = { left: 'LINKS', right: 'RECHTS' } as const;

  const renderTarget = (m: Match | null) => {
    const t = getTarget();
    targetCard.hidden = !t || !tStreet;
    hereBtn.hidden = !t || !tStreet || !t.number;
    if (!t || !tStreet || !tRes) {
      map.update({ target: null, driveway: null, neighbors: [], focus: m?.street ?? null });
      return;
    }
    // Ziel: Nummer groß (wie die Markierung auf der Karte), darunter die Straße
    tNr.textContent = t.number || '•';
    tNr.classList.toggle('est', !!tRes.estimated && tRes.status !== 'none');
    // Straßenname nur, wenn das Ziel nicht auf der Straße liegt, die oben steht
    tStreetName.textContent = `${tStreet.name} ${t.number}`.trim();
    tStreetName.hidden = !!m?.street && m.street.id === tStreet.id;
    // Hinweise: geschätzt / selbst gesetzt / Haus hinter der Straße / Einfahrt
    const tags: HTMLElement[] = [];
    if (tRes.estimated && tRes.status !== 'none') tags.push(h('span', { class: 'tag tag-y' }, 'geschätzt'));
    if (tRes.match?.user) tags.push(h('span', { class: 'tag tag-y' }, '• selbst gesetzt'));
    if (tRes.ambiguous) tags.push(h('span', { class: 'tag tag-y' }, 'Nr. mehrfach – nächste gewählt'));
    const off = tRes.status !== 'street' && Number.isFinite(tRes.lat) ? distanceToStreet(tStreet, tRes.lat, tRes.lon) : null;
    if (off !== null && off > 20) tags.push(h('span', { class: 'tag' }, `${Math.round(off)} m von der Straße`));
    if (tDrive?.user) tags.push(h('span', { class: 'tag tag-y' }, '• Einfahrt selbst gesetzt'));
    if (tRes.status === 'street') tags.push(h('span', { class: 'tag tag-y' }, 'Nr. unbekannt – Straßenmitte'));
    tTags.replaceChildren(...tags);
    const info = t.number ? getHouseInfo(houseKey(tStreet, t.number)) : undefined;
    tInfo.hidden = !t.number;
    tInfo.textContent = info && !isEmpty(info) ? summarize(info).join(' ') : '+ Haus-Info';
    tInfo.classList.toggle('empty', !info || isEmpty(info));

    const ti: TargetInfo | null = Number.isFinite(tRes.lat)
      ? targetInfo(
          matcher,
          m,
          { lat: tRes.lat, lon: tRes.lon, street: tStreet },
          tDrive ? { junction: tDrive.junction as [number, number], away: (tDrive.line[1] ?? tDrive.line[0]) as [number, number] } : null,
        )
      : null;
    const via = ti?.viaDriveway ? 'EINFAHRT ' : '';
    if (!Number.isFinite(tRes.lat)) paint('wait', '?', 'LAGE UNBEKANNT');
    else if (!ti) paint('wait', '…', 'WARTE AUF GPS');
    else if (ti.kind === 'passed') paint('behind', `Zurück ${formatDistance(ti.distance)}`, `VORBEI · ${via}${ti.side ? SIDE[ti.side] : ''}`.trim());
    else if (ti.kind === 'here') paint('here', 'Da', `${via ? 'EINFAHRT JETZT ' : 'HAUS '}${ti.side ? SIDE[ti.side] : ''}`.trim());
    else if (ti.kind === 'ahead') paint(ti.side === 'left' ? 'left' : 'right', formatDistance(ti.distance), `${via}${ti.side ? SIDE[ti.side] : ''}`);
    else if (ti.kind === 'unknown') paint('straight', formatDistance(ti.distance), 'SEITE NACH EIN PAAR METERN');
    else paint('other', formatDistance(ti.distance), 'LUFTLINIE · ANDERE STRASSE');

    // Töne (nur wenn eingeschaltet): Annäherung, Vorbeifahren
    if (ti && (ti.kind === 'ahead' || ti.kind === 'here') && soundEnabled()) alert.update(ti.distance, false);
    const passed = ti?.kind === 'passed';
    if (passed && !wasPassed && passBeepEnabled()) beep(3, 440);
    wasPassed = passed;

    map.update({
      target: Number.isFinite(tRes.lat) ? { lat: tRes.lat, lon: tRes.lon, label: t.number || '•', estimated: tRes.estimated } : null,
      neighbors: tRes.estimated ? tRes.neighbors : [],
      driveway: tDrive ? { line: tDrive.line as [number, number][], user: tDrive.user } : null,
      focus: tStreet,
    });
  };

  // Eingaben nur im Stand
  const renderInputs = (fix: Fix | null) => {
    const driving = !!fix && fix.speed !== null && fix.speed > DRIVING_SPEED;
    for (const b of [searchBtn, hereBtn]) {
      b.toggleAttribute('disabled', driving);
      b.classList.toggle('locked', driving);
    }
    searchBtn.lastElementChild!.textContent = driving ? 'Nur im Stand' : 'Nr. suchen';
  };

  const renderAll = (m: Match | null, fix: Fix | null) => {
    resolveTarget();
    const p = renderHead(m, fix);
    renderTarget(m);
    renderInputs(fix);
    map.update({
      car: m ? { pos: m.pos, bearing: m.bearing, accuracy: m.accuracy, speed: fix?.speed ?? null } : null,
      user: fix,
      index: state.index,
      emphasis: matcher.preferred,
      houses: houseMarks(matcher, m, p),
    });
    measure();
  };

  // ---------- Bedienung ----------
  searchBtn.addEventListener('click', () => {
    unlockAudio();
    show('search', { streetId: currentMatch()?.street?.id ?? getTarget()?.streetId });
  });
  hereBtn.addEventListener('click', () => {
    const t = getTarget();
    if (t && tStreet) hereMenu(tStreet, t.number, refresh);
  });
  tClose.addEventListener('click', () => {
    setTarget(null);
    refresh();
  });
  tInfo.addEventListener('click', () => {
    const t = getTarget();
    if (!t || !tStreet) return;
    const s = tStreet;
    openEditor(s, t.number, getHouseInfo(houseKey(s, t.number)) ?? emptyHouseInfo(s, t.number), refresh);
  });
  zoomIn.addEventListener('click', () => map.zoomStep(1));
  viewBtn.addEventListener('click', () => {
    map.setMode(map.getMode() === 'navi' ? 'heading' : 'navi');
    renderViewBtn();
  });
  zoomOut.addEventListener('click', () => map.zoomStep(-1));
  recenterBtn.addEventListener('click', () => map.recenter());
  map.onFollowChange = (f) => {
    recenterBtn.hidden = f;
    map.refresh();
  };
  menuBtn.addEventListener('click', () => openMenu());
  nameBtn.addEventListener('click', () => chooseStreet(refresh));
  map.onLongPress = (lat, lon) => {
    const t = getTarget();
    const near = nearestStreets(state.index, lat, lon, 80, 1)[0]?.street ?? currentMatch()?.street ?? null;
    longPressMenu(t && tStreet ? tStreet : near, lat, lon, t?.number ?? '', refresh);
  };

  function refresh() {
    tKey = '#';
    map.refresh();
    renderAll(currentMatch(), gps.fix);
  }

  renderAll(currentMatch(), gps.fix);
  void renderBadge();
  const unsubStatus = onStatusChange(() => void renderBadge());
  const unsub = onMatch((m, fix) => renderAll(m, fix));
  return () => {
    unsub();
    unsubStatus();
    ro.disconnect();
  };
}

/** Menü: selten Gebrauchtes, nur im Stand. Oben der ehrliche Status. */
function openMenu() {
  const item = (ic: IconName, label: string, fn: () => void, note = '') =>
    h('button', { class: 'menu-item', onClick: () => (close(), fn()) }, icon(ic, 26), h('span', null, label, note ? h('small', { class: 'menu-note' }, note) : null));
  const statusEl = h('div', { class: 'status-list' });
  const tourItem = item('list', 'Meine Tour', () => show('tour'), tourSuggestions(state.index).length ? 'Vorschlag: oft genutzte Straße' : '');
  const dataItem = item('data', 'Eigene Daten & Sicherung', () => show('data'));
  const regionsItem = item('map', 'Gebiete laden / aktualisieren', () => show('regions'));
  const close = overlay(
    h(
      'div',
      { class: 'dialog menu' },
      statusEl,
      tourItem,
      regionsItem,
      dataItem,
      item('road', 'Fehlende Straße anlegen', () => show('newstreet', {})),
      item('gear', 'Einstellungen & Info', () => show('settings')),
      h('button', { class: 'btn big', onClick: () => close() }, 'Schließen'),
    ),
  );
  void statusSummary().then((st: StatusSummary) => {
    const chip = (ok: boolean, text: string, onClick?: () => void) =>
      h(onClick ? 'button' : 'span', { class: ok ? 'chip-ok' : 'chip-warn', onClick }, icon(ok ? 'check' : 'warn', 16), text);
    statusEl.replaceChildren(
      chip(st.offline, st.offline ? 'Offline bereit' : st.regions === 0 ? 'Kein Gebiet geladen' : 'Noch nicht offline bereit'),
      ...(st.updateReady ? [chip(false, 'Update verfügbar – tippen zum Neuladen', () => location.reload())] : []),
      ...(st.incomplete.length
        ? [chip(false, `Gebiet unvollständig: ${st.incomplete.map((r) => `${r.name} (${r.gaps} Straßen ohne Nr.)`).join(', ')}`)]
        : []),
      ...(st.backupDue ? [chip(false, 'Sicherung fällig', () => (close(), show('data')))] : []),
    );
    if (st.backupDue) dataItem.querySelector('span')!.append(h('small', { class: 'menu-note' }, 'Sicherung fällig (über 14 Tage)'));
  });
}

/** Falsch erkannte Straße korrigieren: nahe Straßen zur Auswahl (Tour-Straßen zuerst). */
function chooseStreet(onDone: () => void) {
  const fix = gps.fix;
  if (!fix) return;
  const near = nearestStreets(state.index, fix.lat, fix.lon, 80, 6).sort(
    (a, b) => Number(!!inTour(b.street)) - Number(!!inTour(a.street)) || a.dist - b.dist,
  );
  const cur = currentMatch()?.street?.id;
  const close = overlay(
    h(
      'div',
      { class: 'dialog' },
      h('h2', null, 'Welche Straße ist es?'),
      ...(near.length
        ? near.map(({ street, dist }) =>
            h(
              'button',
              {
                class: 'menu-item' + (street.id === cur ? ' on' : ''),
                onClick: () => {
                  close();
                  forceStreet(street);
                  onDone();
                },
              },
              h('span', null, h('b', null, street.name), h('span', { class: 'muted small' }, ` ${street.place} · ${Math.round(dist)} m${inTour(street) ? ' · Tour' : ''}`)),
            ),
          )
        : [h('p', { class: 'muted' }, 'Keine Straße in der Nähe.')]),
      h('p', { class: 'hint' }, 'Gilt, solange du in der Nähe dieser Straße bleibst.'),
      h('button', { class: 'btn big', onClick: () => close() }, 'Abbrechen'),
    ),
  );
}
