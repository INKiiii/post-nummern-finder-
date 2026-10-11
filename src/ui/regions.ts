// Gebiete: per PLZ oder Ort suchen, herunterladen, aktualisieren, löschen.

import { h, toast, confirmBig, formatBytes, formatDate } from './dom';
import { show } from './app';
import { state, fetchRegionIndex, downloadRegion, deleteRegion } from '../data';
import { foldText } from '../core';
import type { RegionEntry } from '../types';

export function regionsScreen(root: HTMLElement) {
  let index: RegionEntry[] | null = null;
  let loadError = '';
  const busy = new Map<string, number>(); // id -> Fortschritt 0..1

  const input = h('input', {
    class: 'search',
    type: 'search',
    placeholder: 'PLZ oder Ort, z. B. 21395 oder Tespe',
    autocomplete: 'off',
    inputMode: 'search',
  }) as HTMLInputElement;
  const results = h('div', { class: 'region-list' });
  const loaded = h('div', { class: 'region-list' });
  const storageEl = h('div', { class: 'muted' });

  const conn = (navigator as any).connection;
  const cellular = conn?.type === 'cellular' || conn?.saveData;

  const download = async (e: RegionEntry) => {
    if (busy.has(e.id)) return;
    if (cellular && e.size > 2e6 && !(await confirmBig(`Du bist im Mobilfunknetz. ${formatBytes(e.size)} trotzdem laden?`, 'Laden'))) return;
    busy.set(e.id, 0);
    render();
    try {
      await downloadRegion(e, (d, t) => {
        busy.set(e.id, t ? Math.min(1, d / t) : 0);
        render();
      });
      toast(`${e.name} geladen.`);
    } catch (err) {
      toast(`Fehler: ${(err as Error).message}`, 5000);
    } finally {
      busy.delete(e.id);
      render();
      void renderStorage();
    }
  };

  const remove = async (id: string, name: string) => {
    if (!(await confirmBig(`Gebiet „${name}“ vom Gerät löschen? Eigene Haus-Infos und Punkte bleiben erhalten.`, 'Löschen'))) return;
    await deleteRegion(id);
    render();
    void renderStorage();
  };

  const progress = (id: string) => {
    const p = busy.get(id);
    return p === undefined ? null : h('div', { class: 'progress' }, h('div', { class: 'progress-bar', style: { width: `${Math.round(p * 100)}%` } }));
  };

  const render = () => {
    // Geladene Gebiete
    const loadedIds = new Set(state.packages.map((p) => p.id));
    loaded.replaceChildren(
      ...(state.packages.length
        ? [...state.packages]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((p) => {
              const remote = index?.find((r) => r.id === p.id);
              const outdated = remote && remote.hash !== p.entry.hash;
              return h(
                'div',
                { class: 'region' },
                h('div', { class: 'region-name' }, p.entry.name),
                h(
                  'div',
                  { class: 'region-meta' },
                  `${formatBytes(p.size)} · ${p.entry.streets} Straßen · ${p.entry.numbers} Nummern · geladen ${formatDate(p.downloadedAt)}`,
                  outdated ? h('strong', { class: 'update-hint' }, ' · Update verfügbar') : null,
                ),
                progress(p.id),
                h(
                  'div',
                  { class: 'row' },
                  h('button', { class: 'btn' + (outdated ? ' primary' : ''), disabled: !remote || busy.has(p.id), onClick: () => remote && download(remote) }, 'Aktualisieren'),
                  h('button', { class: 'btn danger', onClick: () => remove(p.id, p.entry.name) }, 'Löschen'),
                ),
              );
            })
        : [h('p', { class: 'muted' }, 'Noch kein Gebiet geladen.')]),
    );

    // Suchergebnisse
    if (!index) {
      results.replaceChildren(h('p', { class: 'muted' }, loadError || 'Lade Gebietsliste …'));
      return;
    }
    const q = foldText(input.value);
    let list = index;
    if (q) {
      list = index.filter(
        (r) =>
          r.id.startsWith(q) ||
          r.plz.some((p) => p.startsWith(q)) ||
          foldText(r.name).includes(q) ||
          r.places.some((p) => foldText(p).includes(q)),
      );
    }
    const shown = list.slice(0, 40);
    results.replaceChildren(
      ...(q || index.length <= 40
        ? shown.map((r) =>
            h(
              'div',
              { class: 'region' },
              h('div', { class: 'region-name' }, r.name),
              h('div', { class: 'region-meta' }, `${r.places.slice(0, 6).join(', ')}${r.places.length > 6 ? ' …' : ''}`),
              h('div', { class: 'region-meta' }, `${formatBytes(r.size)} · ${r.streets} Straßen · ${r.numbers} Nummern${r.gaps ? ` · ${r.gaps} ohne Nr.` : ''}`),
              progress(r.id),
              h(
                'button',
                { class: 'btn big' + (loadedIds.has(r.id) ? '' : ' primary'), disabled: busy.has(r.id), onClick: () => download(r) },
                loadedIds.has(r.id) ? '✓ Geladen – neu laden' : `Herunterladen (${formatBytes(r.size)})`,
              ),
            ),
          )
        : [h('p', { class: 'muted' }, `${index.length} Gebiete verfügbar. Bitte PLZ oder Ort eingeben.`)]),
      ...(q && !list.length ? [h('p', { class: 'muted' }, 'Kein Gebiet gefunden.')] : []),
      ...(list.length > shown.length ? [h('p', { class: 'muted' }, `… und ${list.length - shown.length} weitere. Suche genauer eingeben.`)] : []),
    );
  };

  const renderStorage = async () => {
    try {
      const est = await navigator.storage?.estimate?.();
      if (est?.usage !== undefined) storageEl.textContent = `Belegter Speicher: ${formatBytes(est.usage)}`;
    } catch {
      /* egal */
    }
  };

  input.addEventListener('input', render);
  root.append(
    h(
      'header',
      { class: 'topbar' },
      h('button', { class: 'btn', onClick: () => show('start', {}, false) }, '‹ Zurück'),
      h('div', { class: 'title' }, 'Gebiete'),
    ),
    h('div', { class: 'page' },
      h('h2', null, 'Auf dem Gerät'),
      loaded,
      storageEl,
      h('h2', null, 'Gebiet hinzufügen'),
      h('p', { class: 'hint' }, cellular ? '⚠ Mobilfunk erkannt – große Gebiete besser im WLAN laden.' : 'Am besten im WLAN herunterladen. Danach funktioniert alles offline.'),
      input,
      results,
      h('p', { class: 'muted small' }, 'Kartendaten © OpenStreetMap-Mitwirkende, Lizenz ODbL. Quellen je Gebiet unter „Daten“.'),
    ),
  );
  render();
  void renderStorage();
  fetchRegionIndex()
    .then((r) => {
      index = r.regions;
      render();
    })
    .catch(() => {
      loadError = navigator.onLine ? 'Gebietsliste nicht erreichbar.' : 'Offline – zum Herunterladen wird Internet benötigt.';
      render();
    });
}
