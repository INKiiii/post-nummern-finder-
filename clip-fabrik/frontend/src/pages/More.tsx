import { Link } from 'react-router-dom'
import { api } from '../api'
import { Card, PageHeader, usePoll } from '../components/ui'
import type { Status } from '../types'

const ITEMS = [
  { to: '/archiv', icon: '🗂', label: 'Archiv & Export', sub: '„Auch gut“, freigegebene Clips, ZIP mit captions.csv' },
  { to: '/streams', icon: '📼', label: 'Streams & Uploads', sub: 'Aufnahmen, Lücken, Kosten, neu analysieren' },
  { to: '/upload', icon: '⬆️', label: 'Upload', sub: 'Kompletten Stream hochladen oder per Link importieren' },
  { to: '/konten', icon: '🔗', label: 'Konten', sub: 'Twitch-Login, TikTok, Instagram, YouTube, Einladungen' },
  { to: '/auswertung', icon: '📈', label: 'Auswertung', sub: 'Views, Top & Flop, Lernschleife' },
  { to: '/jobs', icon: '⚙️', label: 'Aktivität', sub: 'Laufende Analysen, Renderings, Uploads' },
  { to: '/einstellungen', icon: '🛠', label: 'Einstellungen', sub: 'KI, Qualitätsfilter, Push, Speicher' },
]

export default function More({ onLogout }: { onLogout: () => void }) {
  const { data: st } = usePoll(() => api<Status>('/api/status'), 30000)
  return (
    <div>
      <PageHeader title="Mehr" />
      <div className="p-4 space-y-2">
        {ITEMS.map((i) => (
          <Link key={i.to} to={i.to}>
            <Card className="p-4 flex items-center gap-4 min-h-16 mb-2">
              <span className="text-2xl w-8 text-center">{i.icon}</span>
              <span className="flex-1 min-w-0"><span className="block font-semibold">{i.label}</span><span className="block text-xs text-zinc-400 mt-0.5">{i.sub}</span></span>
              <span className="text-zinc-500 text-xl">›</span>
            </Card>
          </Link>
        ))}
        {st && (
          <Card className="p-4 text-sm text-zinc-400 space-y-1">
            <div>KI: <b className="text-zinc-200">{st.ai === 'claude' ? st.model : 'Heuristik (kein API-Key)'}</b></div>
            <div>Transkription: <b className="text-zinc-200">{st.whisper ? 'faster-whisper' : 'nicht verfügbar'}</b></div>
            <div>Speicher: <b className="text-zinc-200">{st.disk.free_gb} GB frei</b></div>
          </Card>
        )}
        <button className="w-full min-h-12 text-red-300 font-semibold" onClick={async () => { await api('/api/auth/logout', { body: {} }); onLogout() }}>Abmelden</button>
      </div>
    </div>
  )
}
