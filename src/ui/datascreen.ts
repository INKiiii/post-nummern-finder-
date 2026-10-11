// Eigene Daten: Export/Import zum Teilen mit Kollegen, Liste eigener Punkte/Straßen, Quellen.

import { h, toast, confirmBig, formatDate } from './dom';
import { show } from './app';
import { state, deletePoint, deleteUserStreet } from '../data';
import { backupState, backupUserData, importUserData } from '../exportimport';
import { loadHouseInfos } from '../houseinfo';
import { countOldPhotos, deleteOldPhotos } from '../photos';

export function dataScreen(root: HTMLElement) {
  const counts = h('p', { class: 'big-text' });
  const lists = h('div');

  const oldPhotos = h('div');
  const renderPhotos = async () => {
    const n = await countOldPhotos();
    oldPhotos.replaceChildren(
      ...(n
        ? [
            h('p', { class: 'warn' }, `${n} ${n === 1 ? 'Foto' : 'Fotos'} aus einer älteren Version gespeichert. Die App speichert keine Fotos mehr.`),
            h(
              'button',
              {
                class: 'btn big danger',
                onClick: async () => {
                  if (await confirmBig(`${n} alte ${n === 1 ? 'Foto' : 'Fotos'} endgültig löschen?`, 'Löschen')) {
                    await deleteOldPhotos();
                    toast('Fotos gelöscht.');
                    void renderPhotos();
                  }
                },
              },
              'Alte Fotos löschen',
            ),
          ]
        : []),
    );
  };

  const render = async () => {
    const infos = await loadHouseInfos();
    counts.textContent = `${infos.size} Haus-Infos · ${state.points.length} eigene Punkte · ${state.ustreets.length} eigene Straßen`;
    lists.replaceChildren(
      h('h2', null, 'Eigene Punkte und Einfahrten'),
      ...(state.points.length
        ? [...state.points]
            .sort((a, b) => (a.streetName + a.number).localeCompare(b.streetName + b.number, 'de', { numeric: true }))
            .map((p) =>
              h(
                'div',
                { class: 'list-row' },
                h('span', null, p.kind === 'driveway' ? `Einfahrt zu ${p.streetName} ${p.number}` : `${p.streetName} ${p.number}`),
                h('span', { class: 'muted' }, formatDate(p.updated)),
                h(
                  'button',
                  {
                    class: 'btn small danger',
                    onClick: async () => {
                      if (await confirmBig(`Punkt ${p.streetName} ${p.number} löschen?`, 'Löschen')) {
                        await deletePoint(p.id);
                        void render();
                      }
                    },
                  },
                  'Löschen',
                ),
              ),
            )
        : [h('p', { class: 'muted' }, 'Keine. Auf der Karte lang drücken, um eine Hausnummer oder Einfahrt zu setzen.')]),
      h('h2', null, 'Eigene Straßen'),
      ...(state.ustreets.length
        ? state.ustreets.map((s) =>
            h(
              'div',
              { class: 'list-row' },
              h('span', null, s.name),
              h('span', { class: 'muted' }, s.line.length >= 2 ? `${s.line.length} Punkte` : 'nur Startpunkt'),
              h(
                'button',
                {
                  class: 'btn small danger',
                  onClick: async () => {
                    if (await confirmBig(`Straße ${s.name} löschen?`, 'Löschen')) {
                      await deleteUserStreet(s.id);
                      void render();
                    }
                  },
                },
                'Löschen',
              ),
            ),
          )
        : [h('p', { class: 'muted' }, 'Keine. Fehlende Straßen über die Suche „selbst anlegen“.')]),
      h('h2', null, 'Datenquellen der geladenen Gebiete'),
      ...sourcesList(),
    );
  };

  const backupInfo = h('p', { class: 'hint' });
  const renderBackup = async () => {
    const b = await backupState();
    backupInfo.textContent = b.last ? `Letzte Sicherung: ${formatDate(b.last)}` : 'Noch nie gesichert.';
    backupInfo.classList.toggle('warn-text', b.due);
  };
  const doExport = async () => {
    if (await backupUserData()) {
      toast('Haus-Infos gesichert.');
      void renderBackup();
    }
  };

  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true }) as HTMLInputElement;
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      const r = await importUserData(await f.text());
      toast(
        `Importiert: ${r.houseinfo.added + r.houseinfo.updated} Haus-Infos, ${r.points.added + r.points.updated} Punkte/Einfahrten, ${r.streets.added + r.streets.updated} Straßen${r.namesRemoved ? `, ${r.namesRemoved} Hinweise mit Namen verworfen` : ''}.`,
        5000,
      );
      void render();
    } catch (e) {
      toast(`Import fehlgeschlagen: ${(e as Error).message}`);
    }
    fileInput.value = '';
  });

  root.append(
    h(
      'header',
      { class: 'topbar' },
      h('button', { class: 'btn', onClick: () => show('live', {}, false) }, '‹ Zurück'),
      h('div', { class: 'title' }, 'Eigene Daten'),
    ),
    h(
      'div',
      { class: 'page' },
      counts,
      h('p', { class: 'hint' }, 'Alles bleibt auf diesem Gerät. „Haus-Infos sichern“ erzeugt eine Datei: in Dateien/Cloud speichern oder an Kollegen im selben Gebiet schicken. Dort mit „Importieren“ einlesen; bei gleichen Einträgen gewinnt der neuere.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn big primary', onClick: doExport }, '⇪ Haus-Infos sichern'),
        h('button', { class: 'btn big', onClick: () => fileInput.click() }, '⇩ Importieren'),
      ),
      backupInfo,
      oldPhotos,
      fileInput,
      lists,
    ),
  );
  void render();
  void renderBackup();
  void renderPhotos();
}

function sourcesList() {
  const seen = new Map<string, { name: string; license: string; attribution: string; url: string; date: string }>();
  for (const p of state.packages) for (const s of p.pkg.sources) if (!seen.has(s.id)) seen.set(s.id, s);
  if (!seen.size) return [h('p', { class: 'muted' }, 'Keine Gebiete geladen.')];
  return [...seen.values()].map((s) =>
    h('p', { class: 'small' }, `${s.attribution} – ${s.name}, Lizenz ${s.license}, Stand ${formatDate(s.date)}. `, s.url ? h('span', { class: 'muted' }, s.url) : null),
  );
}
