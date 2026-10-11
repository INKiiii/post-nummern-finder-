// Prüft, ob App (Service Worker + Cache) und Gebiete vollständig auf dem Gerät liegen.

import { state } from './data';

export interface OfflineStatus {
  app: boolean;
  regions: number;
}

export async function offlineStatus(): Promise<OfflineStatus> {
  const regions = state.packages.length;
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return { app: false, regions };
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((r) => setTimeout(() => r(null), 4000)),
    ]);
    const sw = reg?.active;
    if (!sw) return { app: false, regions };
    const app = await new Promise<boolean>((resolve) => {
      const ch = new MessageChannel();
      const timer = setTimeout(() => resolve(false), 4000);
      ch.port1.onmessage = (e) => {
        clearTimeout(timer);
        resolve(!!e.data?.complete);
      };
      sw.postMessage({ type: 'offline-check' }, [ch.port2]);
    });
    return { app, regions };
  } catch {
    return { app: false, regions };
  }
}
