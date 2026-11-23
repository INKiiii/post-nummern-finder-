/// <reference lib="webworker" />
// Service Worker: App-Shell offline, Web-Push-Pop-ups, Tipp auf Benachrichtigung öffnet die Review-Ansicht.
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> }

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)
// Alle Seiten-Navigationen (außer API) aus der gecachten index.html bedienen
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }))

self.addEventListener('install', () => { self.skipWaiting() })
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()) })

self.addEventListener('push', (event) => {
  let data: { title?: string; body?: string; url?: string; tag?: string } = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { title: 'Clip-Fabrik', body: event.data?.text() } }
  const title = data.title || 'Clip-Fabrik'
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'clipfabrik',
    data: { url: data.url || '/review' },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL((event.notification.data && event.notification.data.url) || '/review', self.location.origin).href
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) {
        await (c as WindowClient).focus()
        await (c as WindowClient).navigate(url)
        return
      }
    }
    await self.clients.openWindow(url)
  })())
})
