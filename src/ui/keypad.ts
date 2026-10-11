// Große Zahlentastatur mit Buchstaben-Zusatz (12a) – funktioniert immer offline.

import { h } from './dom';

export function keypad(opts: { value: string; onChange: (v: string) => void; onEnter: () => void; enterLabel?: string }) {
  let value = opts.value;
  const set = (v: string) => {
    value = v.slice(0, 8);
    opts.onChange(value);
  };
  const press = (k: string) => {
    navigator.vibrate?.(10);
    if (k === '⌫') set(value.slice(0, -1));
    else if (/[a-h]/.test(k)) {
      // Buchstabe nur nach einer Zahl, ersetzt einen vorhandenen Buchstaben
      if (/^\d+$/.test(value)) set(value + k);
      else if (/^\d+[a-h]$/.test(value)) set(value.slice(0, -1) + k);
    } else if (/^\d$/.test(k)) {
      if (/[a-h]$/.test(value)) return;
      if (value === '' && k === '0') return;
      set(value + k);
    }
  };
  const key = (k: string, cls = '') =>
    h('button', { class: `key ${cls}`, type: 'button', 'aria-label': k === '⌫' ? 'Löschen' : k, onClick: () => press(k) }, k);
  return h(
    'div',
    { class: 'keypad' },
    h('div', { class: 'keys-letters' }, ...['a', 'b', 'c', 'd', 'e', 'f'].map((k) => key(k, 'letter'))),
    h(
      'div',
      { class: 'keys' },
      ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => key(k)),
      key('⌫', 'back'),
      key('0'),
      h('button', { class: 'key enter', type: 'button', onClick: () => opts.onEnter() }, opts.enterLabel ?? 'Finden'),
    ),
  );
}
