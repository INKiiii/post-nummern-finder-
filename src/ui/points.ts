// Eigene Punkte setzen: Hausnummer oder Einfahrt an einer Stelle (langes Drücken auf die
// Karte) oder an der aktuellen GPS-Position („Hier“). Alles lokal, als „selbst gesetzt“ markiert.

import { h, overlay, toast, confirmBig } from './dom';
import { keypad } from './keypad';
import { icon } from './icons';
import { state, savePoint, deletePoint, uid } from '../data';
import { distanceM, normHouseNumber, snapToBuilding, drivewayFor } from '../core';
import { gps } from '../gps';
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
  );
}

/** „Hier“: aktuelle GPS-Position als Einfahrt bzw. Haus der gesuchten Nummer speichern. */
export function hereMenu(street: Street, number: string, onSaved: () => void) {
  const fix = gps.fix;
  const acc = fix ? Math.round(fix.accuracy) : null;
  const saveHere = async (kind: 'driveway' | 'number') => {
    if (!fix) {
      toast('Kein GPS – bitte kurz warten.');
      return;
    }
    if (fix.accuracy > 30 && !(await confirmBig(`GPS ist gerade ungenau (±${acc} m). Trotzdem speichern?`, 'Speichern'))) return;
    await setUserPoint(kind, street, number, fix.lat, fix.lon);
    close();
    toast(kind === 'driveway' ? `Einfahrt zu ${number} gespeichert.` : `${street.name} ${number}: Lage gespeichert.`);
    onSaved();
  };
  const close = overlay(
    h(
      'div',
      { class: 'dialog' },
      h('h2', null, `${street.name} ${number}`),
      h('p', { class: 'muted' }, acc !== null ? `Speichert deine aktuelle Position (GPS ±${acc} m).` : 'Warte auf GPS …'),
      h('button', { class: 'pill-btn next wide', onClick: () => saveHere('driveway') }, icon('pin', 24), 'Hier ist die Einfahrt'),
      h('button', { class: 'pill-btn next wide', onClick: () => saveHere('number') }, icon('house', 24), 'Hier ist der Briefkasten / das Haus'),
      h('button', { class: 'btn big', onClick: () => close() }, 'Abbrechen'),
    ),
  );
}
