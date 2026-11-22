import { Link } from 'react-router-dom'
import { api, PLATFORM_LABEL } from '../api'
import { Button, Card, Empty, PageHeader, Spinner, usePoll, useToast } from '../components/ui'

type TopRow = { clip_id: number; title: string; views: number; likes: number; comments: number; platforms: { platform: string; url: string | null; views: number }[] }
type Data = {
  per_platform: Record<string, { posts: number; views: number; likes: number; comments: number }>
  top: TopRow[]; flop: TopRow[]; review_counts: Record<string, number>; approval_rate: number | null
  llm_cost_30d_usd: number; llm_cached_calls_30d: number; streams_30d: number; feedback_examples: string
}

const n = (x: number) => x.toLocaleString('de-DE')

export default function Dashboard() {
  const toast = useToast()
  const { data, loading } = usePoll(() => api<Data>('/api/analytics'), 60000)
  return (
    <div>
      <PageHeader title="Auswertung" right={<Button size="sm" variant="soft" onClick={async () => { await api('/api/analytics/refresh', { body: {} }); toast('Zahlen werden geholt …') }}>Aktualisieren</Button>} />
      <div className="p-4 space-y-5">
        {loading && !data && <div className="grid place-items-center py-10"><Spinner /></div>}
        {data && (<>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Freigabe-Quote" value={data.approval_rate !== null ? `${data.approval_rate} %` : '–'} />
            <Stat label="Streams (30 Tage)" value={String(data.streams_30d)} />
            <Stat label="KI-Kosten (30 Tage)" value={`${data.llm_cost_30d_usd.toFixed(2)} $`} />
            <Stat label="Aus dem Cache" value={`${data.llm_cached_calls_30d} Aufrufe`} />
          </div>
          <Card className="p-4">
            <div className="font-semibold mb-3">Pro Plattform</div>
            {Object.keys(data.per_platform).length === 0 ? <p className="text-sm text-zinc-500">Noch nichts veröffentlicht.</p> : (
              <div className="space-y-2">
                {Object.entries(data.per_platform).map(([p, d]) => (
                  <div key={p} className="flex justify-between text-sm"><span>{PLATFORM_LABEL[p] || p} · {d.posts} Posts</span><span className="tabular-nums">{n(d.views)} Views · {n(d.likes)} Likes</span></div>
                ))}
              </div>
            )}
          </Card>
          <Ranking title="Top-Clips" rows={data.top} />
          <Ranking title="Flop-Clips" rows={data.flop} />
          <Card className="p-4">
            <div className="font-semibold">Lernschleife</div>
            <p className="text-sm text-zinc-400 mt-1">Diese Beispiele bekommt Claude bei der nächsten Bewertung mit – so passt die Auswahl immer besser zum Humor des Streamers und zum Publikum.</p>
            <pre className="mt-3 whitespace-pre-wrap text-xs text-zinc-300 bg-surface-2 rounded-2xl p-3 max-h-64 overflow-y-auto">{data.feedback_examples || 'Noch keine Freigaben/Ablehnungen.'}</pre>
          </Card>
        </>)}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return <Card className="p-4"><div className="text-xs text-zinc-400">{label}</div><div className="text-2xl font-black mt-1 tabular-nums">{value}</div></Card>
}

function Ranking({ title, rows }: { title: string; rows: TopRow[] }) {
  return (
    <Card className="p-4">
      <div className="font-semibold mb-2">{title}</div>
      {rows.length === 0 ? <Empty title="Noch keine Zahlen" text="Views kommen alle 6 Stunden über die Plattform-APIs." /> : (
        <ol className="space-y-2">
          {rows.map((r, i) => (
            <li key={r.clip_id}>
              <Link to={`/clips/${r.clip_id}`} className="flex items-center gap-3 min-h-12">
                <span className="w-6 text-zinc-500 tabular-nums">{i + 1}.</span>
                <span className="flex-1 min-w-0 truncate">{r.title}</span>
                <span className="tabular-nums text-sm">{n(r.views)}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}
