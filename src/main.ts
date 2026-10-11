import './styles.css';
import { initApp, registerScreen, show } from './ui/app';
import { startScreen } from './ui/start';
import { resultScreen } from './ui/result';
import { regionsScreen } from './ui/regions';
import { dataScreen } from './ui/datascreen';
import { newStreetScreen } from './ui/newstreet';
import { autoUpdateRegions, loadAll, state } from './data';
import { toast } from './ui/dom';
import { unlockAudio } from './approach';
import { loadPhotos } from './photos';
import { loadStats } from './stats';
import { loadRecents } from './recents';
import { loadHouseInfos } from './houseinfo';
import { gps } from './gps';

registerScreen('start', startScreen as any);
registerScreen('result', resultScreen as any);
registerScreen('regions', regionsScreen as any);
registerScreen('data', dataScreen as any);
registerScreen('newstreet', newStreetScreen as any);

async function boot() {
  const root = document.getElementById('app')!;
  initApp(root);
  try {
    await Promise.all([loadAll(), loadRecents(), loadHouseInfos(), loadPhotos(), loadStats()]);
  } catch (e) {
    root.textContent = 'Speicher (IndexedDB) nicht verfügbar: ' + (e as Error).message;
    return;
  }
  gps.start();
  // Ton für Annäherungshinweise freischalten (iOS verlangt ein Tippen)
  document.addEventListener('pointerdown', unlockAudio, { passive: true });
  history.replaceState({ name: 'start' }, '');
  if (!state.packages.length && !state.ustreets.length) {
    show('start', {}, false);
    show('regions');
  } else show('start', {}, false);

  // Neue Kartendaten automatisch übernehmen (wöchentlicher Build)
  setTimeout(async () => {
    const names = await autoUpdateRegions();
    if (names.length) toast(`Kartendaten aktualisiert: ${names.join(', ')}`);
  }, 1500);

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* ohne SW läuft die App trotzdem, nur nicht offline */
    });
  }
}

void boot();
