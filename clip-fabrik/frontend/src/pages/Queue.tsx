import { useEffect, useMemo, useState } from 'react'
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Link } from 'react-router-dom'
import { api, fmtTime, PLATFORM_LABEL } from '../api'
import { Badge, Button, Card, Empty, PageHeader, Progress, Spinner, usePoll, useToast } from '../components/ui'
import type { Publication, Quota } from '../types'

const STATUS: Record<string, { label: string; tone: 'zinc' | 'ok' | 'bad' | 'warn' | 'accent' }> = {
  scheduled: { label: 'geplant', tone: 'zinc' }, running: { label: 'läuft', tone: 'accent' }, processing: { label: 'wird verarbeitet', tone: 'accent' },
  live: { label: 'live', tone: 'ok' }, failed: { label: 'Fehler', tone: 'bad' }, cancelled: { label: 'abgebrochen', tone: 'zinc' },
  needs_safety: { label: 'Freigabe nötig', tone: 'warn' },
}

type QueueData = { active: Publication[]; recent: Publication[]; quotas: Quota[] }

export default function Queue() {
  const { data, loading, reload, setData } = usePoll(() => api<QueueData>('/api/queue'), 10000)
  const toast = useToast()
  const byAccount = useMemo(() => {
    const m = new Map<number, Publication[]>()
    for (const p of data?.active || []) {
      if (!m.has(p.account_id)) m.set(p.account_id, [])
      m.get(p.account_id)!.push(p)
    }
    return m
  }, [data])

  async function action(p: Publication, a: 'cancel' | 'retry' | 'now') {
    try {
      const d = await api<QueueData>(`/api/queue/${p.id}/${a}`, { body: {} })
      setData(d)
      toast({ cancel: 'Abgebrochen', retry: 'Neu eingeplant', now: 'Wird jetzt veröffentlicht' }[a], 'ok')
    } catch (e) { toast((e as Error).message, 'bad') }
  }

  async function reorder(accountId: number, ids: number[]) {
    try {
      setData(await api<QueueData>('/api/queue/reorder', { body: { account_id: accountId, publication_ids: ids } }))
    } catch (e) { toast((e as Error).message, 'bad'); reload() }
  }

  return (
    <div>
      <PageHeader title="Warteschlange" right={<Link to="/konten" className="text-violet-300 text-sm font-semibold">Konten</Link>} />
      <div className="p-4 space-y-5">
        {loading && !data && <div className="grid place-items-center py-10"><Spinner /></div>}
        {data && data.quotas.length > 0 && (
          <Card className="p-4">
            <div className="font-semibold mb-3">Heute noch möglich</div>
            <div className="space-y-3">
              {data.quotas.map((q) => (
                <div key={q.account_id}>
                  <div className="flex justify-between text-sm"><span>{PLATFORM_LABEL[q.platform] || q.platform} · {q.name}</span><span className="tabular-nums font-semibold">{q.left} von {q.cap}</span></div>
                  <Progress value={q.cap ? q.used / q.cap : 1} className="mt-1.5" />
                  {q.note && <div className="text-xs text-zinc-500 mt-1">{q.note}</div>}
                </div>
              ))}
            </div>
          </Card>
        )}
        {data && data.active.length === 0 && (
          <Empty title="Nichts geplant" text="Freigegebene Clips landen hier und werden über die Sendefenster verteilt – mit Tageslimit und zufälligem Versatz." />
        )}
        {[...byAccount.entries()].map(([aid, pubs]) => (
          <AccountQueue key={aid} pubs={pubs} onReorder={(ids) => reorder(aid, ids)} onAction={action} />
        ))}
        {data && data.recent.length > 0 && (
          <div>
            <div className="text-sm font-semibold text-zinc-400 mb-2 px-1">Zuletzt</div>
            <div className="space-y-2">
              {data.recent.map((p) => <PubRow key={p.id} p={p} onAction={action} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function AccountQueue({ pubs, onReorder, onAction }: { pubs: Publication[]; onReorder: (ids: number[]) => void; onAction: (p: Publication, a: 'cancel' | 'retry' | 'now') => void }) {
  const [items, setItems] = useState(pubs)
  useEffect(() => { setItems(pubs) }, [pubs])
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const fixed = items.filter((p) => p.status !== 'scheduled')
  const sortable = items.filter((p) => p.status === 'scheduled')

  function end(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return
    const moved = arrayMove(sortable, sortable.findIndex((p) => p.id === e.active.id), sortable.findIndex((p) => p.id === e.over!.id))
    setItems([...fixed, ...moved])
    onReorder(moved.map((p) => p.id))
  }

  const first = items[0]
  if (!first) return null
  return (
    <div>
      <div className="text-sm font-semibold text-zinc-400 mb-2 px-1">{PLATFORM_LABEL[first.platform] || first.platform} · {first.account_name}</div>
      <div className="space-y-2">
        {fixed.map((p) => <PubRow key={p.id} p={p} onAction={onAction} />)}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={end}>
          <SortableContext items={sortable.map((p) => p.id)} strategy={verticalListSortingStrategy}>
            {sortable.map((p) => <SortableRow key={p.id} p={p} onAction={onAction} />)}
          </SortableContext>
        </DndContext>
      </div>
      {sortable.length > 1 && <p className="text-xs text-zinc-500 mt-2 px-1">Gedrückt halten und ziehen zum Umsortieren – die Zeiten werden neu verteilt.</p>}
    </div>
  )
}

function SortableRow({ p, onAction }: { p: Publication; onAction: (p: Publication, a: 'cancel' | 'retry' | 'now') => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: p.id })
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined }} className={isDragging ? 'opacity-90 scale-[1.02]' : ''}>
      <PubRow p={p} onAction={onAction} handle={<button {...attributes} {...listeners} className="h-12 w-10 text-zinc-500 text-xl touch-none" aria-label="Verschieben">⋮⋮</button>} />
    </div>
  )
}

function PubRow({ p, onAction, handle }: { p: Publication; onAction: (p: Publication, a: 'cancel' | 'retry' | 'now') => void; handle?: React.ReactNode }) {
  const st = STATUS[p.status] || { label: p.status, tone: 'zinc' as const }
  const [open, setOpen] = useState(false)
  return (
    <Card className="p-2">
      <div className="flex items-center gap-2">
        {handle}
        {p.clip?.thumb_url ? <img src={p.clip.thumb_url} alt="" className="h-14 w-8 rounded object-cover" /> : <div className="h-14 w-8 rounded bg-zinc-800" />}
        <button className="flex-1 min-w-0 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          <div className="font-semibold truncate text-[15px]">{p.clip?.title || `Clip ${p.clip_id}`}</div>
          <div className="text-xs text-zinc-400 mt-0.5">{p.status === 'live' ? `live ${fmtTime(p.published_at)}` : fmtTime(p.scheduled_at)} · {PLATFORM_LABEL[p.platform] || p.platform}</div>
        </button>
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>
      {open && (
        <div className="px-2 pb-2 pt-3 space-y-3">
          {p.error && <p className={`text-sm ${p.status === 'failed' ? 'text-red-300' : 'text-amber-200'}`}>{p.error}</p>}
          {p.status === 'live' && p.external_url && <a href={p.external_url} target="_blank" rel="noreferrer" className="text-violet-300 text-sm">Ansehen ↗</a>}
          {p.metrics?.views !== undefined && <p className="text-sm text-zinc-300">{p.metrics.views.toLocaleString('de-DE')} Views · {(p.metrics.likes || 0).toLocaleString('de-DE')} Likes</p>}
          <div className="grid grid-cols-3 gap-2">
            {p.status === 'scheduled' && <Button size="sm" variant="soft" onClick={() => onAction(p, 'now')}>Jetzt</Button>}
            {['failed', 'needs_safety', 'cancelled'].includes(p.status) && <Button size="sm" variant="soft" onClick={() => onAction(p, 'retry')}>Erneut</Button>}
            {['scheduled', 'needs_safety', 'failed'].includes(p.status) && <Button size="sm" variant="danger" onClick={() => onAction(p, 'cancel')}>Abbrechen</Button>}
            <Link to={`/clips/${p.clip_id}`} className="inline-flex items-center justify-center min-h-10 rounded-2xl bg-surface-2 text-sm font-semibold">Clip</Link>
          </div>
        </div>
      )}
    </Card>
  )
}
