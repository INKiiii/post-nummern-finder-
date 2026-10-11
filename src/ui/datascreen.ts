// Eigene Daten: Export/Import zum Teilen mit Kollegen, Liste eigener Punkte/Straßen, Quellen.

import { h, toast, confirmBig, formatDate } from './dom';
import { show } from './app';
import { state, deletePoint, deleteUserStreet } from '../data';
import { exportUserData, importUserData } from '../exportimport';
import { loadHouseInfos } from '../houseinfo';

export function dataScreen(root: HTMLElement) {
  const counts = h('p', { class: 'big-text' });
  const lists = h('div');

  const render = async () => {
    const infos = await loadHouseInfos();
    counts.textContent = `${infos.size} Haus-Infos · ${state.points.length} eigene Punkte · ${state.ustreets.length} eigene Straßen`;
    lists.replaceChildren(
      h('h2', null, 'Eigene Punkte'),
      ...(state.points.length
        ? [...state.points]
            .sort((a, b) => (a.streetName + a.number).localeCompare(b.streetName + b.number, 'de', { numeric: true }))
            .map((p) =>
              h(
                'div',
                { class: 'list-row' },
                h('span', null, `${p.streetName} ${p.number}`),
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
        : [h('p', { class: 'muted' }, 'Keine. Auf der Karte lang drücken, um eine Hausnummer zu setzen.')]),
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

  const doExport = async () => {
    const data = await exportUserData();
    const json = JSON.stringify(data, null, 1);
    const name = `hausnummern-infos-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Haus-Infos' });
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }
    const a = h('a', { href: URL.createObjectURL(file), download: name });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
  };

  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true }) as HTMLInputElement;
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      const r = await importUserData(await f.text());
      toast(
        `Importiert: ${r.houseinfo.added} neue, ${r.houseinfo.updated} aktualisierte Haus-Infos, ${r.points.added + r.points.updated} Punkte, ${r.streets.added + r.streets.updated} Straßen.`,
        5000,
      );
      void render();
    } catch (e) {
      toast(`Import fehlgeschlagen: ${(e as Error).message}`, 5000);
    }
    fileInput.value = '';
  });

  root.append(
    h(
      'header',
      { class: 'topbar' },
      h('button', { class: 'btn', onClick: () => show('start', {}, false) }, '‹ Zurück'),
      h('div', { class: 'title' }, 'Eigene Daten'),
    ),
    h(
      'div',
      { class: 'page' },
      counts,
      h('p', { class: 'hint' }, 'Alles bleibt auf diesem Gerät. Zum Teilen mit Kollegen im selben Gebiet exportieren und dort importieren. Bei gleichen Einträgen gewinnt der neuere.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn big primary', onClick: doExport }, '⇪ Exportieren'),
        h('button', { class: 'btn big', onClick: () => fileInput.click() }, '⇩ Importieren'),
      ),
      fileInput,
      lists,
    ),
  );
  void render();
}

function sourcesList() {
  const seen = new Map<string, { name: string; license: string; attribution: string; url: string; date: string }>();
  for (const p of state.packages) for (const s of p.pkg.sources) if (!seen.has(s.id)) seen.set(s.id, s);
  if (!seen.size) return [h('p', { class: 'muted' }, 'Keine Gebiete geladen.')];
  return [...seen.values()].map((s) =>
    h('p', { class: 'small' }, `${s.attribution} – ${s.name}, Lizenz ${s.license}, Stand ${formatDate(s.date)}. `, s.url ? h('span', { class: 'muted' }, s.url) : null),
  );
}
