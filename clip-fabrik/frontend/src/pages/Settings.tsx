import { useEffect, useState } from 'react'
import { api } from '../api'
import { Button, Card, Field, inputCls, PageHeader, Progress, Spinner, Toggle, usePoll, useToast } from '../components/ui'
import { enablePush, pushActive, pushSupport } from '../push'

type SecretVal = { set: boolean; masked: string | null }
type Values = Record<string, unknown>

const WEIGHT_LABEL: Record<string, string> = { hook: 'Hook (erste 2 s)', payoff: 'Pointe', clarity: 'Verständlich ohne Vorwissen', emotion: 'Emotion', meme: 'Meme-Potenzial', risk: 'Risiko (umgekehrt)' }

export default function Settings() {
  const toast = useToast()
  const { data, reload } = usePoll(() => api<{ values: Values; push_events: Record<string, string> }>('/api/settings'), 0)
  const { data: disk, reload: reloadDisk } = usePoll(() => api<{ free_gb: number; total_gb: number; free_percent: number; data_gb: number; warn: boolean }>('/api/storage'), 0)
  const [v, setV] = useState<Values | null>(null)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [push, setPush] = useState<boolean | null>(null)
  const [pw, setPw] = useState({ old: '', new: '' })

  useEffect(() => { if (data && !v) setV(JSON.parse(JSON.stringify(data.values))) }, [data, v])
  useEffect(() => { pushActive().then(setPush) }, [])
  if (!v || !data) return <div className="grid place-items-center py-24"><Spinner /></div>

  const set = (k: string, val: unknown) => setV({ ...v, [k]: val })
  const sec = (k: string) => v[k] as SecretVal
  const weights = v.score_weights as Record<string, number>
  const events = v.push_events as Record<string, boolean>

  async function save() {
    const changed: Values = {}
    for (const [k, val] of Object.entries(v!)) {
      if (val && typeof val === 'object' && 'masked' in (val as object)) continue
      if (JSON.stringify(val) !== JSON.stringify(data!.values[k])) changed[k] = val
    }
    for (const [k, val] of Object.entries(secrets)) if (val) changed[k] = val
    try {
      await api('/api/settings', { method: 'PUT', body: changed })
      toast('Einstellungen gespeichert', 'ok')
      setSecrets({})
      setV(null)
      reload()
    } catch (e) { toast((e as Error).message, 'bad') }
  }

  function SecretInput({ k, label, hint }: { k: string; label: string; hint?: string }) {
    const s = sec(k)
    return (
      <Field label={label} hint={hint}>
        <input className={inputCls} type="password" autoComplete="off" placeholder={s?.set ? `gespeichert ${s.masked}` : 'nicht gesetzt'}
          value={secrets[k] || ''} onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })} aria-label={label} />
      </Field>
    )
  }

  return (
    <div className="pb-28">
      <PageHeader title="Einstellungen" />
      <div className="p-4 space-y-5">
        <Section title="KI (Claude)">
          {SecretInput({ k: 'anthropic_api_key', label: 'Anthropic-API-Key', hint: 'Wird verschlüsselt gespeichert und nie angezeigt.' })}
          <Field label="Modell">
            <select className={inputCls} value={v.claude_model as string} onChange={(e) => set('claude_model', e.target.value)}>
              <option value="claude-sonnet-5-5">Claude Sonnet 5.5 (Standard, gutes Preis-Leistungs-Verhältnis)</option>
              <option value="claude-opus-5-5">Claude Opus 5.5 (beste Auswahl, teurer)</option>
              <option value="claude-haiku-5-5">Claude Haiku 5.5 (sehr günstig)</option>
            </select>
          </Field>
          <Field label="Gründlichkeit (Effort)">
            <select className={inputCls} value={v.claude_effort as string} onChange={(e) => set('claude_effort', e.target.value)}>
              <option value="low">niedrig</option><option value="medium">mittel</option><option value="high">hoch</option>
            </select>
          </Field>
          <Toggle label="Bilder an Claude (Vision)" hint="Frames an Lautstärke-Spitzen für visuelle Momente" checked={!!v.claude_vision} onChange={(x) => set('claude_vision', x)} />
          <Toggle label="Server-Fallback bei Ablehnung" hint="Anthropic wiederholt abgelehnte Anfragen automatisch mit einem Ersatzmodell" checked={!!v.claude_fallbacks} onChange={(x) => set('claude_fallbacks', x)} />
          <Field label={`Budget pro Stream: ${(v.budget_per_stream_usd as number).toFixed(2)} $`} hint="Liegt die Schätzung darüber, fragt die App vorher nach.">
            <input type="range" min={0.5} max={20} step={0.5} value={v.budget_per_stream_usd as number} onChange={(e) => set('budget_per_stream_usd', Number(e.target.value))} className="w-full h-10" />
          </Field>
          <Button variant="soft" className="w-full" onClick={async () => {
            try { const r = await api<{ model: string }>('/api/settings/test-claude', { body: {} }); toast(`Key ok (${r.model})`, 'ok') } catch (e) { toast((e as Error).message, 'bad') }
          }}>Key testen (kostenlos)</Button>
        </Section>

        <Section title="Qualitätsfilter">
          <p className="text-sm text-zinc-400 -mt-1">Gewichte für den Gesamt-Score (gewichteter Mittelwert, 1–10).</p>
          {Object.entries(weights).map(([k, w]) => (
            <label key={k} className="block">
              <div className="flex justify-between text-sm"><span>{WEIGHT_LABEL[k] || k}</span><span className="tabular-nums text-zinc-400">{w.toFixed(1)}</span></div>
              <input type="range" min={0} max={3} step={0.1} value={w} className="w-full h-10" aria-label={WEIGHT_LABEL[k]}
                onChange={(e) => set('score_weights', { ...weights, [k]: Number(e.target.value) })} />
            </label>
          ))}
          <Field label={`Push bei Live-Clips ab Score ${(v.push_score_threshold as number).toFixed(1)}`}>
            <input type="range" min={6} max={10} step={0.5} value={v.push_score_threshold as number} onChange={(e) => set('push_score_threshold', Number(e.target.value))} className="w-full h-10" />
          </Field>
          <Field label={`„Jetzt clippen“ schaut ${v.manual_lookback} s zurück`}>
            <input type="range" min={20} max={90} step={5} value={v.manual_lookback as number} onChange={(e) => set('manual_lookback', Number(e.target.value))} className="w-full h-10" />
          </Field>
          <Toggle label="Hook-Untertitel oben einblenden" checked={!!v.hook_overlay} onChange={(x) => set('hook_overlay', x)} />
          <Toggle label="Safety-Check vor jeder Veröffentlichung" checked={!!v.safety_check_before_publish} onChange={(x) => set('safety_check_before_publish', x)} />
        </Section>

        <Section title="Push-Benachrichtigungen">
          <div className="rounded-2xl bg-surface-2 p-3 text-sm">
            {push ? '✓ Auf diesem Handy aktiv.' : pushSupport().ok ? 'Auf diesem Handy noch nicht aktiv.' : pushSupport().reason}
          </div>
          {!push && pushSupport().ok && (
            <Button className="w-full" onClick={async () => { try { toast(await enablePush(), 'ok'); setPush(true) } catch (e) { toast((e as Error).message, 'bad') } }}>Push auf diesem Handy aktivieren</Button>
          )}
          {Object.entries(data.push_events).map(([k, label]) => (
            <Toggle key={k} label={label} checked={events[k] !== false} onChange={(x) => set('push_events', { ...events, [k]: x })} />
          ))}
          <Field label={`Live-Pushes höchstens alle ${v.push_min_interval_minutes} min`} hint="Der Rest kommt gesammelt am Stream-Ende.">
            <input type="range" min={1} max={60} value={v.push_min_interval_minutes as number} onChange={(e) => set('push_min_interval_minutes', Number(e.target.value))} className="w-full h-10" />
          </Field>
          <details className="rounded-2xl bg-surface-2 p-3">
            <summary className="font-semibold text-sm min-h-8">Fallback: Telegram oder ntfy</summary>
            <div className="space-y-3 mt-3">
              {SecretInput({ k: 'telegram_bot_token', label: 'Telegram-Bot-Token' })}
              <Field label="Telegram-Chat-ID"><input className={inputCls} value={(v.telegram_chat_id as string) || ''} onChange={(e) => set('telegram_chat_id', e.target.value)} /></Field>
              <Field label="ntfy-Adresse" hint="z. B. https://ntfy.sh/mein-geheimes-thema"><input className={inputCls} value={(v.ntfy_url as string) || ''} onChange={(e) => set('ntfy_url', e.target.value)} /></Field>
            </div>
          </details>
          <Button variant="soft" className="w-full" onClick={async () => { await api('/api/push/test', { body: {} }); toast('Test-Push gesendet') }}>Test-Push senden</Button>
        </Section>

        <Section title="Twitch-App">
          <Field label="Client-ID"><input className={inputCls} value={(v.twitch_client_id as string) || ''} onChange={(e) => set('twitch_client_id', e.target.value)} autoCapitalize="none" /></Field>
          {SecretInput({ k: 'twitch_client_secret', label: 'Client-Secret', hint: 'dev.twitch.tv → Anwendungen. Redirect-URL: <Server>/api/twitch/callback' })}
        </Section>

        <Section title="Veröffentlichung">
          <Field label="Sendefenster" hint="z. B. 11:00-13:30, 17:00-21:30">
            <input className={inputCls} value={(v.publish_windows as string[][]).map((w) => w.join('-')).join(', ')}
              onChange={(e) => set('publish_windows', e.target.value.split(',').map((x) => x.trim().split('-').map((t) => t.trim())).filter((w) => w.length === 2 && w[0] && w[1]))} />
          </Field>
          <Field label="YouTube-Kontingent pro Tag (Einheiten)" hint="Standard 10.000. Nach genehmigter Erweiterung hier erhöhen.">
            <input className={inputCls} type="number" inputMode="numeric" value={v.youtube_daily_units as number} onChange={(e) => set('youtube_daily_units', Number(e.target.value))} />
          </Field>
          <Field label="Einheiten pro YouTube-Upload">
            <input className={inputCls} type="number" inputMode="numeric" value={v.youtube_upload_cost as number} onChange={(e) => set('youtube_upload_cost', Number(e.target.value))} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="TikTok max/Tag"><input className={inputCls} type="number" value={v.tiktok_daily_limit as number} onChange={(e) => set('tiktok_daily_limit', Number(e.target.value))} /></Field>
            <Field label="Instagram max/Tag"><input className={inputCls} type="number" value={v.instagram_daily_limit as number} onChange={(e) => set('instagram_daily_limit', Number(e.target.value))} /></Field>
          </div>
        </Section>

        <Section title="Speicher">
          {disk && (<>
            <div className="flex justify-between text-sm"><span>{disk.free_gb} GB frei von {disk.total_gb} GB</span><span className="text-zinc-400">Daten: {disk.data_gb} GB</span></div>
            <Progress value={1 - disk.free_percent / 100} />
            {disk.warn && <p className="text-sm text-amber-300">Speicher wird knapp.</p>}
          </>)}
          <Field label={`Rohaufnahmen löschen nach ${v.raw_retention_days} Tagen`} hint="Fertige Clips bleiben erhalten.">
            <input type="range" min={1} max={30} value={v.raw_retention_days as number} onChange={(e) => set('raw_retention_days', Number(e.target.value))} className="w-full h-10" />
          </Field>
          <Button variant="soft" className="w-full" onClick={async () => { await api('/api/storage/cleanup', { body: {} }); toast('Aufräumen gestartet'); setTimeout(reloadDisk, 4000) }}>Jetzt aufräumen</Button>
        </Section>

        <Section title="Passwort ändern">
          <input className={inputCls} type="password" placeholder="Altes Passwort" value={pw.old} onChange={(e) => setPw({ ...pw, old: e.target.value })} autoComplete="current-password" />
          <input className={inputCls} type="password" placeholder="Neues Passwort (mind. 10 Zeichen)" value={pw.new} onChange={(e) => setPw({ ...pw, new: e.target.value })} autoComplete="new-password" />
          <Button variant="soft" className="w-full" disabled={!pw.old || pw.new.length < 10} onClick={async () => {
            try { await api('/api/auth/password', { body: pw }); toast('Passwort geändert – andere Geräte sind abgemeldet', 'ok'); setPw({ old: '', new: '' }) } catch (e) { toast((e as Error).message, 'bad') }
          }}>Passwort ändern</Button>
        </Section>
      </div>
      <div className="fixed bottom-16 left-0 right-0 z-20 px-4 pb-3">
        <div className="max-w-2xl mx-auto"><Button size="lg" className="w-full shadow-xl" onClick={save}>Speichern</Button></div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-4 space-y-4">
      <h2 className="font-bold text-lg">{title}</h2>
      {children}
    </Card>
  )
}
