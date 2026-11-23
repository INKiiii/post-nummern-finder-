// Kleiner Fetch-Wrapper: JSON, deutsche Fehlermeldungen, 401 -> Login
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      signal: opts.signal,
    })
  } catch {
    throw new ApiError(0, 'Keine Verbindung zum Server')
  }
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    onUnauthorized?.()
  }
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) {
    const detail = (data as { detail?: unknown })?.detail
    const msg = typeof detail === 'string' ? detail : `Fehler ${res.status}`
    throw new ApiError(res.status, msg)
  }
  return data as T
}

export const fmtDuration = (s: number) => {
  s = Math.max(0, Math.round(s))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

export const fmtTime = (iso: string | null) => {
  if (!iso) return '–'
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const tomorrow = new Date(today.getTime() + 86400000).toDateString() === d.toDateString()
  const t = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return `heute ${t}`
  if (tomorrow) return `morgen ${t}`
  return `${d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })} ${t}`
}

export const PLATFORM_LABEL: Record<string, string> = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', mock: 'Test' }
