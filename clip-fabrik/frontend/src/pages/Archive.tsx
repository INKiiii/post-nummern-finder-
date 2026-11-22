import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, fmtDuration } from '../api'
import { Button, Card, Empty, PageHeader, ScoreBadge, Spinner, usePoll, useToast } from '../components/ui'
import type { Clip } from '../types'

const TABS = [
  { key: 'archive', label: 'Auch gut', q: 'bucket=archive' },
  { key: 'approved', label: 'Freigegeben', q: 'bucket=review&state=approved' },
  { key: 'rejected', label: 'Abgelehnt', q: 'bucket=all&state=rejected' },
  { key: 'discarded', label: 'Aussortiert', q: 'bucket=discarded' },
]

export default function Archive() {
  const [tab, setTab] = useState(TABS[0])
  const toast = useToast()
  const { data, loading, reload } = usePoll(() => api<Clip[]>(`/api/clips?${tab.q}&order=score&limit=200`), 0, [tab.key])
  const [selected, setSelected] = useState<number[]>([])

  async function move(id: number) {
    try { await api(`/api/clips/${id}/move`, { body: { bucket: 'review' } }); toast('In die Review-Liste verschoben', 'ok'); reload() } catch (e) { toast((e as Error).message, 'bad') }
  }

  async function exportSel() {
    try {
      const { job_id } = await api<{ job_id: number }>('/api/export', { body: { clip_ids: selected } })
      toast('Export wird gebaut …')
      const poll = setInterval(async () => {
        const st = await api<{ status: string; download_url: string | null; error: string | null }>(`/api/export/${job_id}`)
        if (st.status === 'done' && st.download_url) { clearInterval(poll); window.location.href = st.download_url }
        if (st.status === 'failed') { clearInterval(poll); toast(st.error || 'Export fehlgeschlagen', 'bad') }
      }, 2500)
    } catch (e) { toast((e as Error).message, 'bad') }
  }

  return (
    <div>
      <PageHeader title="Archiv" sub={
        <div className="flex gap-2 overflow-x-auto no-scrollbar">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => { setTab(t); setSelected([]) }}
              className={`shrink-0 min-h-10 px-4 rounded-full text-sm font-semibold ${tab.key === t.key ? 'bg-accent text-white' : 'bg-surface-2 text-zinc-400'}`}>{t.label}</button>
          ))}
        </div>} />
      <div className="p-4 space-y-2">
        {loading && !data && <div className="grid place-items-center py-10"><Spinner /></div>}
        {data?.length === 0 && <Empty title="Leer" text={tab.key === 'archive' ? 'Clips, die gut waren, aber nicht in die Top-Liste gekommen sind, landen hier.' : undefined} />}
        {data?.map((c) => (
          <Card key={c.id} className="p-2 flex items-center gap-3">
            {tab.key === 'approved' && (
              <input type="checkbox" className="h-6 w-6 accent-violet-500 ml-1" aria-label="Für Export auswählen" checked={selected.includes(c.id)}
                onChange={(e) => setSelected(e.target.checked ? [...selected, c.id] : selected.filter((x) => x !== c.id))} />
            )}
            <Link to={`/clips/${c.id}`} className="flex items-center gap-3 flex-1 min-w-0">
              {c.thumb_url ? <img src={c.thumb_url} alt="" className="h-16 w-9 rounded object-cover" /> : <div className="h-16 w-9 rounded bg-zinc-800" />}
              <div className="min-w-0">
                <div className="font-semibold truncate">{c.title || c.hook_text || 'Clip'}</div>
                <div className="text-xs text-zinc-400">{c.channel} · {c.category} · {fmtDuration(c.duration)}</div>
                {tab.key === 'discarded' && <div className="text-xs text-zinc-500 truncate">{c.reason}</div>}
              </div>
            </Link>
            <ScoreBadge score={c.total_score} />
            {(tab.key === 'archive' || tab.key === 'discarded') && <Button size="sm" variant="soft" onClick={() => move(c.id)} aria-label="In Review">↑</Button>}
          </Card>
        ))}
        {tab.key === 'approved' && !!data?.length && (
          <div className="pt-3 space-y-2">
            <Button className="w-full" variant="soft" onClick={() => setSelected(selected.length ? [] : data.map((c) => c.id))}>{selected.length ? 'Auswahl aufheben' : 'Alle auswählen'}</Button>
            <Button className="w-full" disabled={!selected.length} onClick={exportSel}>Export-Paket ({selected.length}) – Clips + captions.csv</Button>
            <p className="text-xs text-zinc-500">Für Plattformen ohne API-Freigabe: ZIP am Handy öffnen, Clip in die App teilen, Text aus der CSV kopieren.</p>
          </div>
        )}
      </div>
    </div>
  )
}
