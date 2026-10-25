// Einstellungen und Info: Hell/Dunkel, Kartenausrichtung, Töne, Bildschirm an, Datenquelle, Version.

import { h, formatDate } from './dom';
import { show } from './app';
import { icon } from './icons';
import { applyTheme, passBeepEnabled, setPassBeep, themeChoice, type ThemeChoice } from '../settings';
import { savedMapMode, setSavedMapMode, type MapMode } from '../mapview';
import { setSoundEnabled, soundEnabled, unlockAudio, beep } from '../approach';
import { keepAwake, onWakeStatus, wakeStatus } from '../wakelock';
import { state } from '../data';

declare const __APP_VERSION__: string;

function choice<T extends string>(options: [T, string][], current: T, onPick: (v: T) => void) {
  const row = h('div', { class: 'seg' });
  const render = (cur: T) =>
    row.replaceChildren(
      ...options.map(([v, label]) =>
        h('button', { class: 'seg-btn' + (v === cur ? ' on' : ''), 'aria-pressed': String(v === cur), onClick: () => (onPick(v), render(v)) }, label),
      ),
    );
  render(current);
  return row;
}

export function settingsScreen(root: HTMLElement) {
  const wakeEl = h('p', { class: 'hint' });
  const renderWake = () => {
    const s = wakeStatus();
    wakeEl.textContent =
      s === 'wakelock'
        ? 'Bildschirm bleibt an (Wake Lock aktiv).'
        : s === 'video'
          ? 'Bildschirm bleibt an (Ausweichweg für iPhone-Web-Apps).'
          : 'Bildschirm kann ausgehen.';
  };
  const unsub = onWakeStatus(renderWake);
  renderWake();

  const sources = new Map<string, { name: string; license: string; attribution: string; date: string }>();
  for (const p of state.packages) for (const s of p.pkg.sources) if (!sources.has(s.id)) sources.set(s.id, s);

  root.append(
    h(
      'header',
      { class: 'topbar' },
      h('button', { class: 'btn', onClick: () => show('live', {}, false) }, '‹ Zurück'),
      h('div', { class: 'title' }, 'Einstellungen'),
    ),
    h(
      'div',
      { class: 'page' },
      h('h2', null, 'Anzeige'),
      choice<ThemeChoice>(
        [
          ['auto', 'Automatisch'],
          ['light', 'Hell'],
          ['dark', 'Dunkel'],
        ],
        themeChoice(),
        (v) => applyTheme(v),
      ),
      h('p', { class: 'hint' }, 'Automatisch folgt der Einstellung des iPhones (hell am Tag, dunkel nachts).'),
      h('h2', null, 'Karte'),
      choice<MapMode>(
        [
          ['navi', 'Navi (Blick in Fahrtrichtung)'],
          ['heading', 'Flach, Fahrtrichtung oben'],
          ['north', 'Norden oben'],
        ],
        savedMapMode(),
        (v) => setSavedMapMode(v),
      ),
      h('h2', null, 'Töne'),
      h('div', { class: 'set-label' }, 'Ton bei Annäherung an Haus oder Einfahrt'),
      choice<'on' | 'off'>(
        [
          ['on', 'An'],
          ['off', 'Aus'],
        ],
        soundEnabled() ? 'on' : 'off',
        (v) => {
          setSoundEnabled(v === 'on');
          unlockAudio();
          if (v === 'on') beep(1, 880);
        },
      ),
      h('div', { class: 'set-label' }, 'Signal, wenn ich am Ziel vorbeigefahren bin'),
      choice<'on' | 'off'>(
        [
          ['on', 'An'],
          ['off', 'Aus'],
        ],
        passBeepEnabled() ? 'on' : 'off',
        (v) => {
          setPassBeep(v === 'on');
          unlockAudio();
          if (v === 'on') beep(3, 440);
        },
      ),
      h('p', { class: 'hint' }, 'iPhone: Töne sind nur hörbar, wenn der Stummschalter aus ist (oder über Bluetooth im Auto).'),
      h('h2', null, 'Bildschirm'),
      wakeEl,
      h('button', { class: 'btn', onClick: () => void keepAwake() }, 'Bildschirm anlassen erneut versuchen'),
      h(
        'p',
        { class: 'hint' },
        'Am zuverlässigsten: iPhone-Einstellungen › Anzeige & Helligkeit › Automatische Sperre › Nie (nach der Tour wieder zurückstellen).',
      ),
      h('h2', null, 'Info'),
      h('p', { class: 'small' }, icon('info', 18), ' Kartendaten: © OpenStreetMap-Mitwirkende, Lizenz ODbL (openstreetmap.org/copyright).'),
      ...[...sources.values()]
        .filter((s) => !s.attribution.includes('OpenStreetMap'))
        .map((s) => h('p', { class: 'small' }, `${s.attribution} – ${s.name}, ${s.license}, Stand ${formatDate(s.date)}`)),
      h('p', { class: 'small muted' }, `Version ${__APP_VERSION__}`),
      h('p', { class: 'small muted' }, 'Alles bleibt auf diesem Gerät: kein Konto, kein Server, kein Standortverlauf, keine Namen.'),
    ),
  );
  return () => unsub();
}
