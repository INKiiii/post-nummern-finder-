import { api, fmtTime } from '../api'
import { Badge, Button, Card, Empty, PageHeader, Progress, usePoll, useToast } from '../components/ui'
import type { Job } from '../types'

const TYPE: Record<string, string> = {
  process_stream: 'Stream analysieren', live_candidate: 'Live-Moment prüfen', live_scan_segment: 'Live-Audio prüfen', render_clip: 'Clip rendern',
  captions: 'Texte schreiben', safety_check: 'Safety-Check', publish: 'Veröffentlichen', collect_metrics: 'Zahlen holen',
  cleanup_storage: 'Aufräumen', export_package: 'Export-Paket', import_url: 'URL-Import', vod_backup: 'VOD-Backup',
}
const STATUS: Record<string, 'zinc' | 'accent' | 'ok' | 'bad' | 'warn'> = { queued: 'zinc', running: 'accent', done: 'ok', failed: 'bad', cancelled: 'warn' }

export default function Jobs() {
  const toast = useToast()
  const { data, reload } = usePoll(() => api<Job[]>('/api/jobs?limit=80'), 4000)
  async function act(j: Job, a: 'cancel' | 'retry') {
    try { await api(`/api/jobs/${j.id}/${a}`, { body: {} }); reload() } catch (e) { toast((e as Error).message, 'bad') }
  }
  return (
    <div>
      <PageHeader title="Aktivität" />
      <div className="p-4 space-y-2">
        {data?.length === 0 && <Empty title="Keine Jobs" />}
        {data?.filter((j) => j.type !== 'live_scan_segment' || j.status !== 'done').map((j) => (
          <Card key={j.id} className="p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold text-[15px]">{TYPE[j.type] || j.type}{j.stream_id ? ` · Stream ${j.stream_id}` : ''}</div>
              <Badge tone={STATUS[j.status] || 'zinc'}>{j.status === 'queued' ? 'wartet' : j.status === 'running' ? 'läuft' : j.status === 'done' ? 'fertig' : j.status === 'failed' ? 'Fehler' : 'abgebrochen'}</Badge>
            </div>
            {j.status === 'running' && <Progress value={j.progress} className="mt-2" />}
            <div className="text-sm text-zinc-400 mt-1.5">{j.progress_msg}</div>
            {j.error && j.status === 'failed' && <div className="text-sm text-red-300 mt-1 break-words">{j.error.slice(0, 300)}</div>}
            <div className="flex items-center justify-between mt-2">
              <span className="text-xs text-zinc-500">{fmtTime(j.created_at)}{j.attempts > 1 ? ` · Versuch ${j.attempts}/${j.max_attempts}` : ''}</span>
              <span className="flex gap-2">
                {['queued', 'running'].includes(j.status) && <Button size="sm" variant="ghost" onClick={() => act(j, 'cancel')}>Abbrechen</Button>}
                {['failed', 'cancelled'].includes(j.status) && <Button size="sm" variant="soft" onClick={() => act(j, 'retry')}>Erneut</Button>}
              </span>
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
