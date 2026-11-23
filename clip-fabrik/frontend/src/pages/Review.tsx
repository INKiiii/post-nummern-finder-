import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, fmtDuration, PLATFORM_LABEL } from '../api'
import { Badge, Button, Card, Empty, PageHeader, ScoreBadge, Sheet, Spinner, Toggle, usePoll, useToast } from '../components/ui'
import type { Account, Clip } from '../types'

const SCORE_LABEL: Record<string, string> = { hook: 'Hook', payoff: 'Pointe', clarity: 'Verständlich', emotion: 'Emotion', meme: 'Meme', risk: 'Risiko' }

export default function Review() {
  const [params, setParams] = useSearchParams()
  const streamId = params.get('stream')
  const focusClip = params.get('clip')
  const [showLater, setShowLater] = useState(false)
  const states = showLater ? 'pending,later' : 'pending'
  const { data, loading, reload, setData } = usePoll(
    () => api<Clip[]>(`/api/clips?bucket=review&state=${states}${streamId ? `&stream_id=${streamId}` : ''}&limit=200`), 20000, [streamId, states])
  const { data: acc } = usePoll(() => api<{ accounts: Account[] }>('/api/accounts'), 0)
  const accounts = useMemo(() => (acc?.accounts || []).filter((a) => a.enabled && a.status === 'connected'), [acc])
  const [platforms, setPlatforms] = useState<number[] | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [last, setLast] = useState<{ clip: Clip; action: string } | null>(null)
  const toast = useToast()

  const clips = useMemo(() => {
    const list = data || []
    if (!focusClip) return list
    const i = list.findIndex((c) => String(c.id) === focusClip)
    return i > 0 ? [list[i], ...list.slice(0, i), ...list.slice(i + 1)] : list
  }, [data, focusClip])
  const current = clips[0]
  const selectedAccounts = platforms ?? accounts.map((a) => a.id)

  async function act(clip: Clip, action: 'approve' | 'reject' | 'later', override = false) {
    if (action === 'approve' && clip.safety_flagged && !clip.safety_override && !override) {
      const ok = confirm(`Safety-Hinweis: ${clip.safety_labels.join(', ') || 'Risiko'}.\n${clip.safety_note || ''}\n\nTrotzdem ausdrücklich freigeben?`)
      if (!ok) return
      override = true
    }
    setData((d) => (d || []).filter((c) => c.id !== clip.id))
    if (focusClip) { params.delete('clip'); setParams(params, { replace: true }) }
    try {
      await api(`/api/clips/${clip.id}/review`, { body: { action, account_ids: action === 'approve' ? selectedAccounts : undefined, safety_override: override } })
      setLast({ clip, action })
      if (navigator.vibrate) navigator.vibrate(action === 'approve' ? [20, 40, 20] : 25)
      if (action === 'approve') toast(selectedAccounts.length ? `Freigegeben – geplant für ${selectedAccounts.length} Konto/Konten` : 'Freigegeben (kein Konto verbunden – Export möglich)', 'ok')
    } catch (e) {
      toast((e as Error).message, 'bad')
      reload()
    }
  }

  async function undo() {
    if (!last) return
    try {
      await api(`/api/clips/${last.clip.id}/review`, { body: { action: 'reset' } })
      setLast(null)
      reload()
      toast('Rückgängig gemacht')
    } catch (e) { toast((e as Error).message, 'bad') }
  }

  return (
    <div>
      <PageHeader title="Review"
        sub={<div className="flex items-center justify-between text-sm text-zinc-400">
          <span>{clips.length} offen{streamId ? ' · dieser Stream' : ''}</span>
          {streamId && <button className="text-violet-300 font-semibold" onClick={() => { params.delete('stream'); setParams(params) }}>Alle Streams</button>}
        </div>}
        right={<>
          {last && <Button size="sm" variant="ghost" onClick={undo} aria-label="Rückgängig">↶</Button>}
          <Button size="sm" variant="soft" onClick={() => setBulkOpen(true)}>Sammel</Button>
        </>} />
      <div className="p-4 pb-28">
        {loading && !data && <div className="grid place-items-center py-16"><Spinner /></div>}
        {data && !current && (
          <Empty title="Alles geprüft 🎉" text="Neue Clips kommen per Push, sobald ein Stream fertig analysiert ist."
            action={<div className="flex flex-col gap-2 items-center"><Link to="/archiv" className="text-violet-300 font-semibold">Archiv „Auch gut“ ansehen</Link>
              <button className="text-zinc-400 text-sm" onClick={() => setShowLater(true)}>„Später“-Clips zeigen</button></div>} />
        )}
        {current && <SwipeCard key={current.id} clip={current} next={clips[1]} onAct={(a) => act(current, a)} />}
        {current && accounts.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2" aria-label="Plattformen für die Freigabe">
            {accounts.map((a) => {
              const on = selectedAccounts.includes(a.id)
              return (
                <button key={a.id} onClick={() => setPlatforms(on ? selectedAccounts.filter((x) => x !== a.id) : [...selectedAccounts, a.id])}
                  className={`min-h-10 px-3 rounded-full text-sm font-semibold border ${on ? 'bg-accent/20 border-accent text-violet-100' : 'border-line text-zinc-500'}`}>
                  {on ? '✓ ' : ''}{PLATFORM_LABEL[a.platform] || a.platform} · {a.name}
                </button>
              )
            })}
          </div>
        )}
        {current && <div className="mt-4"><Toggle label="„Später“-Clips mit anzeigen" checked={showLater} onChange={setShowLater} /></div>}
      </div>
      <BulkSheet open={bulkOpen} onClose={() => { setBulkOpen(false); reload() }} clips={clips} streamId={streamId} accountIds={selectedAccounts} />
    </div>
  )
}

function SwipeCard({ clip, next, onAct }: { clip: Clip; next?: Clip; onAct: (a: 'approve' | 'reject' | 'later') => void }) {
  const nav = useNavigate()
  const [drag, setDrag] = useState({ x: 0, y: 0, active: false })
  const start = useRef<{ x: number; y: number; id: number } | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [muted, setMuted] = useState(true)
  const [details, setDetails] = useState(false)
  const leaving = useRef(false)

  useEffect(() => { videoRef.current?.play().catch(() => {}) }, [clip.id])

  function down(e: React.PointerEvent) {
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId }
    setDrag({ x: 0, y: 0, active: true })
  }
  function move(e: React.PointerEvent) {
    if (!start.current || start.current.id !== e.pointerId) return
    const dx = e.clientX - start.current.x
    const dy = e.clientY - start.current.y
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setDrag({ x: dx, y: Math.min(0, dy), active: true })
  }
  function up() {
    if (!start.current) return
    const { x, y } = drag
    start.current = null
    if (Math.abs(x) < 8 && Math.abs(y) < 8) {
      // Tippen: Ton an/aus
      const v = videoRef.current
      if (v) { v.muted = !v.muted; setMuted(v.muted); v.play().catch(() => {}) }
      setDrag({ x: 0, y: 0, active: false })
      return
    }
    if (x > 110 || x < -110 || y < -120) {
      leaving.current = true
      const action = y < -120 && Math.abs(x) < 110 ? 'later' : x > 0 ? 'approve' : 'reject'
      setDrag({ x: action === 'later' ? 0 : x * 3, y: action === 'later' ? -900 : y, active: false })
      setTimeout(() => onAct(action), 160)
      return
    }
    setDrag({ x: 0, y: 0, active: false })
  }

  const rot = drag.x / 18
  const hint = drag.x > 60 ? 'approve' : drag.x < -60 ? 'reject' : drag.y < -70 ? 'later' : null
  const flags = clip.safety_flagged && !clip.safety_override

  return (
    <div className="relative">
      {next?.thumb_url && <img src={next.thumb_url} alt="" className="hidden" />}
      <Card className="overflow-hidden">
        <div
          className="relative touch-none select-none"
          style={{ transform: `translate(${drag.x}px, ${drag.y}px) rotate(${rot}deg)`, transition: drag.active ? 'none' : 'transform .2s ease-out' }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { start.current = null; setDrag({ x: 0, y: 0, active: false }) }}
          role="group" aria-label={`Clip: ${clip.title}`}
        >
          <div className="relative mx-auto bg-black" style={{ aspectRatio: '9 / 16', height: 'min(52dvh, calc((100vw - 34px) * 16 / 9))' }}>
            {clip.preview_url ? (
              <video ref={videoRef} src={clip.preview_url} poster={clip.thumb_url || undefined} className="h-full w-full object-contain"
                autoPlay muted loop playsInline preload="auto" />
            ) : (
              <div className="h-full grid place-items-center text-zinc-500 text-sm">{clip.render_status === 'failed' ? `Render-Fehler: ${clip.render_error}` : 'Vorschau wird gerendert …'}</div>
            )}
            {/* Abzeichen unten: oben liegt im Clip die Hook-Zeile */}
            <div className="absolute bottom-3 left-3 flex gap-2"><ScoreBadge score={clip.total_score} big /></div>
            <div className="absolute bottom-3 right-3 flex flex-col items-end gap-1.5">
              {clip.origin !== 'post' && <Badge tone="accent">{clip.origin === 'manual' ? 'markiert' : 'live'}</Badge>}
              <Badge tone="zinc">{fmtDuration(clip.duration)}</Badge>
            </div>
            {muted && clip.preview_url && <div className="absolute bottom-16 left-0 right-0 flex justify-center pointer-events-none"><Badge tone="zinc">🔇 Tippen für Ton</Badge></div>}
            {hint && (
              <div className={`absolute inset-0 grid place-items-center text-4xl font-black ${hint === 'approve' ? 'bg-ok/30 text-green-200' : hint === 'reject' ? 'bg-bad/30 text-red-200' : 'bg-accent/30 text-violet-100'}`}>
                {hint === 'approve' ? '✓ FREIGEBEN' : hint === 'reject' ? '✕ WEG' : '⏱ SPÄTER'}
              </div>
            )}
          </div>
        </div>
        <div className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-bold text-lg leading-snug">{clip.title || clip.hook_text || 'Ohne Titel'}</div>
              <div className="text-sm text-zinc-400 mt-0.5">{clip.channel} · {clip.category}{clip.rank ? ` · Platz ${clip.rank}` : ''}</div>
            </div>
            <button onClick={() => setDetails(!details)} className="shrink-0 h-10 px-3 rounded-xl bg-surface-2 text-sm" aria-expanded={details}>Raster</button>
          </div>
          {clip.reason && <p className="text-[15px] text-zinc-200 mt-2 leading-relaxed">{clip.reason}</p>}
          {flags && (
            <div className="mt-3 rounded-2xl border border-warn/40 bg-warn/10 p-3 text-sm" role="alert">
              <div className="font-semibold text-amber-300">⚠ Safety-Hinweis: {clip.safety_labels.join(', ') || 'Risiko'}</div>
              {clip.safety_note && <div className="text-amber-100/80 mt-1">{clip.safety_note}</div>}
              <div className="text-amber-100/60 mt-1">Nur mit ausdrücklicher Freigabe.</div>
            </div>
          )}
          {details && (
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
              {Object.entries(clip.scores || {}).map(([k, v]) => (
                <div key={k} className="text-sm">
                  <div className="flex justify-between text-zinc-400"><span>{SCORE_LABEL[k] || k}</span><span className="tabular-nums text-zinc-200">{v}</span></div>
                  <div className="h-1.5 rounded-full bg-zinc-800 mt-1"><div className={`h-full rounded-full ${k === 'risk' ? 'bg-bad' : 'bg-accent'}`} style={{ width: `${v * 10}%` }} /></div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
      <p className="text-center text-xs text-zinc-500 mt-3">Wischen: → freigeben · ← ablehnen · ↑ später</p>
      {/* Aktionsknöpfe immer erreichbar, direkt über der Navigation */}
      <div className="fixed left-0 right-0 z-20 px-4 pt-3 pb-2 bg-gradient-to-t from-bg via-bg/95 to-transparent" style={{ bottom: 'calc(64px + max(env(safe-area-inset-bottom), 8px))' }}>
        <div className="max-w-2xl mx-auto grid grid-cols-4 gap-2">
          <Button variant="danger" size="lg" onClick={() => onAct('reject')} aria-label="Ablehnen" className="text-2xl">✕</Button>
          <Button variant="soft" size="lg" onClick={() => onAct('later')} aria-label="Später">⏱</Button>
          <Button variant="soft" size="lg" onClick={() => nav(`/clips/${clip.id}`)} aria-label="Bearbeiten">✎</Button>
          <Button variant="ok" size="lg" onClick={() => onAct('approve')} aria-label="Freigeben" className="text-2xl">✓</Button>
        </div>
      </div>
    </div>
  )
}

function BulkSheet({ open, onClose, clips, streamId, accountIds }: { open: boolean; onClose: () => void; clips: Clip[]; streamId: string | null; accountIds: number[] }) {
  const toast = useToast()
  const [minScore, setMinScore] = useState(8)
  const [selected, setSelected] = useState<number[]>([])
  const count = clips.filter((c) => c.total_score >= minScore && !(c.safety_flagged && !c.safety_override)).length

  async function bulk(body: Record<string, unknown>) {
    try {
      const r = await api<{ done: number[]; skipped: { id: number; reason: string }[] }>('/api/clips/bulk', { body: { ...body, account_ids: accountIds } })
      toast(`${r.done.length} erledigt${r.skipped.length ? `, ${r.skipped.length} übersprungen (Safety)` : ''}`, 'ok')
      setSelected([])
      onClose()
    } catch (e) { toast((e as Error).message, 'bad') }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Sammelaktionen">
      <div className="space-y-5">
        <div>
          <div className="font-semibold mb-2">Alle ab Score {minScore.toFixed(1)} freigeben</div>
          <input type="range" min={5} max={10} step={0.5} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} className="w-full h-10" aria-label="Mindest-Score" />
          <Button variant="ok" className="w-full mt-2" disabled={!count}
            onClick={() => bulk({ action: 'approve', min_score: minScore, stream_id: streamId ? Number(streamId) : undefined })}>
            {count} Clips freigeben
          </Button>
          <p className="text-xs text-zinc-500 mt-2">Clips mit Safety-Hinweis werden übersprungen und müssen einzeln freigegeben werden.</p>
        </div>
        <div>
          <div className="font-semibold mb-2">Auswählen</div>
          <div className="space-y-2 max-h-[40vh] overflow-y-auto">
            {clips.map((c) => (
              <label key={c.id} className="flex items-center gap-3 rounded-2xl bg-surface-2 p-2 min-h-14">
                <input type="checkbox" className="h-6 w-6 accent-violet-500" checked={selected.includes(c.id)}
                  onChange={(e) => setSelected(e.target.checked ? [...selected, c.id] : selected.filter((x) => x !== c.id))} />
                {c.thumb_url ? <img src={c.thumb_url} alt="" className="h-12 w-7 object-cover rounded" /> : <div className="h-12 w-7 bg-zinc-800 rounded" />}
                <span className="flex-1 min-w-0 text-sm truncate">{c.title}</span>
                <ScoreBadge score={c.total_score} />
              </label>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2 mt-3">
            <Button variant="danger" disabled={!selected.length} onClick={() => bulk({ action: 'reject', ids: selected })}>Ablehnen</Button>
            <Button variant="soft" disabled={!selected.length} onClick={() => bulk({ action: 'archive', ids: selected })}>Archiv</Button>
            <Button variant="ok" disabled={!selected.length} onClick={() => bulk({ action: 'approve', ids: selected })}>Freigeben</Button>
          </div>
        </div>
      </div>
    </Sheet>
  )
}
