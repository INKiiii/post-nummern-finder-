import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, fmtDuration } from '../api'
import { Badge, Button, Card, Empty, Field, inputCls, PageHeader, Sheet, Spinner, Toggle, usePoll, useToast } from '../components/ui'
import type { Channel, Status } from '../types'

const STATUS: Record<string, { label: string; tone: 'zinc' | 'live' | 'accent' | 'warn' }> = {
  offline: { label: 'offline', tone: 'zinc' },
  live: { label: 'live', tone: 'live' },
  recording: { label: '● nimmt auf', tone: 'live' },
  analyzing: { label: 'analysiert', tone: 'accent' },
}

export default function Channels() {
  const { data: channels, loading, reload } = usePoll(() => api<Channel[]>('/api/channels'), 5000)
  const { data: status } = usePoll(() => api<Status>('/api/status'), 30000)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Channel | null>(null)

  return (
    <div>
      <PageHeader title="Kanäle" right={<Button size="sm" onClick={() => setAdding(true)} aria-label="Kanal hinzufügen">+ Kanal</Button>} />
      <div className="p-4 space-y-4">
        {status && status.warnings.length > 0 && (
          <Card className="p-4 border-warn/40">
            <div className="font-semibold text-amber-300 mb-2">Noch einzurichten</div>
            <ul className="space-y-1.5 text-sm text-zinc-300">
              {status.warnings.map((w) => <li key={w}>• {w}</li>)}
            </ul>
            <div className="flex gap-2 mt-3">
              <Link to="/einstellungen" className="text-violet-300 text-sm font-semibold underline underline-offset-4">Einstellungen</Link>
              <Link to="/konten" className="text-violet-300 text-sm font-semibold underline underline-offset-4">Konten</Link>
            </div>
          </Card>
        )}
        {loading && !channels && <div className="grid place-items-center py-10"><Spinner /></div>}
        {channels && channels.length === 0 && (
          <Empty title="Noch kein Kanal" text="Füge den Twitch-Namen des Streamers hinzu. Die App erkennt automatisch, wenn er live geht."
            action={<Button size="lg" onClick={() => setAdding(true)}>Kanal hinzufügen</Button>} />
        )}
        {channels?.map((ch) => <ChannelCard key={ch.id} ch={ch} onChanged={reload} onEdit={() => setEditing(ch)} />)}
      </div>
      <AddChannelSheet open={adding} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); reload() }} />
      {editing && <ChannelSettingsSheet ch={editing} onClose={() => { setEditing(null); reload() }} />}
    </div>
  )
}

function ChannelCard({ ch, onChanged, onEdit }: { ch: Channel; onChanged: () => void; onEdit: () => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const st = STATUS[ch.status] || STATUS.offline
  const recording = ch.status === 'recording'

  async function patch(body: Partial<Channel>) {
    try {
      await api(`/api/channels/${ch.id}`, { method: 'PATCH', body })
      onChanged()
    } catch (e) { toast((e as Error).message, 'bad') }
  }

  async function clipNow() {
    setBusy(true)
    try {
      await api(`/api/channels/${ch.id}/clip-now`, { body: {} })
      if (navigator.vibrate) navigator.vibrate(40)
      toast('Moment markiert – Clip kommt gleich in die Review', 'ok')
    } catch (e) { toast((e as Error).message, 'bad') } finally { setBusy(false) }
  }

  const cs = ch.current_stream
  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        {ch.profile_image_url ? <img src={ch.profile_image_url} alt="" className="h-12 w-12 rounded-full bg-zinc-800" /> :
          <div className="h-12 w-12 rounded-full bg-accent/30 grid place-items-center font-bold text-lg">{ch.display_name[0]?.toUpperCase()}</div>}
        <div className="min-w-0 flex-1">
          <div className="font-bold text-lg truncate">{ch.display_name}</div>
          <div className="flex flex-wrap gap-1.5 mt-1">
            <Badge tone={st.tone}>{st.label}</Badge>
            {ch.streamer_authorized && <Badge tone="ok">Streamer bestätigt</Badge>}
            {ch.pending_review > 0 && <Badge tone="accent">{ch.pending_review} zu prüfen</Badge>}
          </div>
        </div>
        <button onClick={onEdit} className="h-12 w-12 rounded-2xl bg-surface-2 grid place-items-center text-xl" aria-label={`Einstellungen ${ch.display_name}`}>⚙︎</button>
      </div>

      {cs && (recording || ch.status === 'analyzing') && (
        <div className="mt-4 rounded-2xl bg-surface-2 p-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-300 truncate">{cs.title || 'Stream'}</span>
            <span className="tabular-nums text-zinc-400">{fmtDuration(cs.duration)}</span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-3xl font-black tabular-nums" aria-label="bisher gefundene Clips">{ch.live_clips}</span>
            <span className="text-zinc-400 text-sm">Clips bisher gefunden</span>
          </div>
          {cs.gaps.length > 0 && <div className="text-xs text-amber-300 mt-1">{cs.gaps.length} Lücke(n) in der Aufnahme</div>}
        </div>
      )}
      {ch.last_error && <div className="mt-3 text-sm text-red-300">{ch.last_error}</div>}

      {recording && (
        <Button size="lg" className="w-full mt-4 !bg-red-600 text-xl" onClick={clipNow} disabled={busy} aria-label="Jetzt clippen">
          ✂︎ Jetzt clippen
        </Button>
      )}

      <div className="mt-3 divide-y divide-line/60">
        <Toggle label="Live-Clipping" hint="Clips schon während des Streams (Clip-Farmer)" checked={ch.live_enabled} onChange={(v) => patch({ live_enabled: v })} />
        <Toggle label="Nachbearbeitung" hint="Kompletter Durchlauf nach Stream-Ende" checked={ch.post_enabled} onChange={(v) => patch({ post_enabled: v })} />
      </div>
      {cs && cs.status === 'done' && (
        <Link to={`/review?stream=${cs.id}`} className="mt-3 block text-center text-violet-300 font-semibold py-2">Letzten Stream ansehen →</Link>
      )}
    </Card>
  )
}

function AddChannelSheet({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const toast = useToast()
  const [login, setLogin] = useState('')
  const [consent, setConsent] = useState(false)
  const [live, setLive] = useState(true)
  const [post, setPost] = useState(true)
  const [busy, setBusy] = useState(false)

  async function add() {
    setBusy(true)
    try {
      await api('/api/channels', { body: { login, consent, live_enabled: live, post_enabled: post } })
      toast('Kanal hinzugefügt', 'ok')
      setLogin(''); setConsent(false)
      onAdded()
    } catch (e) { toast((e as Error).message, 'bad') } finally { setBusy(false) }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Kanal hinzufügen">
      <div className="space-y-4">
        <Field label="Twitch-Name oder Link">
          <input className={inputCls} placeholder="z. B. meinkollege" value={login} onChange={(e) => setLogin(e.target.value)}
            autoCapitalize="none" autoCorrect="off" aria-label="Twitch-Name" />
        </Field>
        <div className="divide-y divide-line/60">
          <Toggle label="Live-Clipping" checked={live} onChange={setLive} />
          <Toggle label="Nachbearbeitung nach Stream-Ende" checked={post} onChange={setPost} />
        </div>
        <label className="flex gap-3 items-start rounded-2xl bg-surface-2 p-4">
          <input type="checkbox" className="mt-1 h-6 w-6 accent-violet-500 shrink-0" checked={consent} onChange={(e) => setConsent(e.target.checked)} aria-label="Zustimmung" />
          <span className="text-sm leading-relaxed">
            <b>Der Streamer hat der Nutzung seiner Streams zugestimmt.</b><br />
            <span className="text-zinc-400">Ohne Zustimmung nimmt die App nichts auf. Optional kann der Streamer danach per Einladungslink mit seinem Twitch-Login offiziell bestätigen.</span>
          </span>
        </label>
        <Button size="lg" className="w-full" onClick={add} disabled={busy || !login.trim() || !consent}>Hinzufügen</Button>
      </div>
    </Sheet>
  )
}

function ChannelSettingsSheet({ ch, onClose }: { ch: Channel; onClose: () => void }) {
  const toast = useToast()
  const [f, setF] = useState({ ...ch, facecam_rect: ch.facecam_rect || { x: 0.68, y: 0.62, w: 0.3, h: 0.36 } })
  const [invite, setInvite] = useState<string | null>(null)

  async function save() {
    try {
      await api(`/api/channels/${ch.id}`, { method: 'PATCH', body: {
        clips_per_stream: f.clips_per_stream, min_score: f.min_score, language: f.language, brand_voice: f.brand_voice,
        create_twitch_clips: f.create_twitch_clips, chat_clip_command: f.chat_clip_command, vod_backup: f.vod_backup,
        layout: f.layout, facecam_rect: f.layout === 'facecam_top' ? f.facecam_rect : null,
      } })
      toast('Gespeichert', 'ok')
      onClose()
    } catch (e) { toast((e as Error).message, 'bad') }
  }

  async function makeInvite() {
    try {
      const r = await api<{ url: string }>(`/api/channels/${ch.id}/invite`, { body: {} })
      setInvite(r.url)
      if (navigator.share) await navigator.share({ title: 'Clip-Fabrik', text: 'Bitte bestätige kurz mit deinem Twitch-Login:', url: r.url }).catch(() => {})
    } catch (e) { toast((e as Error).message, 'bad') }
  }

  async function remove() {
    if (!confirm(`Kanal ${ch.display_name} entfernen? Bisherige Clips bleiben erhalten.`)) return
    try { await api(`/api/channels/${ch.id}`, { method: 'DELETE' }); onClose() } catch (e) { toast((e as Error).message, 'bad') }
  }

  const rect = f.facecam_rect
  return (
    <Sheet open onClose={onClose} title={ch.display_name}>
      <div className="space-y-5">
        <Field label={`Clips pro Stream: ${f.clips_per_stream}`} hint="Nur die besten N landen in der Review, der Rest im Archiv „Auch gut“.">
          <input type="range" min={3} max={40} value={f.clips_per_stream} onChange={(e) => setF({ ...f, clips_per_stream: Number(e.target.value) })} className="w-full h-10" aria-label="Clips pro Stream" />
        </Field>
        <Field label={`Mindest-Score: ${f.min_score.toFixed(1)}`} hint="Alles darunter wird aussortiert.">
          <input type="range" min={4} max={9.5} step={0.5} value={f.min_score} onChange={(e) => setF({ ...f, min_score: Number(e.target.value) })} className="w-full h-10" aria-label="Mindest-Score" />
        </Field>
        <Field label="Sprache">
          <select className={inputCls} value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}>
            <option value="de">Deutsch</option><option value="en">Englisch</option><option value="">automatisch</option>
          </select>
        </Field>
        <Field label="Brand-Voice" hint="Tonalität für Titel, Beschreibungen und Hashtags.">
          <textarea className={`${inputCls} min-h-24`} value={f.brand_voice} placeholder="z. B. frech, selbstironisch, nie gemein, Jugendsprache sparsam"
            onChange={(e) => setF({ ...f, brand_voice: e.target.value })} />
        </Field>
        <div className="divide-y divide-line/60">
          <Toggle label="Twitch-Clips als Marker" hint="Bei starken Momenten automatisch einen Twitch-Clip erzeugen (Mod-Login nötig)" checked={f.create_twitch_clips} onChange={(v) => setF({ ...f, create_twitch_clips: v })} />
          <Toggle label="!clip im Chat" hint="Mods können mit !clip einen Moment markieren" checked={f.chat_clip_command} onChange={(v) => setF({ ...f, chat_clip_command: v })} />
          <Toggle label="VOD-Backup" hint="Twitch-VOD nach Stream-Ende zusätzlich laden" checked={f.vod_backup} onChange={(v) => setF({ ...f, vod_backup: v })} />
        </div>
        <Field label="Layout">
          <div className="grid grid-cols-2 gap-2">
            {[['blur', 'Unscharfer Hintergrund'], ['facecam_top', 'Facecam oben']].map(([v, l]) => (
              <button key={v} onClick={() => setF({ ...f, layout: v })} className={`min-h-12 rounded-2xl border px-3 text-sm font-semibold ${f.layout === v ? 'border-accent bg-accent/15' : 'border-line bg-surface-2'}`}>{l}</button>
            ))}
          </div>
        </Field>
        {f.layout === 'facecam_top' && (
          <div className="space-y-2">
            <div className="relative w-full aspect-video rounded-xl bg-zinc-800 overflow-hidden">
              <div className="absolute border-2 border-hl bg-hl/20" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} />
              <span className="absolute left-2 top-2 text-xs text-zinc-400">Stream (16:9) – gelb = Facecam</span>
            </div>
            {(['x', 'y', 'w', 'h'] as const).map((k) => (
              <label key={k} className="flex items-center gap-3 text-sm">
                <span className="w-16 text-zinc-400">{{ x: 'Links', y: 'Oben', w: 'Breite', h: 'Höhe' }[k]}</span>
                <input type="range" min={0} max={1} step={0.01} value={rect[k]} className="flex-1 h-10"
                  onChange={(e) => setF({ ...f, facecam_rect: { ...rect, [k]: Number(e.target.value) } })} />
              </label>
            ))}
          </div>
        )}
        <Card className="p-4">
          <div className="font-semibold">Zustimmung des Streamers</div>
          <p className="text-sm text-zinc-400 mt-1">{ch.streamer_authorized ? '✓ Per Twitch-Login bestätigt.' : 'Optional: Der Streamer bestätigt per Link mit seinem eigenen Twitch-Login.'}</p>
          {!ch.streamer_authorized && <Button variant="soft" className="w-full mt-3" onClick={makeInvite}>Einladungslink teilen</Button>}
          {invite && <input readOnly className={`${inputCls} mt-3 text-sm`} value={invite} onFocus={(e) => e.target.select()} aria-label="Einladungslink" />}
        </Card>
        <Button size="lg" className="w-full" onClick={save}>Speichern</Button>
        <Button variant="danger" className="w-full" onClick={remove}>Kanal entfernen</Button>
      </div>
    </Sheet>
  )
}
