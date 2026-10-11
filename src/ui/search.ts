// „Nr. suchen“ (im Stand): Straße ist vorausgewählt (aktuelle Live-Straße), Hausnummer
// tippen oder sprechen. „Finden“ setzt das Ziel und kehrt zur Live-Karte zurück.

import { h, toast } from './dom';
import { keypad } from './keypad';
import { show } from './app';
import { state } from '../data';
import { nearestStreets, preferNearby, searchStreets } from '../core';
import { gps } from '../gps';
import { locationDeniedBox } from './location';
import { icon } from './icons';
import { recentAddresses, recentStreets, remember } from '../recents';
import { setTarget } from '../session';
import { countUse } from '../tour';
import { listenForAddress, speechSupported } from '../voice';
import type { Street } from '../types';

export function searchScreen(root: HTMLElement, params: { streetId?: string; listen?: boolean }) {
  let street: Street | null = params.streetId ? state.index.streets.get(params.streetId) ?? null : null;
  let number = '';

  const numberDisplay = h('div', { class: 'number-display', 'aria-live': 'polite' });
  const input = h('input', {
    class: 'search',
    type: 'search',
    placeholder: 'Andere Straße suchen …',
    autocomplete: 'off',
    autocapitalize: 'words',
    spellcheck: 'false',
    enterkeyhint: 'search',
  }) as HTMLInputElement;
  const suggestions = h('div', { class: 'suggestions', role: 'listbox' });
  const chosen = h('div', { class: 'chosen' });
  const quick = h('div', { class: 'quick' });
  const nearEl = h('div', { class: 'near' });

  // Nächstgelegene Straße als großer Knopf (nur Nummer noch eingeben)
  let nearKey = '';
  const renderNear = () => {
    if (gps.denied) {
      if (nearKey !== 'denied') nearEl.replaceChildren(locationDeniedBox(true));
      nearKey = 'denied';
      return;
    }
    const fix = gps.fix;
    const cands = fix && fix.accuracy < 80 ? nearestStreets(state.index, fix.lat, fix.lon, 50, 2) : [];
    const shown = cands.filter((c) => c.street.id !== street?.id);
    const key = shown.map((c) => c.street.id).join('|') + (street ? '#' + street.id : '');
    if (key === nearKey) return;
    nearKey = key;
    nearEl.replaceChildren(
      ...shown.map((c, i) =>
        i === 0
          ? h(
              'button',
              { class: 'near-card', onClick: () => choose(c.street) },
              h('span', { class: 'near-pin' }, icon('pin', 26)),
              h(
                'span',
                { class: 'near-text' },
                h('span', { class: 'near-kicker' }, 'DU BIST IN DER'),
                h('span', { class: 'near-name' }, c.street.name),
                h('span', { class: 'near-meta' }, `${c.street.place || c.street.plz} · Nummer eingeben`),
              ),
            )
          : h('button', { class: 'near-alt', onClick: () => choose(c.street) }, `oder ${c.street.name}`),
      ),
    );
  };

  // Ziel setzen und zurück zur Live-Karte (Straße bleibt für den nächsten Brief gesetzt)
  const finish = (s: Street, nr: string) => {
    if (nr) void remember({ streetId: s.id, streetName: s.name, place: s.place, number: nr });
    // Nur der Straßenname wird gezählt (Vorschlag „zur Tour hinzufügen“)
    void countUse(s);
    setTarget({ streetId: s.id, number: nr });
    show('live', {}, false);
  };

  const go = () => {
    if (!street) {
      toast('Bitte zuerst eine Straße wählen.');
      input.focus();
      return;
    }
    finish(street, number);
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
    renderNear();
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
        { class: 'chosen-street', onClick: () => ((street = null), renderChosen(), renderNear(), input.focus()) },
        h('span', { class: 'chosen-name' }, street.name),
        h('span', { class: 'chosen-place' }, [street.place, street.plz].filter(Boolean).join(' · ')),
        h('span', { class: 'chosen-x', 'aria-label': 'Andere Straße' }, '✕'),
      ),
    );
  };

  const streetInfo = (s: Street) => {
    if (s.user) return 'selbst angelegt';
    if (!s.numbers.length) return s.buildings?.length ? `keine Nummern · ${s.buildings.length} Häuser` : 'Weg ohne Häuser';
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
    // Gleichnamige Straßen (z. B. Elbuferstraße in Tespe und Marschacht): die nahe zuerst
    const res = preferNearby(searchStreets(state.index, q, 7), gps.fix ? [gps.fix.lat, gps.fix.lon] : null);
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
      const first = preferNearby(searchStreets(state.index, input.value, 7), gps.fix ? [gps.fix.lat, gps.fix.lon] : null)[0];
      if (first) choose(first);
    }
  });

  const renderQuick = () => {
    const rec = recentAddresses(5).filter((r) => state.index.streets.has(r.streetId));
    quick.replaceChildren(
      ...(rec.length ? [h('span', { class: 'quick-label' }, 'Zuletzt:')] : []),
      ...rec.map((r) =>
        h(
          'button',
          {
            class: 'chip',
            onClick: () => {
              const s = state.index.streets.get(r.streetId);
              if (s) finish(s, r.number);
            },
          },
          `${r.streetName} ${r.number}`,
        ),
      ),
    );
  };

  const voice = async () => {
    const r = await listenForAddress(
      street ? `Nummer sagen (${street.name}) – oder Straße und Nummer` : 'z. B. „Elbuferstraße zweiundvierzig“',
    );
    if (!r) return;
    if (r.street && r.number) {
      finish(r.street, r.number);
    } else if (!r.street && r.number && street) {
      // Nur Nummer gesagt: gewählte Straße (vorsortierte Briefe)
      finish(street, r.number);
    } else if (!r.street && r.number) {
      number = r.number;
      renderNumber();
      toast('Nummer erkannt. Bitte Straße wählen.');
    } else if (r.street) {
      choose(r.street);
      toast(`Straße erkannt. Hausnummer bitte eintippen.`);
    } else {
      toast(`Nicht erkannt: „${r.heard}“. Bitte Tastatur benutzen.`);
    }
  };

  const noData = !state.packages.length && !state.ustreets.length;
  root.append(
    ...[
    h(
      'header',
      { class: 'head' },
      h('button', { class: 'round-btn', onClick: () => show('live', {}, false), 'aria-label': 'Zurück zur Karte' }, icon('back', 26)),
      h('div', { class: 'head-title' }, h('div', { class: 'addr' }, 'Nr. suchen')),
    ),
    noData
      ? h('button', { class: 'banner', onClick: () => show('regions') }, 'Noch kein Gebiet geladen – hier tippen, um ein Gebiet herunterzuladen.')
      : null,
    nearEl,
    h('div', { class: 'search-wrap' }, h('span', { class: 'search-ic' }, icon('search', 20)), input, chosen, suggestions),
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
    speechSupported() ? h('button', { class: 'pill-btn outline mic', onClick: voice }, icon('mic', 24), 'Sprechen') : null,
    ].filter((x): x is HTMLElement => !!x),
  );
  renderNumber();
  renderChosen();
  renderQuick();
  renderNear();
  const unsubGps = gps.subscribe(() => renderNear());
  if (params.listen && speechSupported()) setTimeout(voice, 150);

  // Antippen außerhalb schließt die Vorschläge
  const outside = (e: Event) => {
    if (!(e.target as Element).closest('.search-wrap')) suggestions.replaceChildren();
  };
  document.addEventListener('pointerdown', outside);
  return () => {
    document.removeEventListener('pointerdown', outside);
    unsubGps();
  };
}
