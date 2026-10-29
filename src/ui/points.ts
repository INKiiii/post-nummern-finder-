// Eigene Punkte setzen: Hausnummer oder Einfahrt an einer Stelle (langes Drücken auf die
// Karte) oder an der aktuellen GPS-Position („Hier“). Alles lokal, als „selbst gesetzt“ markiert.

import { h, overlay, toast, confirmBig } from './dom';
import { keypad } from './keypad';
import { icon } from './icons';
import { state, savePoint, deletePoint, uid } from '../data';
import { distanceM, normHouseNumber, snapToBuilding, drivewayFor } from '../core';
import { gps } from '../gps';
import { currentMatch, matcher } from '../session';
import type { Street, UserPoint } from '../types';

export async function setUserPoint(
  kind: 'number' | 'driveway',
  street: Street,
  number: string,
  lat: number,
  lon: number,
): Promise<{ saved: UserPoint; previous: UserPoint | null }> {
  const existing =
    state.points.find(
      (p) => (p.kind ?? 'number') === kind && p.streetName === street.name && normHouseNumber(p.number) === normHouseNumber(number),
    ) ?? null;
  const saved: UserPoint = {
    id: existing?.id ?? uid(),
    kind,
    streetId: street.id,
    streetName: street.name,
    number,
    plz: street.plz,
    lat,
    lon,
    created: existing?.created ?? Date.now(),
    updated: Date.now(),
  };
  await savePoint(saved);
  return { saved, previous: existing ? { ...existing } : null };
}

/** Macht ein setUserPoint rückgängig (vorherigen Stand wiederherstellen oder löschen). */
export async function undoUserPoint(r: { saved: UserPoint; previous: UserPoint | null }) {
  if (r.previous) await savePoint(r.previous);
  else await deletePoint(r.saved.id);
}

/** Langes Drücken: Hausnummer oder Einfahrt an dieser Stelle setzen. */
export function longPressMenu(street: Street | null, lat: number, lon: number, number: string, onSaved: () => void) {
  if (!street) {
    toast('Keine Straße in der Nähe. Bitte zuerst eine Straße anlegen (Menü › Straße anlegen).');
    return;
  }
  if (!number) {
    addPointDialog(street, lat, lon, '', onSaved);
    return;
  }
  const drive = drivewayFor(street, number);
  const setDriveway = async () => {
    close();
    await setUserPoint('driveway', street, number, lat, lon);
    toast(`Einfahrt zu ${number} gesetzt.`);
    onSaved();
  };
  const removeDriveway = async () => {
    close();
    if (drive?.pointId && (await confirmBig(`Eigene Einfahrt zu ${number} löschen?`, 'Löschen'))) {
      await deletePoint(drive.pointId);
      onSaved();
    }
  };
  const close = overlay(
    h(
      'div',
      { class: 'dialog' },
      h('h2', null, 'Hier setzen'),
      h('button', { class: 'pill-btn next wide', onClick: setDriveway }, icon('pin', 24), `Einfahrt zu ${number}`),
      h('p', { class: 'muted small' }, 'Die Stelle, an der man von der Straße abbiegt. Wird lokal gespeichert und mit gesichert.'),
      h('button', { class: 'pill-btn outline wide', onClick: () => (close(), addPointDialog(street, lat, lon, number, onSaved)) }, icon('house', 24), 'Hausnummer an dieser Stelle'),
      drive?.user ? h('button', { class: 'btn big danger', onClick: removeDriveway }, 'Eigene Einfahrt löschen') : null,
      h('button', { class: 'btn big', onClick: () => close() }, 'Abbrechen'),
    ),
    undefined,
    { dismissible: true },
  );
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
    // Liegt die gedrückte Stelle auf/an einem Gebäude ohne Nummer, dessen Mitte nehmen
    const snap = snapToBuilding(chosen, lat, lon, 12);
    await setUserPoint('number', chosen, value, snap?.[0] ?? lat, snap?.[1] ?? lon);
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
    undefined,
    { dismissible: true },
  );
}

const DIST_KEY = 'hnf-here-dist';
export const HERE_DISTANCES = [8, 15, 25, 40];

function savedDistance(): number {
  try {
    const v = Number(localStorage.getItem(DIST_KEY));
    return HERE_DISTANCES.includes(v) ? v : 15;
  } catch {
    return 15;
  }
}

/**
 * „Hier ist Nr. …“: die gesuchte Nummer an der aktuellen Stelle setzen – links oder rechts
 * der Straße (relativ zur Fahrtrichtung, im gewählten Abstand) oder genau hier (GPS).
 * Ein Tippen speichert; danach „Rückgängig“ oben in der Meldung.
 */
export function hereMenu(street: Street, number: string, onSaved: () => void) {
  const fix = gps.fix;
  const m = currentMatch();
  const acc = fix ? Math.round(fix.accuracy) : null;
  let dist = savedDistance();
  const onThisStreet = !!m?.street && m.street.id === street.id;
  const sidesOk = onThisStreet && m!.dir !== 0;

  const finish = async (kind: 'number' | 'driveway', pos: [number, number] | null, what: string) => {
    if (!pos) {
      toast('Kein GPS – bitte kurz warten.');
      return;
    }
    if (fix && fix.accuracy > 30 && !(await confirmBig(`GPS ist gerade ungenau (±${acc} m). Trotzdem speichern?`, 'Speichern'))) return;
    // Liegt dort ein Gebäude ohne Nummer, dessen Mitte nehmen
    const snap = kind === 'number' ? snapToBuilding(street, pos[0], pos[1], 12) : null;
    const r = await setUserPoint(kind, street, number, snap?.[0] ?? pos[0], snap?.[1] ?? pos[1]);
    close();
    onSaved();
    toast(`${what} gespeichert (selbst gesetzt).`, 6000, {
      label: 'Rückgängig',
      run: async () => {
        await undoUserPoint(r);
        onSaved();
        toast('Rückgängig gemacht.');
      },
    });
  };

  const side = (s: 'left' | 'right') => {
    if (!m || !sidesOk) return;
    void finish('number', matcher.besideStreet(m, s, dist), `Nr. ${number} ${s === 'left' ? 'links' : 'rechts'}`);
  };
  const exact = () => void finish('number', fix ? [fix.lat, fix.lon] : null, `Nr. ${number} genau hier`);
  const driveway = () => {
    const p = m && onThisStreet ? matcher.onStreet(m) : fix ? ([fix.lat, fix.lon] as [number, number]) : null;
    void finish('driveway', p, `Einfahrt zu ${number}`);
  };

  const distRow = h('div', { class: 'seg' });
  const renderDist = () =>
    distRow.replaceChildren(
      ...HERE_DISTANCES.map((d) =>
        h(
          'button',
          {
            class: 'seg-btn' + (d === dist ? ' on' : ''),
            onClick: () => {
              dist = d;
              try {
                localStorage.setItem(DIST_KEY, String(d));
              } catch {
                /* egal */
              }
              renderDist();
            },
          },
          `${d} m`,
        ),
      ),
    );
  renderDist();

  const close = overlay(
    h(
      'div',
      { class: 'dialog here-dialog' },
      h('h2', null, `Hier ist Nr. ${number}`),
      h('p', { class: 'muted small' }, `${street.name} · ${acc !== null ? `GPS ±${acc} m` : 'warte auf GPS …'}`),
      h(
        'div',
        { class: 'here-row' },
        h('button', { class: 'pill-btn next here-side', disabled: !sidesOk, onClick: () => side('left') }, '◀ Links'),
        h('button', { class: 'pill-btn next here-side', disabled: !sidesOk, onClick: () => side('right') }, 'Rechts ▶'),
      ),
      sidesOk
        ? h('div', null, h('div', { class: 'set-label' }, 'Abstand von der Straße'), distRow)
        : h('p', { class: 'hint' }, onThisStreet ? 'Links/rechts geht erst nach ein paar Metern Fahrt (Richtung unbekannt).' : `Du bist nicht auf der ${street.name}.`),
      h('button', { class: 'pill-btn outline wide', onClick: exact }, icon('house', 24), 'Genau hier (ich stehe am Briefkasten)'),
      h('button', { class: 'pill-btn outline wide', onClick: driveway }, icon('pin', 24), 'Hier ist die Einfahrt'),
      h('button', { class: 'btn big', onClick: () => close() }, 'Abbrechen'),
    ),
    undefined,
    { dismissible: true },
  );
}
