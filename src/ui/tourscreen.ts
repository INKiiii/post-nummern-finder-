// „Meine Tour“ einrichten (einmalig, im Stand): Straßen per Suche hinzufügen, Teil A/B,
// Reihenfolge, „Heute zuerst“. Fehlende Straßen lassen sich als eigene Straße anlegen.

import { h, toast, confirmBig } from './dom';
import { show } from './app';
import { icon } from './icons';
import { state } from '../data';
import { preferNearby, searchStreets } from '../core';
import { gps } from '../gps';
import {
  addToTour,
  getTour,
  move,
  removeFromTour,
  resolveTourStreet,
  setFirst,
  setPart,
  tourSuggestions,
  inTour,
  type Part,
  type TourStreet,
} from '../tour';
import { streetGaps } from '../gaps';
import { refreshPreferred } from '../session';
import type { Street } from '../types';

export function tourScreen(root: HTMLElement) {
  const firstEl = h('div', { class: 'seg' });
  const listEl = h('div', { class: 'tour-list' });
  const suggEl = h('div');
  const input = h('input', {
    class: 'search',
    type: 'search',
    placeholder: 'Straße hinzufügen …',
    autocomplete: 'off',
    autocapitalize: 'words',
    spellcheck: 'false',
  }) as HTMLInputElement;
  const results = h('div', { class: 'tour-results' });

  const changed = async (fn: () => Promise<void>) => {
    await fn();
    refreshPreferred();
    render();
  };

  const renderFirst = () => {
    const t = getTour();
    firstEl.replaceChildren(
      ...(['A', 'B'] as Part[]).map((p) =>
        h('button', { class: 'seg-btn' + (t.first === p ? ' on' : ''), 'aria-pressed': String(t.first === p), onClick: () => changed(() => setFirst(p)) }, `Teil ${p} zuerst`),
      ),
    );
  };

  const row = (t: TourStreet, i: number, n: number) => {
    const s = resolveTourStreet(state.index, t);
    const gaps = s ? streetGaps(s) : null;
    return h(
      'div',
      { class: 'tour-row' + (s ? '' : ' missing') },
      h(
        'div',
        { class: 'tour-name' },
        h('b', null, t.name),
        h('span', { class: 'muted small' }, [t.place, s ? '' : 'nicht in den geladenen Gebieten'].filter(Boolean).join(' · ')),
        gaps ? h('span', { class: 'tour-gaps small' + (gaps.missing.length ? ' has-gaps' : '') }, gaps.text) : null,
      ),
      h(
        'div',
        { class: 'tour-btns' },
        h('button', { class: 'sq-btn small', 'aria-label': 'nach oben', disabled: i === 0, onClick: () => changed(() => move(t, -1)) }, '▲'),
        h('button', { class: 'sq-btn small', 'aria-label': 'nach unten', disabled: i === n - 1, onClick: () => changed(() => move(t, 1)) }, '▼'),
        h('button', { class: 'sq-btn small', 'aria-label': `in Teil ${t.part === 'A' ? 'B' : 'A'}`, onClick: () => changed(() => setPart(t, t.part === 'A' ? 'B' : 'A')) }, t.part === 'A' ? '→B' : '→A'),
        h(
          'button',
          {
            class: 'sq-btn small danger',
            'aria-label': 'entfernen',
            onClick: async () => {
              if (await confirmBig(`${t.name} aus der Tour entfernen?`, 'Entfernen')) await changed(() => removeFromTour(t));
            },
          },
          icon('close', 20),
        ),
      ),
    );
  };

  const renderList = () => {
    const t = getTour();
    const parts: Part[] = t.first === 'A' ? ['A', 'B'] : ['B', 'A'];
    listEl.replaceChildren(
      ...parts.flatMap((p) => {
        const list = t.streets.filter((x) => x.part === p);
        return [
          h('h2', null, `Teil ${p}${p === t.first ? ' (heute zuerst)' : ''}`),
          ...(list.length ? list.map((x, i) => row(x, i, list.length)) : [h('p', { class: 'muted' }, 'Noch keine Straßen.')]),
        ];
      }),
    );
  };

  const addBtns = (s: Street) =>
    h(
      'span',
      { class: 'tour-add' },
      h('button', { class: 'chip', onClick: () => changed(async () => (await addToTour(s, 'A'), toast(`${s.name} → Teil A`))) }, '+ A'),
      h('button', { class: 'chip', onClick: () => changed(async () => (await addToTour(s, 'B'), toast(`${s.name} → Teil B`))) }, '+ B'),
    );

  const renderResults = () => {
    const q = input.value.trim();
    if (!q) {
      results.replaceChildren();
      return;
    }
    const res = preferNearby(searchStreets(state.index, q, 8), gps.fix ? [gps.fix.lat, gps.fix.lon] : null).filter((s) => !inTour(s));
    results.replaceChildren(
      ...res.map((s) =>
        h(
          'div',
          { class: 'tour-row' },
          h('div', { class: 'tour-name' }, h('b', null, s.name), h('span', { class: 'muted small' }, [s.place, s.plz].filter(Boolean).join(' · '))),
          addBtns(s),
        ),
      ),
      h('button', { class: 'btn', onClick: () => show('newstreet', { name: q, from: 'tour' }) }, `+ „${q}“ fehlt – selbst anlegen`),
    );
  };
  input.addEventListener('input', renderResults);

  const renderSugg = () => {
    const sug = tourSuggestions(state.index);
    suggEl.replaceChildren(
      ...(sug.length
        ? [
            h('h2', null, 'Oft genutzt, aber nicht in der Tour'),
            ...sug.map((s) =>
              h('div', { class: 'tour-row' }, h('div', { class: 'tour-name' }, h('b', null, s.name), h('span', { class: 'muted small' }, s.place)), addBtns(s)),
            ),
          ]
        : []),
    );
  };

  function render() {
    renderFirst();
    renderList();
    renderSugg();
    renderResults();
  }

  root.append(
    h(
      'header',
      { class: 'topbar' },
      h('button', { class: 'btn', onClick: () => show('live', {}, false) }, '‹ Zurück'),
      h('div', { class: 'title' }, 'Meine Tour'),
    ),
    h(
      'div',
      { class: 'page' },
      h('p', { class: 'hint' }, 'Einmal einrichten: Straßen der Tour hinzufügen und Teil A oder B zuordnen. Die Live-Karte erkennt dann bevorzugt diese Straßen.'),
      h('div', { class: 'set-label' }, 'Heute zuerst'),
      firstEl,
      h('div', { class: 'search-wrap' }, h('span', { class: 'search-ic' }, icon('search', 20)), input),
      results,
      suggEl,
      listEl,
    ),
  );
  render();
}
