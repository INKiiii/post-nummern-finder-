import { api } from './api'

function urlB64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

export function pushSupport(): { ok: boolean; reason?: string } {
  if (!('serviceWorker' in navigator)) return { ok: false, reason: 'Dieser Browser kann keine Service Worker.' }
  if (!('PushManager' in window)) {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
    return { ok: false, reason: ios ? 'Auf dem iPhone: erst „Zum Home-Bildschirm“ hinzufügen und die App von dort öffnen.' : 'Dieser Browser unterstützt kein Web-Push.' }
  }
  if (!window.isSecureContext) return { ok: false, reason: 'Web-Push braucht HTTPS.' }
  return { ok: true }
}

export async function registerSW() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return null
  try { return await navigator.serviceWorker.register('/sw.js', { scope: '/' }) } catch { return null }
}

export async function enablePush(): Promise<string> {
  const sup = pushSupport()
  if (!sup.ok) throw new Error(sup.reason)
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw new Error('Benachrichtigungen wurden nicht erlaubt (Einstellungen des Handys prüfen).')
  const reg = (await navigator.serviceWorker.getRegistration()) || (await registerSW())
  if (!reg) throw new Error('Service Worker nicht aktiv – Seite neu laden.')
  const { public_key } = await api<{ public_key: string }>('/api/push/vapid')
  const sub = (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(public_key) }))
  const json = sub.toJSON()
  await api('/api/push/subscribe', { body: { endpoint: json.endpoint, keys: json.keys } })
  return 'Push-Benachrichtigungen aktiv'
}

export async function pushActive(): Promise<boolean> {
  if (!pushSupport().ok) return false
  const reg = await navigator.serviceWorker.getRegistration()
  return !!(reg && (await reg.pushManager.getSubscription()))
}
