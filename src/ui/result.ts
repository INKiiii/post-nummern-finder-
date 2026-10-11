// Ergebnisbildschirm: Entfernung, Straßenseite, Haus-Info, Karte, "Nächster Brief".

import { h, overlay, toast, confirmBig } from './dom';
import { show } from './app';
import { keypad } from './keypad';
import { openEditor } from './editor';
import { state, savePoint, deletePoint, uid } from '../data';
import { findHouse, normHouseNumber, distanceM, drivewayFor, distanceToStreet, snapToBuilding } from '../core';
import { gps, type Fix } from '../gps';
import { computeGuidance, formatDistance } from '../guidance';
import { MapView } from '../mapview';
import { emptyHouseInfo, getHouseInfo, houseKey, isEmpty, summarize } from '../houseinfo';
import { remember } from '../recents';
import { speechSupported } from '../voice';
import { locationDeniedBox } from './location';
import { ApproachAlert, setSoundEnabled, soundEnabled, unlockAudio } from '../approach';
import { deletePhoto, getPhoto, savePhoto, shrinkImage } from '../photos';
import type { FindResult, Street } from '../types';

function statusNote(res: FindResult, number: string): string {
  const base = statusBase(res, number);
  if (res.snapped) return `${base} · auf Gebäude ohne Nummer gesetzt`;
  return base;
}

function statusBase(res: FindResult, number: string): string {
  const nb = res.neighbors.map((n) => n.label);
  switch (res.status) {
    case 'exact':
      if (res.match?.user) return 'selbst gesetzt';
      if (res.match?.source === 'osm-interp') return 'Lage aus OSM-Interpolationslinie';
      return '';
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
  const placeEl = h('div', { class: 'note place-note' });
  const driveEl = h('div', { class: 'drive-guide' });
  const approachEl = h('div', { class: 'approach', role: 'alert' });
  approachEl.hidden = true;
  const alert = new ApproachAlert();
  let approachTimer = 0;
  const photoEl = h('div', { class: 'photo-strip' });
  const deniedEl = locationDeniedBox();
  deniedEl.hidden = true;
  let drive: ReturnType<typeof drivewayFor> = null;
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

    // Abstand Haus – Straße (ab 20 m) und Zufahrt
    const t = target();
    const off = t && res.status !== 'street' ? distanceToStreet(street, t.lat, t.lon) : null;
    const parts: string[] = [];
    if (off !== null && off > 20) parts.push(`Haus liegt ${Math.round(off)} m von der Straße entfernt`);
    if (drive) parts.push(drive.user ? 'Einfahrt selbst gesetzt' : 'Zufahrt aus den Daten');
    placeEl.textContent = parts.join(' · ');
    placeEl.hidden = !parts.length;
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
      infoCard.append(h('div', { class: 'info-empty' }, '+ Haus-Info (Eingänge, Briefkästen)'));
      infoCard.classList.add('empty');
    }
  };
  const renderPhoto = () => {
    const p = number ? getPhoto(houseKey(street, number)) : undefined;
    photoEl.replaceChildren();
    photoEl.hidden = !p;
    if (p) photoEl.append(h('button', { class: 'photo-thumb', onClick: () => showPhoto() }, h('img', { src: p.dataUrl, alt: `Foto ${street.name} ${number}` })));
  };

  const takePhoto = () => {
    const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true }) as HTMLInputElement;
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return;
      try {
        await savePhoto(houseKey(street, number), await shrinkImage(f));
        renderPhoto();
        toast('Foto gespeichert.');
      } catch {
        toast('Foto konnte nicht gespeichert werden.');
      }
    });
    input.click();
  };

  const showPhoto = () => {
    const p = getPhoto(houseKey(street, number));
    if (!p) return;
    const close = overlay(
      h(
        'div',
        { class: 'photo-view' },
        h('img', { src: p.dataUrl, alt: `Foto ${street.name} ${number}` }),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn big', onClick: () => (close(), takePhoto()) }, '📷 Neues Foto'),
          h(
            'button',
            {
              class: 'btn big danger',
              onClick: async () => {
                if (await confirmBig('Foto löschen?', 'Löschen')) {
                  await deletePhoto(p.key);
                  close();
                  renderPhoto();
                }
              },
            },
            'Löschen',
          ),
        ),
        h('button', { class: 'btn big primary', onClick: () => close() }, 'Schließen'),
      ),
    );
  };

  // "Hier ist es": aktuelle GPS-Position als Einfahrt bzw. Briefkasten speichern, Foto aufnehmen
  const hereMenu = () => {
    const fix = gps.fix;
    const acc = fix ? Math.round(fix.accuracy) : null;
    const saveHere = async (kind: 'driveway' | 'number') => {
      if (!fix) {
        toast('Kein GPS – bitte kurz warten.');
        return;
      }
      if (fix.accuracy > 30 && !(await confirmBig(`GPS ist gerade ungenau (±${acc} m). Trotzdem speichern?`, 'Speichern'))) return;
      const existing = state.points.find(
        (p) => (p.kind ?? 'number') === kind && p.streetName === street.name && normHouseNumber(p.number) === normHouseNumber(number),
      );
      await savePoint({
        id: existing?.id ?? uid(),
        kind,
        streetId: street.id,
        streetName: street.name,
        number,
        plz: street.plz,
        lat: fix.lat,
        lon: fix.lon,
        created: existing?.created ?? Date.now(),
        updated: Date.now(),
      });
      close();
      toast(kind === 'driveway' ? `Einfahrt zu ${number} gespeichert.` : `${street.name} ${number}: Lage gespeichert.`);
      refresh();
    };
    const close = overlay(
      h(
        'div',
        { class: 'dialog' },
        h('h2', null, `${street.name} ${number}`),
        h('p', { class: 'muted' }, acc !== null ? `Speichert deine aktuelle Position (GPS ±${acc} m).` : 'Warte auf GPS …'),
        h('button', { class: 'btn big primary', onClick: () => saveHere('driveway') }, '📍 Hier ist die Einfahrt'),
        h('button', { class: 'btn big primary', onClick: () => saveHere('number') }, '📍 Hier ist der Briefkasten / das Haus'),
        h('button', { class: 'btn big', onClick: () => (close(), takePhoto()) }, getPhoto(houseKey(street, number)) ? '📷 Foto ersetzen' : '📷 Foto vom Haus'),
        h('p', { class: 'muted small' }, 'Foto bleibt nur auf diesem iPhone. Bitte keine Personen oder Autokennzeichen fotografieren.'),
        h('button', { class: 'btn big', onClick: () => close() }, 'Abbrechen'),
      ),
    );
  };

  infoCard.addEventListener('click', () =>
    openEditor(street, number, getHouseInfo(houseKey(street, number)) ?? emptyHouseInfo(street, number), renderInfo),
  );

  const renderGuidance = (fix: Fix | null, err?: string) => {
    const t = target();
    deniedEl.hidden = !gps.denied;
    if (gps.denied) {
      // Statt "–": klare Anleitung, wie man den Standort erlaubt
      distEl.hidden = true;
      sideEl.replaceChildren();
      gpsEl.textContent = '';
      driveEl.hidden = true;
      return;
    }
    distEl.hidden = false;
    if (!fix || !t) {
      distEl.textContent = t ? '…' : '?';
      sideEl.replaceChildren();
      gpsEl.textContent = err ?? (t ? 'Warte auf GPS-Signal …' : '');
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
    if (drive) {
      const [jl, jo] = drive.junction;
      const gj = computeGuidance(fix, { lat: jl, lon: jo }, street);
      // Die Abzweigung liegt auf der Straße; die Seite ergibt sich aus der Richtung der Zufahrt
      const away = drive.line[1] ?? drive.line[0];
      const gs = computeGuidance(fix, { lat: away[0], lon: away[1] }, street);
      gj.side = gs.side;
      const side = gj.side === 'links' ? 'links' : gj.side === 'rechts' ? 'rechts' : gj.side === 'geradeaus' ? 'geradeaus' : '';
      driveEl.textContent = gj.distance < 10 ? 'Einfahrt: hier abbiegen' : `Einfahrt in ${formatDistance(gj.distance)}${side ? ' ' + side : ''}${gj.behind ? ' (hinter dir)' : ''}`;
      driveEl.hidden = false;
      announce(gj.distance, gj.behind, 'EINFAHRT', side);
    } else {
      driveEl.hidden = true;
      announce(g.distance, g.behind, 'HAUS', g.side === 'links' || g.side === 'rechts' ? g.side : '');
    }
  };

  // Ton + großer Hinweis bei 50 m und 15 m vor Einfahrt bzw. Haus
  const announce = (dist: number, behind: boolean, what: string, side: string) => {
    const stage = alert.update(dist, behind);
    if (!stage) return;
    approachEl.textContent = stage === 'near' ? `${what} JETZT${side ? ' ' + side.toUpperCase() : ''}` : `${what} in ${formatDistance(dist)}${side ? ' ' + side : ''}`;
    approachEl.className = 'approach' + (stage === 'near' ? ' near' : '');
    approachEl.hidden = false;
    clearTimeout(approachTimer);
    approachTimer = window.setTimeout(() => (approachEl.hidden = true), 3000);
  };

  const refresh = () => {
    // Nach dem Speichern eigener Punkte wird der Index neu aufgebaut
    street = state.index.streets.get(street.id) ?? street;
    res = findHouse(street, number);
    drive = number ? drivewayFor(street, number, res) : null;
    renderNote();
    map.update({
      target: target(),
      neighbors: res.estimated ? res.neighbors : [],
      focus: street,
      index: state.index,
      driveway: drive ? { line: drive.line, user: drive.user } : null,
    });
    renderGuidance(gps.fix, gps.error ?? undefined);
  };

  // Lang auf die Karte tippen: Hausnummer hier setzen (Lücken selbst schließen)
  map.onLongPress = (lat, lon) => longPressMenu(street, lat, lon, number, drive, refresh);

  // Briefe sind vorsortiert: Straße bleibt gewählt, nur noch die Nummer sagen/tippen
  const nextLetter = () => {
    unlockAudio();
    show('start', { listen: speechSupported(), streetId: street.id }, false);
  };
  const soundBtn = h('button', { class: 'btn sound', 'aria-label': 'Ton an/aus' }, soundEnabled() ? '🔔' : '🔕');
  soundBtn.addEventListener('click', () => {
    setSoundEnabled(!soundEnabled());
    soundBtn.textContent = soundEnabled() ? '🔔' : '🔕';
    unlockAudio();
    toast(soundEnabled() ? 'Ton bei Annäherung an' : 'Ton aus');
  });

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
      soundBtn,
    ),
    approachEl,
    h('section', { class: 'guidance' }, deniedEl, h('div', { class: 'guidance-row' }, distEl, sideEl), driveEl, noteEl, placeEl, gpsEl),
    infoCard,
    photoEl,
    map.root,
    h(
      'footer',
      { class: 'bottombar row' },
      number ? h('button', { class: 'btn huge here', onClick: hereMenu }, '📍 Hier') : null,
      h('button', { class: 'btn huge primary', onClick: nextLetter }, speechSupported() ? '🎤 Nächster Brief' : 'Nächster Brief'),
    ),
  );
  renderInfo();
  renderPhoto();
  refresh();
  const unsub = gps.subscribe((fix, err) => {
    renderGuidance(fix, err);
    map.update({ user: fix });
  });
  return () => unsub();
}

/** Langes Drücken: Hausnummer oder Einfahrt an dieser Stelle setzen. */
function longPressMenu(
  street: Street,
  lat: number,
  lon: number,
  number: string,
  drive: ReturnType<typeof drivewayFor>,
  onSaved: () => void,
) {
  if (!number) {
    addPointDialog(street, lat, lon, '', onSaved);
    return;
  }
  const setDriveway = async () => {
    close();
    const existing = state.points.find(
      (p) => p.kind === 'driveway' && p.streetName === street.name && normHouseNumber(p.number) === normHouseNumber(number),
    );
    await savePoint({
      id: existing?.id ?? uid(),
      kind: 'driveway',
      streetId: street.id,
      streetName: street.name,
      number,
      plz: street.plz,
      lat,
      lon,
      created: existing?.created ?? Date.now(),
      updated: Date.now(),
    });
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
      h('button', { class: 'btn big primary', onClick: setDriveway }, `⤴ Einfahrt zu ${number}`),
      h('p', { class: 'muted small' }, 'Die Stelle, an der man von der Straße abbiegt. Wird lokal gespeichert und mit exportiert.'),
      h('button', { class: 'btn big', onClick: () => (close(), addPointDialog(street, lat, lon, number, onSaved)) }, '# Hausnummer an dieser Stelle'),
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
    // Vorhandenen eigenen Punkt gleicher Nummer ersetzen
    const existing = state.points.find(
      (p) => p.kind !== 'driveway' && p.streetName === chosen.name && normHouseNumber(p.number) === normHouseNumber(value),
    );
    // Liegt die gedrückte Stelle auf/an einem Gebäude ohne Nummer, dessen Mitte nehmen
    const snap = snapToBuilding(chosen, lat, lon, 12);
    await savePoint({
      id: existing?.id ?? uid(),
      kind: 'number',
      streetId: chosen.id,
      streetName: chosen.name,
      number: value,
      plz: chosen.plz,
      lat: snap?.[0] ?? lat,
      lon: snap?.[1] ?? lon,
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
