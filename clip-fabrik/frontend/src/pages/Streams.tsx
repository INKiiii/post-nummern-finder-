import { Link } from 'react-router-dom'
import { api, fmtDuration, fmtTime } from '../api'
import { Badge, Button, Card, Empty, PageHeader, usePoll, useToast } from '../components/ui'
import type { Stream } from '../types'

const STATUS: Record<string, { l: string; t: 'zinc' | 'live' | 'accent' | 'ok' | 'bad' | 'warn' }> = {
  recording: { l: 'nimmt auf', t: 'live' }, recorded: { l: 'aufgenommen', t: 'zinc' }, processing: { l: 'analysiert', t: 'accent' },
  done: { l: 'fertig', t: 'ok' }, failed: { l: 'Fehler', t: 'bad' }, unrecordable: { l: 'nicht aufnehmbar', t: 'bad' },
  waiting_approval: { l: 'Freigabe nötig', t: 'warn' },
}

export default function Streams() {
  const toast = useToast()
  const { data, reload } = usePoll(() => api<Stream[]>('/api/streams'), 8000)
  async function process(s: Stream, confirmed = false) {
    try { await api(`/api/streams/${s.id}/process`, { body: { confirmed } }); toast('Analyse gestartet', 'ok'); reload() } catch (e) { toast((e as Error).message, 'bad') }
  }
  return (
    <div>
      <PageHeader title="Streams & Uploads" right={<Link to="/upload" className="text-violet-300 text-sm font-semibold">+ Upload</Link>} />
      <div className="p-4 space-y-3">
        {data?.length === 0 && <Empty title="Noch keine Streams" />}
        {data?.map((s) => {
          const st = STATUS[s.status] || { l: s.status, t: 'zinc' as const }
          return (
            <Card key={s.id} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold truncate">{s.channel ? `${s.channel}: ` : ''}{s.title || `Stream ${s.id}`}</div>
                  <div className="text-xs text-zinc-400 mt-0.5">{fmtTime(s.started_at)} · {fmtDuration(s.duration)} · {s.source_type}</div>
                </div>
                <Badge tone={st.t}>{st.l}</Badge>
              </div>
              <div className="flex flex-wrap gap-3 text-sm text-zinc-300 mt-3">
                <span>{s.counts.review || 0} Review</span><span>{s.counts.archive || 0} Archiv</span><span>{s.counts.approved || 0} frei</span>
                <span className="text-zinc-500">KI: {s.cost_actual_usd.toFixed(2)} $ {s.cost_estimate_usd !== null ? `(geschätzt ${s.cost_estimate_usd.toFixed(2)} $)` : ''}</span>
              </div>
              {s.gaps.length > 0 && <div className="text-xs text-amber-300 mt-2">Lücken: {s.gaps.map((g) => `${fmtDuration(g.at)} (${Math.round(g.seconds)} s, ${g.reason})`).join(', ')}</div>}
              {s.error && <div className="text-sm text-red-300 mt-2">{s.error}</div>}
              <div className="grid grid-cols-2 gap-2 mt-3">
                <Link to={`/review?stream=${s.id}`} className="inline-flex items-center justify-center min-h-12 rounded-2xl bg-surface-2 font-semibold">Clips</Link>
                {s.status === 'waiting_approval' && <Button onClick={() => process(s, true)}>Trotzdem analysieren</Button>}
                {['done', 'failed', 'recorded'].includes(s.status) && <Button variant="soft" onClick={() => process(s)}>Neu analysieren</Button>}
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
