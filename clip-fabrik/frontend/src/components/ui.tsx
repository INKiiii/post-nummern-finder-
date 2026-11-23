import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

// ---------------------------------------------------------------- Buttons & Bausteine (Daumen-tauglich: min. 48 px)
type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'ok' | 'soft'; size?: 'md' | 'lg' | 'sm' }

export function Button({ variant = 'primary', size = 'md', className = '', ...p }: BtnProps) {
  const base = 'inline-flex items-center justify-center gap-2 rounded-2xl font-semibold transition active:scale-[.97] disabled:opacity-40 disabled:active:scale-100 select-none'
  const sizes = { sm: 'min-h-10 px-3 text-sm', md: 'min-h-12 px-4 text-base', lg: 'min-h-14 px-5 text-lg' }
  const variants = {
    primary: 'bg-accent text-white',
    ghost: 'bg-transparent text-zinc-200 border border-line',
    danger: 'bg-bad/15 text-red-300 border border-bad/30',
    ok: 'bg-ok text-black',
    soft: 'bg-surface-2 text-zinc-100',
  }
  return <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...p} />
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-3xl bg-surface border border-line ${className}`}>{children}</div>
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={`flex items-center justify-between gap-4 min-h-12 py-2 ${disabled ? 'opacity-50' : ''}`}>
      <span className="min-w-0">
        <span className="block text-[15px]">{label}</span>
        {hint && <span className="block text-xs text-zinc-400 mt-0.5">{hint}</span>}
      </span>
      <button
        type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative shrink-0 w-14 h-8 rounded-full transition ${checked ? 'bg-accent' : 'bg-zinc-700'}`}
      >
        <span className={`absolute top-1 h-6 w-6 rounded-full bg-white transition-all ${checked ? 'left-7' : 'left-1'}`} />
      </button>
    </label>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="block text-sm text-zinc-300 mb-1.5">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-500 mt-1">{hint}</span>}
    </label>
  )
}

export const inputCls = 'w-full min-h-12 rounded-2xl bg-surface-2 border border-line px-4 py-3 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-accent'

export function Badge({ children, tone = 'zinc' }: { children: ReactNode; tone?: 'zinc' | 'ok' | 'bad' | 'warn' | 'accent' | 'live' }) {
  const tones = {
    zinc: 'bg-zinc-800 text-zinc-300', ok: 'bg-ok/15 text-green-300', bad: 'bg-bad/15 text-red-300',
    warn: 'bg-warn/15 text-amber-300', accent: 'bg-accent/20 text-violet-200', live: 'bg-red-600 text-white',
  }
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${tones[tone]}`}>{children}</span>
}

export function ScoreBadge({ score, big }: { score: number; big?: boolean }) {
  const tone = score >= 8.5 ? 'bg-hl text-black' : score >= 7 ? 'bg-ok text-black' : score >= 5 ? 'bg-zinc-700 text-white' : 'bg-zinc-800 text-zinc-400'
  return <span className={`inline-flex items-center justify-center rounded-2xl font-black tabular-nums ${tone} ${big ? 'h-12 min-w-12 px-3 text-xl' : 'h-8 min-w-8 px-2 text-sm'}`}>{score.toFixed(1)}</span>
}

export function Progress({ value, className = '' }: { value: number; className?: string }) {
  return (
    <div className={`h-2 rounded-full bg-zinc-800 overflow-hidden ${className}`}>
      <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </div>
  )
}

export function Empty({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="text-center py-16 px-6">
      <div className="text-4xl mb-3">🎬</div>
      <div className="text-lg font-semibold">{title}</div>
      {text && <p className="text-zinc-400 mt-2 text-sm leading-relaxed">{text}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}

export function Spinner() {
  return <div className="h-6 w-6 rounded-full border-2 border-zinc-600 border-t-accent animate-spin" aria-label="lädt" />
}

export function PageHeader({ title, right, sub }: { title: string; right?: ReactNode; sub?: ReactNode }) {
  return (
    <header className="safe-top sticky top-0 z-20 bg-bg/90 backdrop-blur border-b border-line/60">
      <div className="flex items-center justify-between gap-3 px-4 h-14">
        <h1 className="text-xl font-bold truncate">{title}</h1>
        <div className="flex items-center gap-2 shrink-0">{right}</div>
      </div>
      {sub && <div className="px-4 pb-3">{sub}</div>}
    </header>
  )
}

// ---------------------------------------------------------------- Bottom-Sheet
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-xl max-h-[88vh] overflow-y-auto rounded-t-3xl bg-surface border-t border-line safe-bottom animate-pop">
        <div className="sticky top-0 bg-surface z-10 pt-2 pb-3 px-5 border-b border-line/50">
          <div className="mx-auto h-1.5 w-12 rounded-full bg-zinc-600 mb-3" />
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">{title}</h2>
            <button onClick={onClose} className="h-10 w-10 rounded-full bg-surface-2 text-xl" aria-label="Schließen">×</button>
          </div>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Toasts
type Toast = { id: number; text: string; tone: 'ok' | 'bad' | 'info' }
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const idRef = useRef(0)
  const push = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = ++idRef.current
    setToasts((t) => [...t, { id, text, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed left-0 right-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={`pointer-events-auto max-w-md w-full rounded-2xl px-4 py-3 text-sm font-medium shadow-lg animate-pop ${
            t.tone === 'ok' ? 'bg-ok text-black' : t.tone === 'bad' ? 'bg-bad text-white' : 'bg-zinc-100 text-black'}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

// ---------------------------------------------------------------- Polling-Hook
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const fnRef = useRef(fn)
  fnRef.current = fn
  const reload = useCallback(async () => {
    try {
      const d = await fnRef.current()
      setData(d)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    setLoading(true)
    reload()
    if (!intervalMs) return
    const id = setInterval(() => { if (document.visibilityState === 'visible') reload() }, intervalMs)
    const onVis = () => { if (document.visibilityState === 'visible') reload() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { data, error, loading, reload, setData }
}

// ---------------------------------------------------------------- Doppel-Regler (Trim)
export function RangeSlider({ min, max, start, end, onChange, step = 0.1 }: { min: number; max: number; start: number; end: number; step?: number; onChange: (s: number, e: number) => void }) {
  const pct = (v: number) => ((v - min) / (max - min || 1)) * 100
  return (
    <div className="relative h-12 select-none">
      <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-2 rounded-full bg-zinc-800" />
      <div className="absolute top-1/2 -translate-y-1/2 h-2 rounded-full bg-accent" style={{ left: `${pct(start)}%`, right: `${100 - pct(end)}%` }} />
      <input aria-label="Start" type="range" min={min} max={max} step={step} value={start}
        onChange={(e) => onChange(Math.min(Number(e.target.value), end - 3), end)}
        className="range-thumb absolute inset-0 w-full appearance-none bg-transparent pointer-events-none" />
      <input aria-label="Ende" type="range" min={min} max={max} step={step} value={end}
        onChange={(e) => onChange(start, Math.max(Number(e.target.value), start + 3))}
        className="range-thumb absolute inset-0 w-full appearance-none bg-transparent pointer-events-none" />
      <style>{`.range-thumb::-webkit-slider-thumb{pointer-events:auto;-webkit-appearance:none;height:32px;width:32px;border-radius:999px;background:#fff;border:4px solid #8b5cf6}
      .range-thumb::-moz-range-thumb{pointer-events:auto;height:28px;width:28px;border-radius:999px;background:#fff;border:4px solid #8b5cf6}`}</style>
    </div>
  )
}
