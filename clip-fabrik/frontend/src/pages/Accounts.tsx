import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, PLATFORM_LABEL } from '../api'
import { Badge, Button, Card, Field, inputCls, PageHeader, Progress, Sheet, Toggle, usePoll, useToast } from '../components/ui'
import type { Account, Status } from '../types'

type AccData = { accounts: Account[]; platforms: { platform: string; label: string; configured: boolean; hint: string }[] }

export default function Accounts() {
  const { data, reload } = usePoll(() => api<AccData>('/api/accounts'), 0)
  const { data: status, reload: reloadStatus } = usePoll(() => api<Status>('/api/status'), 0)
  const [params, setParams] = useSearchParams()
  const toast = useToast()
  const [edit, setEdit] = useState<Account | null>(null)
  const [invite, setInvite] = useState<string | null>(null)

  useEffect(() => {
    const ok = params.get('verbunden')
    const err = params.get('fehler')
    const tw = params.get('twitch')
    if (ok) toast(`${PLATFORM_LABEL[ok] || ok} verbunden`, 'ok')
    if (tw) toast(params.get('fehlt') ? `Twitch verbunden, es fehlt: ${params.get('fehlt')}` : 'Twitch-Mod-Login verbunden', 'ok')
    if (err) toast(err, 'bad')
    if (ok || err || tw) setParams({}, { replace: true })
  }, [params, setParams, toast])

  async function connect(platform: string) {
    try {
      const r = await api<{ url: string }>(`/api/accounts/connect/${platform}`, { body: {} })
      window.location.href = r.url
    } catch (e) { toast((e as Error).message, 'bad') }
  }

  async function twitchLogin() {
    try { window.location.href = (await api<{ url: string }>('/api/twitch/login')).url } catch (e) { toast((e as Error).message, 'bad') }
  }

  async function createInvite(platform: string) {
    try {
      const r = await api<{ url: string }>('/api/invites', { body: { platform } })
      setInvite(r.url)
      if (navigator.share) await navigator.share({ title: 'Konto verbinden', text: `Bitte verbinde dein ${PLATFORM_LABEL[platform] || platform}-Konto mit der Clip-Fabrik:`, url: r.url }).catch(() => {})
    } catch (e) { toast((e as Error).message, 'bad') }
  }

  return (
    <div>
      <PageHeader title="Konten" />
      <div className="p-4 space-y-5">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-semibold">Twitch (dein Mod-Konto)</div>
              <div className="text-sm text-zinc-400 mt-0.5">{status?.twitch_mod ? `Verbunden als ${status.twitch_mod.login}` : 'Für Chat-Signale und Twitch-Clips als Marker'}</div>
            </div>
            {status?.twitch_mod ? <Badge tone="ok">verbunden</Badge> : <Badge tone="warn">fehlt</Badge>}
          </div>
          <p className="text-xs text-zinc-500 mt-2">Rechte: nur Chat lesen (chat:read) und Clips erstellen (clips:edit). Keine Broadcaster-Rechte nötig.</p>
          <div className={`grid gap-2 mt-3 ${status?.twitch_mod ? 'grid-cols-2' : 'grid-cols-1'}`}>
            <Button variant={status?.twitch_mod ? 'soft' : 'primary'} onClick={twitchLogin} disabled={!status?.twitch_app}>{status?.twitch_mod ? 'Neu verbinden' : 'Mit Twitch einloggen'}</Button>
            {status?.twitch_mod && <Button variant="ghost" onClick={async () => { await api('/api/twitch/login', { method: 'DELETE' }); reloadStatus() }}>Trennen</Button>}
          </div>
          {!status?.twitch_app && <p className="text-xs text-amber-300 mt-2">Erst Twitch-App (Client-ID/Secret) in den Einstellungen eintragen.</p>}
        </Card>

        <div>
          <div className="text-sm font-semibold text-zinc-400 mb-2 px-1">Veröffentlichung</div>
          <div className="space-y-3">
            {data?.accounts.filter((a) => a.status !== 'disconnected').map((a) => (
              <Card key={a.id} className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{PLATFORM_LABEL[a.platform] || a.platform} · {a.name}</div>
                    <div className="text-xs text-zinc-400 mt-0.5">{a.owner === 'streamer' ? 'Konto des Streamers' : 'mein Konto'} · {a.post_mode === 'draft' ? 'als Entwurf' : 'direkt'} · max. {a.daily_limit}/Tag</div>
                  </div>
                  <Badge tone={a.status === 'connected' ? (a.enabled ? 'ok' : 'zinc') : 'bad'}>{a.status === 'connected' ? (a.enabled ? 'aktiv' : 'pausiert') : 'abgelaufen'}</Badge>
                </div>
                {a.quota && (
                  <div className="mt-3">
                    <div className="flex justify-between text-sm"><span className="text-zinc-400">Heute</span><span className="tabular-nums">{a.quota.left} von {a.quota.cap} frei</span></div>
                    <Progress value={a.quota.cap ? a.quota.used / a.quota.cap : 1} className="mt-1" />
                    {a.quota.note && <div className="text-xs text-zinc-500 mt-1">{a.quota.note}</div>}
                  </div>
                )}
                {a.last_error && <p className="text-sm text-red-300 mt-2">{a.last_error}</p>}
                <div className="grid grid-cols-2 gap-2 mt-3">
                  <Button size="sm" variant="soft" onClick={() => setEdit(a)}>Einstellungen</Button>
                  {a.status !== 'connected' && <Button size="sm" onClick={() => connect(a.platform)}>Neu verbinden</Button>}
                </div>
              </Card>
            ))}
          </div>
        </div>

        <div>
          <div className="text-sm font-semibold text-zinc-400 mb-2 px-1">Konto hinzufügen</div>
          <div className="space-y-3">
            {data?.platforms.map((p) => (
              <Card key={p.platform} className="p-4">
                <div className="font-semibold">{p.label}</div>
                <p className="text-xs text-zinc-500 mt-1">{p.hint}</p>
                <div className="grid grid-cols-2 gap-2 mt-3">
                  <Button size="sm" onClick={() => connect(p.platform)} disabled={!p.configured}>Mein Konto</Button>
                  <Button size="sm" variant="soft" onClick={() => createInvite(p.platform)} disabled={!p.configured}>Streamer einladen</Button>
                </div>
                {!p.configured && <p className="text-xs text-amber-300 mt-2">App-Zugangsdaten fehlen (README → API-Freigaben). Bis dahin: Export-Paket nutzen.</p>}
              </Card>
            ))}
          </div>
          {invite && (
            <Card className="p-4 mt-3">
              <div className="text-sm font-semibold mb-2">Einladungslink (7 Tage gültig)</div>
              <input readOnly className={`${inputCls} text-sm`} value={invite} onFocus={(e) => e.target.select()} aria-label="Einladungslink" />
              <p className="text-xs text-zinc-500 mt-2">Der Streamer öffnet den Link am Handy und bestätigt selbst bei der Plattform. Du siehst dabei kein Passwort.</p>
            </Card>
          )}
        </div>
      </div>
      {edit && <AccountSheet a={edit} onClose={() => { setEdit(null); reload() }} />}
    </div>
  )
}

function AccountSheet({ a, onClose }: { a: Account; onClose: () => void }) {
  const toast = useToast()
  const [f, setF] = useState({ ...a, windowsText: (a.windows || []).map((w) => w.join('-')).join(', ') })

  async function save() {
    const windows = f.windowsText.trim()
      ? f.windowsText.split(',').map((x) => x.trim().split('-').map((t) => t.trim())).filter((w) => w.length === 2 && w.every((t) => /^\d{1,2}:\d{2}$/.test(t)))
      : null
    try {
      await api(`/api/accounts/${a.id}`, { method: 'PATCH', body: {
        daily_limit: f.daily_limit, api_approved: f.api_approved, post_mode: f.post_mode, min_gap_minutes: f.min_gap_minutes,
        jitter_minutes: f.jitter_minutes, enabled: f.enabled, windows, privacy: f.privacy,
      } })
      toast('Gespeichert – Zeitplan neu verteilt', 'ok')
      onClose()
    } catch (e) { toast((e as Error).message, 'bad') }
  }

  async function remove() {
    if (!confirm('Konto trennen? Geplante Veröffentlichungen werden abgebrochen.')) return
    await api(`/api/accounts/${a.id}`, { method: 'DELETE' })
    onClose()
  }

  return (
    <Sheet open onClose={onClose} title={`${PLATFORM_LABEL[a.platform] || a.platform} · ${a.name}`}>
      <div className="space-y-4">
        <Toggle label="Aktiv" checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} />
        <Field label={`Tageslimit: ${f.daily_limit} Uploads`} hint="Eigenes Limit, zusätzlich zu den Plattform-Limits.">
          <input type="range" min={0} max={30} value={f.daily_limit} onChange={(e) => setF({ ...f, daily_limit: Number(e.target.value) })} className="w-full h-10" />
        </Field>
        <Field label="Sendefenster (leer = Standard aus Einstellungen)" hint="z. B. 11:00-13:30, 17:00-21:30">
          <input className={inputCls} value={f.windowsText} onChange={(e) => setF({ ...f, windowsText: e.target.value })} />
        </Field>
        <Field label={`Mindestabstand: ${f.min_gap_minutes} min`}>
          <input type="range" min={15} max={360} step={15} value={f.min_gap_minutes} onChange={(e) => setF({ ...f, min_gap_minutes: Number(e.target.value) })} className="w-full h-10" />
        </Field>
        <Field label={`Zufälliger Versatz: bis ${f.jitter_minutes} min`}>
          <input type="range" min={0} max={60} step={1} value={f.jitter_minutes} onChange={(e) => setF({ ...f, jitter_minutes: Number(e.target.value) })} className="w-full h-10" />
        </Field>
        {a.platform === 'tiktok' && (
          <Field label="Veröffentlichungsart">
            <div className="grid grid-cols-2 gap-2">
              {[['direct', 'Direkt posten'], ['draft', 'Entwurf in Inbox']].map(([v, l]) => (
                <button key={v} onClick={() => setF({ ...f, post_mode: v })} className={`min-h-12 rounded-2xl border text-sm font-semibold ${f.post_mode === v ? 'border-accent bg-accent/15' : 'border-line bg-surface-2'}`}>{l}</button>
              ))}
            </div>
          </Field>
        )}
        {a.platform === 'youtube' && (
          <Field label="Sichtbarkeit">
            <select className={inputCls} value={f.privacy || 'public'} onChange={(e) => setF({ ...f, privacy: e.target.value })}>
              <option value="public">öffentlich</option><option value="unlisted">nicht gelistet</option><option value="private">privat</option>
            </select>
          </Field>
        )}
        <Toggle label="App-Freigabe/Audit erteilt" hint="Erst einschalten, wenn TikTok-Audit bzw. Meta-App-Prüfung durch ist" checked={f.api_approved} onChange={(v) => setF({ ...f, api_approved: v })} />
        <Button size="lg" className="w-full" onClick={save}>Speichern</Button>
        <Button variant="danger" className="w-full" onClick={remove}>Konto trennen</Button>
      </div>
    </Sheet>
  )
}
