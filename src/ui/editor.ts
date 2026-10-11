// Schneller Editor für Haus-Infos: große Knöpfe zum Antippen statt Tippen.

import { h, overlay, toast, confirmBig } from './dom';
import { ACCESS_OPTIONS, ENTRANCE_POSITIONS, NOTE_SNIPPETS, deleteHouseInfo, isEmpty, saveHouseInfo } from '../houseinfo';
import { nameWarning } from '../namecheck';
import type { HouseInfo, Street } from '../types';

export function openEditor(street: Street, number: string, original: HouseInfo, onSaved: () => void) {
  // Arbeitskopie
  const info: HouseInfo = { ...original, entrances: original.entrances.map((e) => ({ ...e })) };
  const accessRow = h('div', { class: 'chips' });
  const entrancesEl = h('div', { class: 'entrances' });
  const warn = h('div', { class: 'warn', role: 'alert' });
  const note = h('input', {
    class: 'note-input',
    type: 'text',
    maxLength: 80,
    placeholder: 'Kurzer Hinweis, z. B. „Hund“',
    value: info.note,
    autocomplete: 'off',
  }) as HTMLInputElement;

  const checkNote = () => {
    const w = nameWarning(note.value);
    warn.textContent = w ?? '';
    const wasHidden = warn.hidden;
    warn.hidden = !w;
    if (w && wasHidden) warn.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  note.addEventListener('input', () => {
    info.note = note.value;
    checkNote();
  });

  const renderAccess = () => {
    accessRow.replaceChildren(
      ...ACCESS_OPTIONS.map((a) =>
        h(
          'button',
          {
            class: 'chip' + (info.access === a ? ' on' : ''),
            onClick: () => {
              info.access = info.access === a ? null : a;
              renderAccess();
            },
          },
          a,
        ),
      ),
    );
  };

  const renderEntrances = () => {
    entrancesEl.replaceChildren(
      ...info.entrances.map((e, i) =>
        h(
          'div',
          { class: 'entrance' },
          h(
            'div',
            { class: 'entrance-head' },
            h('span', { class: 'entrance-title' }, `Eingang ${i + 1}`),
            h(
              'button',
              {
                class: 'btn small danger',
                'aria-label': `Eingang ${i + 1} entfernen`,
                onClick: () => {
                  info.entrances.splice(i, 1);
                  renderEntrances();
                },
              },
              '✕',
            ),
          ),
          h(
            'div',
            { class: 'chips' },
            ...ENTRANCE_POSITIONS.map((p) =>
              h(
                'button',
                {
                  class: 'chip' + (e.pos === p ? ' on' : ''),
                  onClick: () => {
                    e.pos = p;
                    renderEntrances();
                  },
                },
                p,
              ),
            ),
          ),
          h(
            'div',
            { class: 'stepper' },
            h('span', { class: 'stepper-label' }, 'Briefkästen'),
            h('button', { class: 'step', 'aria-label': 'weniger', onClick: () => ((e.boxes = Math.max(0, e.boxes - 1)), renderEntrances()) }, '−'),
            h('span', { class: 'step-value' }, String(e.boxes)),
            h('button', { class: 'step', 'aria-label': 'mehr', onClick: () => ((e.boxes = Math.min(99, e.boxes + 1)), renderEntrances()) }, '+'),
          ),
        ),
      ),
      h(
        'button',
        {
          class: 'btn big add-entrance',
          onClick: () => {
            const used = new Set(info.entrances.map((x) => x.pos));
            info.entrances.push({ pos: ENTRANCE_POSITIONS.find((p) => !used.has(p)) ?? 'vorne', boxes: 1 });
            renderEntrances();
          },
        },
        '+ Eingang',
      ),
    );
  };

  const save = async () => {
    const w = nameWarning(info.note);
    if (w && !(await confirmBig(`${w}\n\nTrotzdem speichern?`, 'Speichern', 'Ändern'))) return;
    if (isEmpty(info)) await deleteHouseInfo(info.key);
    else await saveHouseInfo(info);
    close();
    toast('Haus-Info gespeichert.');
    onSaved();
  };

  const remove = async () => {
    if (!(await confirmBig(`Haus-Info für ${street.name} ${number} löschen?`, 'Löschen'))) return;
    await deleteHouseInfo(info.key);
    close();
    onSaved();
  };

  const close = overlay(
    h(
      'div',
      { class: 'editor' },
      h(
        'header',
        { class: 'topbar' },
        h('button', { class: 'btn', onClick: () => close() }, 'Abbrechen'),
        h('div', { class: 'title' }, `${street.name} ${number}`),
        h('button', { class: 'btn primary', onClick: save }, 'Fertig'),
      ),
      h('div', { class: 'editor-body' },
        h('h3', null, 'Eingänge'),
        entrancesEl,
        h('h3', null, 'Zufahrt'),
        accessRow,
        h('h3', null, 'Hinweis (keine Namen!)'),
        h(
          'div',
          { class: 'chips' },
          ...NOTE_SNIPPETS.map((s) =>
            h(
              'button',
              {
                class: 'chip',
                onClick: () => {
                  note.value = note.value ? `${note.value}, ${s}` : s;
                  info.note = note.value;
                  checkNote();
                },
              },
              s,
            ),
          ),
        ),
        note,
        warn,
        original.updated ? h('button', { class: 'btn danger', onClick: remove }, 'Haus-Info löschen') : null,
      ),
      h('footer', { class: 'bottombar' }, h('button', { class: 'btn huge primary', onClick: save }, 'Speichern')),
    ),
  );
  renderAccess();
  renderEntrances();
  checkNote();
}
