// Ergebnisbildschirm: Entfernung, Straßenseite, Haus-Info, Karte, "Nächster Brief".

import { h, overlay, toast } from './dom';
import { show } from './app';
import { keypad } from './keypad';
import { openEditor } from './editor';
import { state, savePoint, uid } from '../data';
import { findHouse, normHouseNumber, distanceM } from '../core';
import { gps, type Fix } from '../gps';
import { computeGuidance, formatDistance } from '../guidance';
import { MapView } from '../mapview';
import { emptyHouseInfo, getHouseInfo, houseKey, isEmpty, summarize } from '../houseinfo';
import { remember } from '../recents';
import { speechSupported } from '../voice';
import type { FindResult, Street } from '../types';

function statusNote(res: FindResult, number: string): string {
  const nb = res.neighbors.map((n) => n.label);
  switch (res.status) {
    case 'exact':
      return res.match?.user ? 'selbst gesetzt' : '';
    case 'range':
      return `liegt in ${res.match?.label}`;
    case 'base':
      return `${number} nicht in den Daten – Lage von ${res.match?.label}`;
    case 'interpolated':
      return `${number} nicht in den Daten – zwischen ${nb.join(' und ')}`;
    case 'extrapolated':
      return `${number} nicht in den Daten – nach ${nb[0]} weitergerechnet`;
    case 'single':
      return `${number} nicht in den Daten – nur ${nb[0]} bekannt`;
    case 'street':
      return number ? `Keine Hausnummern bekannt – Straßenmitte` : 'Straßenmitte';
    default:
      return 'Keine Lage bekannt';
  }
}

export function resultScreen(root: HTMLElement, params: { streetId: string; number: string }) {
  const found = state.index.streets.get(params.streetId);
  if (!found) {
    toast('Straße nicht mehr vorhanden.');
    show('start', {}, false);
    return;
  }
  let street: Street = found;
  const number = params.number ?? '';
  let res = findHouse(street, number || '');
  if (number) void remember({ streetId: street.id, streetName: street.name, place: street.place, number });

  const distEl = h('div', { class: 'dist' }, '–');
  const sideEl = h('div', { class: 'side' });
  const gpsEl = h('div', { class: 'gps-status' });
  const noteEl = h('div', { class: 'note' });
  const infoCard = h('button', { class: 'info-card' });
  const map = new MapView();

  const target = () =>
    Number.isFinite(res.lat) ? { lat: res.lat, lon: res.lon, label: number || '•', estimated: res.estimated } : null;

  const renderNote = () => {
    const txt = statusNote(res, number);
    noteEl.replaceChildren(
      ...[
        res.estimated && res.status !== 'none' ? h('span', { class: 'badge-est' }, 'geschätzt') : null,
        txt ? h('span', null, ' ' + txt) : null,
      ].filter((x): x is HTMLSpanElement => !!x),
    );
    noteEl.hidden = !txt && !res.estimated;
  };

  const renderInfo = () => {
    if (!number) {
      infoCard.hidden = true;
      return;
    }
    const info = getHouseInfo(houseKey(street, number));
    infoCard.replaceChildren();
    if (info && !isEmpty(info)) {
      const [first, ...rest] = summarize(info);
      infoCard.append(h('div', { class: 'info-head' }, first), ...rest.map((l) => h('div', { class: 'info-line' }, l)), h('div', { class: 'info-edit' }, '✎'));
      infoCard.classList.remove('empty');
    } else {
      infoCard.append(h('div', { class: 'info-empty' }, '+ Haus-Info: Eingänge & Briefkästen'));
      infoCard.classList.add('empty');
    }
  };
  infoCard.addEventListener('click', () =>
    openEditor(street, number, getHouseInfo(houseKey(street, number)) ?? emptyHouseInfo(street, number), renderInfo),
  );

  const renderGuidance = (fix: Fix | null, err?: string) => {
    const t = target();
    if (!fix || !t) {
      distEl.textContent = t ? '–' : '?';
      sideEl.replaceChildren();
      gpsEl.textContent = err ?? (t ? 'Warte auf GPS …' : '');
      return;
    }
    const g = computeGuidance(fix, t, street);
    distEl.textContent = formatDistance(g.distance);
    sideEl.className = 'side' + (g.side ? ` side-${g.side}` : '');
    if (g.distance < 10) sideEl.replaceChildren(h('span', null, 'DA'));
    else if (!g.side) sideEl.replaceChildren(h('span', { class: 'side-unknown' }, 'Seite: losfahren'));
    else if (g.side === 'geradeaus') sideEl.replaceChildren(h('span', null, g.behind ? '▼ hinter dir' : '▲ geradeaus'));
    else
      sideEl.replaceChildren(
        h('span', null, g.side === 'links' ? '◀ LINKS' : 'RECHTS ▶'),
        ...(g.behind ? [h('span', { class: 'behind' }, 'hinter dir')] : []),
      );
    gpsEl.textContent = `Luftlinie · GPS ±${Math.round(fix.accuracy)} m${fix.heading === null ? ' · Fahrtrichtung unbekannt' : ''}`;
  };

  const refresh = () => {
    // Nach dem Speichern eigener Punkte wird der Index neu aufgebaut
    street = state.index.streets.get(street.id) ?? street;
    res = findHouse(street, number);
    renderNote();
    map.update({ target: target(), neighbors: res.estimated ? res.neighbors : [], focus: street, index: state.index });
    renderGuidance(gps.fix, gps.error ?? undefined);
  };

  // Lang auf die Karte tippen: Hausnummer hier setzen (Lücken selbst schließen)
  map.onLongPress = (lat, lon) => addPointDialog(street, lat, lon, number, refresh);

  const nextLetter = () => {
    if (speechSupported()) show('start', { listen: true }, false);
    else show('start', {}, false);
  };

  root.append(
    h(
      'header',
      { class: 'topbar' },
      h('button', { class: 'btn', onClick: () => show('start', {}, false), 'aria-label': 'Zurück' }, '‹ Neu'),
      h(
        'div',
        { class: 'title result-title' },
        h('div', { class: 'addr' }, `${street.name} ${number}`.trim()),
        h('div', { class: 'addr-place' }, [street.place, street.plz].filter(Boolean).join(' · ')),
      ),
    ),
    h('section', { class: 'guidance' }, h('div', { class: 'guidance-row' }, distEl, sideEl), noteEl, gpsEl),
    infoCard,
    map.root,
    h(
      'footer',
      { class: 'bottombar' },
      h('button', { class: 'btn huge primary', onClick: nextLetter }, speechSupported() ? '🎤 Nächster Brief' : 'Nächster Brief'),
    ),
  );
  if (res.estimated && number) {
    toast('Tipp: Lang auf die Karte drücken, um die echte Lage zu setzen.', 3500);
  }
  renderInfo();
  refresh();
  const unsub = gps.subscribe((fix, err) => {
    renderGuidance(fix, err);
    map.update({ user: fix });
  });
  return () => unsub();
}

/** Dialog: eigene Hausnummer an der gedrückten Stelle setzen. */
export function addPointDialog(street: Street, lat: number, lon: number, suggested: string, onSaved: () => void) {
  let value = suggested && !street.numbers.some((n) => n.norm === normHouseNumber(suggested) && !n.user) ? suggested : '';
  const display = h('div', { class: 'number-display small' }, value || 'Nr.');
  const nearOther = [...state.index.streets.values()]
    .filter((s) => s !== street && s.bbox && s.lines.length)
    .filter((s) => s.lines.some((l) => l.some(([la, lo]) => distanceM(la, lo, lat, lon) < 80)))
    .slice(0, 3);
  let chosen = street;
  const streetBtns = h('div', { class: 'row wrap' });
  const renderStreets = () =>
    streetBtns.replaceChildren(
      ...[street, ...nearOther].map((s) =>
        h('button', { class: 'chip' + (s === chosen ? ' on' : ''), onClick: () => ((chosen = s), renderStreets()) }, s.name),
      ),
    );
  renderStreets();
  const save = async () => {
    if (!value) {
      toast('Bitte Hausnummer eingeben.');
      return;
    }
    // Vorhandenen eigenen Punkt gleicher Nummer ersetzen
    const existing = state.points.find((p) => p.streetName === chosen.name && normHouseNumber(p.number) === normHouseNumber(value));
    await savePoint({
      id: existing?.id ?? uid(),
      streetId: chosen.id,
      streetName: chosen.name,
      number: value,
      plz: chosen.plz,
      lat,
      lon,
      created: existing?.created ?? Date.now(),
      updated: Date.now(),
    });
    close();
    toast(`${chosen.name} ${value} gesetzt (selbst gesetzt).`);
    onSaved();
  };
  const close = overlay(
    h(
      'div',
      { class: 'dialog' },
      h('h2', null, 'Hausnummer hier setzen'),
      h('p', { class: 'muted' }, 'Wird lokal gespeichert und als „selbst gesetzt“ markiert.'),
      streetBtns,
      display,
      keypad({
        value,
        onChange: (v) => {
          value = v;
          display.textContent = v || 'Nr.';
        },
        onEnter: save,
        enterLabel: 'Setzen',
      }),
      h('button', { class: 'btn big', onClick: () => close() }, 'Abbrechen'),
    ),
  );
}
