// Service Worker: hält die App selbst offline bereit (Vorlage, wird beim Build befüllt).
const VERSION = '__VERSION__';
const CACHE = 'hnf-app-' + VERSION;
const FILES = __FILES__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('hnf-app-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Gebietsdaten: immer frisch aus dem Netz (werden in IndexedDB gespeichert).
  if (url.pathname.includes('/regions/')) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./', { ignoreSearch: true }).then((r) => r || fetch(req)),
    );
    return;
  }
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req)));
});
