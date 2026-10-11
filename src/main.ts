import './styles.css';
import { initApp, registerScreen, show } from './ui/app';
import { liveScreen } from './ui/live';
import { searchScreen } from './ui/search';
import { settingsScreen } from './ui/settingsscreen';
import { regionsScreen } from './ui/regions';
import { dataScreen } from './ui/datascreen';
import { newStreetScreen } from './ui/newstreet';
import { autoUpdateRegions, loadAll, state } from './data';
import { toast } from './ui/dom';
import { unlockAudio } from './approach';
import { loadRecents } from './recents';
import { loadTour } from './tour';
import { tourScreen } from './ui/tourscreen';
import { loadHouseInfos } from './houseinfo';
import { gps } from './gps';
import { startSession } from './session';
import { applyTheme } from './settings';
import { requestPersist, setUpdateReady } from './status';

registerScreen('live', liveScreen as any);
registerScreen('search', searchScreen as any);
registerScreen('settings', settingsScreen as any);
registerScreen('tour', tourScreen as any);
registerScreen('regions', regionsScreen as any);
registerScreen('data', dataScreen as any);
registerScreen('newstreet', newStreetScreen as any);

async function boot() {
  applyTheme();
  const root = document.getElementById('app')!;
  initApp(root);
  try {
    await Promise.all([loadAll(), loadRecents(), loadHouseInfos(), loadTour()]);
  } catch (e) {
    root.textContent = 'Speicher (IndexedDB) nicht verfügbar: ' + (e as Error).message;
    return;
  }
  gps.start();
  startSession();
  // Ton für Annäherungshinweise freischalten (iOS verlangt ein Tippen)
  document.addEventListener('pointerdown', unlockAudio, { passive: true });
  history.replaceState({ name: 'live' }, '');
  show('live', {}, false);
  if (!state.packages.length && !state.ustreets.length) show('regions');

  // Neue Kartendaten automatisch übernehmen (wöchentlicher Build)
  setTimeout(async () => {
    const names = await autoUpdateRegions();
    if (names.length) toast(`Kartendaten aktualisiert: ${names.join(', ')}`);
  }, 1500);

  // Daten dauerhaft speichern lassen (iOS kann Web-App-Speicher sonst aufräumen)
  void requestPersist();

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    const hadController = !!navigator.serviceWorker.controller;
    // Neue Version übernommen: nicht mitten in der Tour neu laden, nur anzeigen
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) setUpdateReady();
    });
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && navigator.onLine) reg.update().catch(() => {});
        });
      })
      .catch(() => {
        /* ohne SW läuft die App trotzdem, nur nicht offline */
      });
  }
}

void boot();
