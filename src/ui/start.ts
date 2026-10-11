// Startbildschirm: Straße wählen (Suche, zuletzt genutzt), Hausnummer tippen oder sprechen.

import { h, toast } from './dom';
import { keypad } from './keypad';
import { show } from './app';
import { state } from '../data';
import { searchStreets } from '../core';
import { recentAddresses, recentStreets } from '../recents';
import { listenForAddress, speechSupported } from '../voice';
import type { Street } from '../types';

export function startScreen(root: HTMLElement, params: { streetId?: string; listen?: boolean }) {
  let street: Street | null = params.streetId ? state.index.streets.get(params.streetId) ?? null : null;
  let number = '';

  const numberDisplay = h('div', { class: 'number-display', 'aria-live': 'polite' });
  const input = h('input', {
    class: 'search',
    type: 'search',
    placeholder: 'Straße suchen …',
    autocomplete: 'off',
    autocapitalize: 'words',
    spellcheck: 'false',
    enterkeyhint: 'search',
  }) as HTMLInputElement;
  const suggestions = h('div', { class: 'suggestions', role: 'listbox' });
  const chosen = h('div', { class: 'chosen' });
  const quick = h('div', { class: 'quick' });

  const go = () => {
    if (!street) {
      toast('Bitte zuerst eine Straße wählen.');
      input.focus();
      return;
    }
    show('result', { streetId: street.id, number });
  };

  const renderNumber = () => {
    numberDisplay.replaceChildren(number ? h('span', null, number) : h('span', { class: 'placeholder' }, 'Nr.'));
  };

  const choose = (s: Street) => {
    street = s;
    input.value = '';
    input.blur();
    suggestions.replaceChildren();
    renderChosen();
  };

  const renderChosen = () => {
    if (!street) {
      chosen.replaceChildren();
      chosen.hidden = true;
      input.hidden = false;
      return;
    }
    chosen.hidden = false;
    input.hidden = true;
    chosen.replaceChildren(
      h(
        'button',
        { class: 'chosen-street', onClick: () => ((street = null), renderChosen(), input.focus()) },
        h('span', { class: 'chosen-name' }, street.name),
        h('span', { class: 'chosen-place' }, [street.place, street.plz].filter(Boolean).join(' · ')),
        h('span', { class: 'chosen-x', 'aria-label': 'Andere Straße' }, '✕'),
      ),
    );
  };

  const streetInfo = (s: Street) => {
    if (s.user) return 'selbst angelegt';
    if (!s.numbers.length) return 'keine Nummern';
    return `${s.numbers.length} Nr.`;
  };

  const renderSuggestions = () => {
    const q = input.value.trim();
    if (!q) {
      // Zuletzt genutzte Straßen oben
      const rec = recentStreets(6)
        .map((r) => state.index.streets.get(r.id))
        .filter((s): s is Street => !!s);
      suggestions.replaceChildren(
        ...rec.map((s) =>
          h('button', { class: 'sugg recent', onClick: () => choose(s) }, h('span', { class: 'sugg-name' }, '↺ ' + s.name), h('span', { class: 'sugg-meta' }, s.place)),
        ),
      );
      return;
    }
    const res = searchStreets(state.index, q, 7);
    const items: HTMLElement[] = res.map((s) =>
      h(
        'button',
        { class: 'sugg', role: 'option', onClick: () => choose(s) },
        h('span', { class: 'sugg-name' }, s.name),
        h('span', { class: 'sugg-meta' }, [s.place, s.plz, streetInfo(s)].filter(Boolean).join(' · ')),
      ),
    );
    if (!res.length) items.push(h('div', { class: 'sugg-empty' }, 'Keine Straße gefunden in den geladenen Gebieten.'));
    if (q.length >= 3) {
      items.push(h('button', { class: 'sugg add', onClick: () => show('newstreet', { name: q }) }, `+ Straße „${q}“ selbst anlegen`));
    }
    suggestions.replaceChildren(...items);
  };

  input.addEventListener('input', renderSuggestions);
  input.addEventListener('focus', renderSuggestions);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = searchStreets(state.index, input.value, 1)[0];
      if (first) choose(first);
    }
  });

  const renderQuick = () => {
    const rec = recentAddresses(5).filter((r) => state.index.streets.has(r.streetId));
    quick.replaceChildren(
      ...(rec.length ? [h('span', { class: 'quick-label' }, 'Zuletzt:')] : []),
      ...rec.map((r) =>
        h('button', { class: 'chip', onClick: () => show('result', { streetId: r.streetId, number: r.number }) }, `${r.streetName} ${r.number}`),
      ),
    );
  };

  const voice = async () => {
    const r = await listenForAddress();
    if (!r) return;
    if (r.street && r.number) {
      show('result', { streetId: r.street.id, number: r.number });
    } else if (r.street) {
      choose(r.street);
      toast(`Straße erkannt. Hausnummer bitte eintippen.`);
    } else {
      toast(`Nicht erkannt: „${r.heard}“. Bitte Tastatur benutzen.`, 4500);
    }
  };

  const noData = !state.packages.length && !state.ustreets.length;
  root.append(
    ...[
    h(
      'header',
      { class: 'topbar' },
      h('button', { class: 'btn', onClick: () => show('regions') }, '🗺 Gebiete'),
      h('div', { class: 'title' }, 'Hausnummer'),
      h('button', { class: 'btn', onClick: () => show('data') }, '⇅ Daten'),
    ),
    noData
      ? h('button', { class: 'banner', onClick: () => show('regions') }, 'Noch kein Gebiet geladen – hier tippen, um ein Gebiet herunterzuladen.')
      : null,
    speechSupported() ? h('button', { class: 'btn mic', onClick: voice }, '🎤 Sprechen') : null,
    h('div', { class: 'search-wrap' }, input, chosen, suggestions),
    quick,
    numberDisplay,
    keypad({
      value: number,
      onChange: (v) => {
        number = v;
        renderNumber();
      },
      onEnter: go,
    }),
    ].filter((x): x is HTMLElement => !!x),
  );
  renderNumber();
  renderChosen();
  renderQuick();
  if (params.listen && speechSupported()) setTimeout(voice, 150);

  // Antippen außerhalb schließt die Vorschläge
  const outside = (e: Event) => {
    if (!(e.target as Element).closest('.search-wrap')) suggestions.replaceChildren();
  };
  document.addEventListener('pointerdown', outside);
  return () => document.removeEventListener('pointerdown', outside);
}
