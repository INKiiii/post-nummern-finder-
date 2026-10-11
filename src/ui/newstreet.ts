// Fehlende Straße anlegen: auf der Karte nachzeichnen, beim Fahren aufzeichnen
// oder nur Name + Startpunkt.

import { h, toast } from './dom';
import { show } from './app';
import { MapView } from '../mapview';
import { gps } from '../gps';
import { state, saveUserStreet, uid } from '../data';
import { distanceM } from '../core';

export function newStreetScreen(root: HTMLElement, params: { name?: string }) {
  const line: [number, number][] = [];
  let recording = false;
  const name = h('input', { class: 'search', type: 'text', placeholder: 'Straßenname', value: params.name ?? '', autocapitalize: 'words' }) as HTMLInputElement;
  const map = new MapView();
  const info = h('div', { class: 'muted center' });
  const recBtn = h('button', { class: 'btn' });

  const render = () => {
    map.update({ draft: [...line], index: state.index });
    info.textContent = line.length
      ? `${line.length} Punkt${line.length === 1 ? '' : 'e'} – ${line.length === 1 ? 'nur Startpunkt' : 'Linie'}`
      : 'Auf die Karte tippen, um den Straßenverlauf zu zeichnen.';
    recBtn.textContent = recording ? '■ Aufzeichnung stoppen' : '● Beim Fahren aufzeichnen';
    recBtn.classList.toggle('danger', recording);
  };

  map.onTap = (lat, lon) => {
    line.push([lat, lon]);
    navigator.vibrate?.(15);
    render();
  };

  // Startansicht: GPS oder Mitte des ersten Gebiets
  const fix = gps.fix;
  if (fix) map.centerOn(fix.lat, fix.lon, 2);
  else {
    const b = (state.packages[0]?.pkg as any)?.bbox as number[] | undefined;
    if (b) map.centerOn((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 0.5);
  }

  const unsub = gps.subscribe((f) => {
    map.update({ user: f });
    if (recording && f && f.accuracy < 30) {
      const last = line[line.length - 1];
      if (!last || distanceM(last[0], last[1], f.lat, f.lon) > 10) {
        line.push([f.lat, f.lon]);
        render();
      }
    }
  });

  recBtn.addEventListener('click', () => {
    recording = !recording;
    if (recording && !gps.fix) toast('Warte auf GPS …');
    render();
  });

  const save = async () => {
    const n = name.value.trim();
    if (n.length < 2) {
      toast('Bitte Straßennamen eingeben.');
      name.focus();
      return;
    }
    if (!line.length) {
      if (!gps.fix) {
        toast('Bitte mindestens einen Punkt auf der Karte setzen.');
        return;
      }
      line.push([gps.fix.lat, gps.fix.lon]);
    }
    // PLZ und Ort von der nächstgelegenen bekannten Straße übernehmen
    let plz = '';
    let place = '';
    let best = Infinity;
    for (const s of state.index.streets.values()) {
      if (!s.bbox || s.user) continue;
      const d = distanceM((s.bbox[0] + s.bbox[2]) / 2, (s.bbox[1] + s.bbox[3]) / 2, line[0][0], line[0][1]);
      if (d < best) {
        best = d;
        plz = s.plz;
        place = s.place;
      }
    }
    const id = uid();
    await saveUserStreet({
      id,
      name: n,
      place: best < 3000 ? place : '',
      plz: best < 3000 ? plz : '',
      line: line.length >= 2 ? line : [],
      start: line[0],
      created: Date.now(),
      updated: Date.now(),
    });
    toast(`Straße „${n}“ angelegt. Hausnummern per langem Drücken auf der Karte setzen.`, 4500);
    show('start', { streetId: 'u:' + id }, false);
  };

  root.append(
    h(
      'header',
      { class: 'topbar' },
      h('button', { class: 'btn', onClick: () => show('start', {}, false) }, '‹ Zurück'),
      h('div', { class: 'title' }, 'Neue Straße'),
      h('button', { class: 'btn primary', onClick: save }, 'Speichern'),
    ),
    h('div', { class: 'page compact' }, name, info),
    map.root,
    h(
      'footer',
      { class: 'bottombar row' },
      h('button', { class: 'btn', onClick: () => (line.pop(), render()) }, '↶ Rückgängig'),
      recBtn,
    ),
  );
  render();
  return () => unsub();
}
