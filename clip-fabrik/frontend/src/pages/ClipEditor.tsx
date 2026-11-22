import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, fmtDuration, fmtTime, PLATFORM_LABEL } from '../api'
import { Badge, Button, Card, Field, inputCls, RangeSlider, ScoreBadge, Spinner, usePoll, useToast } from '../components/ui'
import type { Account, Captions, Clip, Publication } from '../types'

type Tab = 'tiktok' | 'instagram' | 'youtube'

export default function ClipEditor() {
  const { id } = useParams()
  const nav = useNavigate()
  const toast = useToast()
  const { data: clip, reload, setData } = usePoll(() => api<Clip>(`/api/clips/${id}`), 0, [id])
  const { data: acc } = usePoll(() => api<{ accounts: Account[] }>('/api/accounts'), 0)
  const [form, setForm] = useState<Partial<Clip> | null>(null)
  const [tab, setTab] = useState<Tab>('tiktok')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (clip && !form) setForm({ ...clip, captions: JSON.parse(JSON.stringify(clip.captions || {})) })
  }, [clip, form])

  // Render-Status beobachten
  useEffect(() => {
    if (!clip || !['queued', 'rendering'].includes(clip.render_status)) return
    const t = setInterval(async () => {
      const c = await api<Clip>(`/api/clips/${id}`)
      setData(c)
      if (!['queued', 'rendering'].includes(c.render_status)) clearInterval(t)
    }, 2500)
    return () => clearInterval(t)
  }, [clip?.render_status, id, setData, clip])

  if (!clip || !form) return <div className="h-full grid place-items-center py-24"><Spinner /></div>

  const total = clip.stream_duration || clip.end + 60
  const lo = Math.max(0, Math.floor(clip.start - 30))
  const hi = Math.min(total, Math.ceil(clip.end + 30))
  const dirty = JSON.stringify({ ...form, words: undefined }) !== JSON.stringify({ ...clip, words: undefined })
  const accounts = (acc?.accounts || []).filter((a) => a.enabled)
  const caps = (form.captions || {}) as Captions

  async function save(silent = false): Promise<Clip | null> {
    setBusy(true)
    try {
      const body: Record<string, unknown> = {
        title: form!.title, hook_text: form!.hook_text, context_line: form!.context_line, captions: form!.captions, platforms: form!.platforms,
      }
      if (JSON.stringify(form!.subtitle_lines) !== JSON.stringify(clip!.subtitle_lines)) body.subtitle_lines = form!.subtitle_lines
      if (form!.start !== clip!.start || form!.end !== clip!.end) { body.start = form!.start; body.end = form!.end }
      const c = await api<Clip>(`/api/clips/${clip!.id}`, { method: 'PATCH', body })
      setData(c)
      setForm({ ...c, captions: JSON.parse(JSON.stringify(c.captions || {})) })
      if (!silent) toast('Gespeichert', 'ok')
      return c
    } catch (e) { toast((e as Error).message, 'bad'); return null } finally { setBusy(false) }
  }

  async function rerender() {
    const c = dirty ? await save(true) : clip
    if (!c) return
    await api(`/api/clips/${c.id}/rerender`, { body: { preview: true } })
    setData({ ...c, render_status: 'queued' })
    toast('Wird neu gerendert …')
  }

  async function review(action: 'approve' | 'reject') {
    if (dirty) await save(true)
    let override = false
    if (action === 'approve' && clip!.safety_flagged && !clip!.safety_override) {
      if (!confirm(`Safety-Hinweis: ${clip!.safety_labels.join(', ')}.\nTrotzdem ausdrücklich freigeben?`)) return
      override = true
    }
    try {
      await api(`/api/clips/${clip!.id}/review`, { body: { action, account_ids: form!.platforms?.length ? form!.platforms : undefined, safety_override: override } })
      toast(action === 'approve' ? 'Freigegeben' : 'Abgelehnt', action === 'approve' ? 'ok' : 'info')
      nav(-1)
    } catch (e) { toast((e as Error).message, 'bad') }
  }

  async function share() {
    const url = clip!.final_url || clip!.preview_url
    if (!url) return
    try {
      const blob = await (await fetch(url)).blob()
      const file = new File([blob], `${clip!.slug || 'clip'}.mp4`, { type: 'video/mp4' })
      const text = caps.tiktok ? `${caps.tiktok.description} ${caps.tiktok.hashtags.join(' ')}` : clip!.title
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: clip!.title, text })
      } else {
        await navigator.clipboard?.writeText(text).catch(() => {})
        window.location.href = `${url.split('?')[0]}?download=1`
      }
    } catch (e) { if ((e as Error).name !== 'AbortError') toast((e as Error).message, 'bad') }
  }

  function setCap(platform: Tab, key: string, value: string | string[]) {
    setForm({ ...form!, captions: { ...caps, [platform]: { ...(caps[platform] || {}), [key]: value } } as Captions })
  }

  const pubs = (clip.publications || []) as Publication[]
  return (
    <div className="pb-40">
      <header className="safe-top sticky top-0 z-20 bg-bg/90 backdrop-blur border-b border-line/60">
        <div className="flex items-center gap-2 px-2 h-14">
          <button onClick={() => nav(-1)} className="h-12 w-12 text-2xl" aria-label="Zurück">‹</button>
          <h1 className="flex-1 font-bold truncate">Clip bearbeiten</h1>
          <ScoreBadge score={clip.total_score} />
        </div>
      </header>
      <div className="p-4 space-y-5">
        <div className="relative mx-auto bg-black rounded-3xl overflow-hidden" style={{ aspectRatio: '9 / 16', maxHeight: '55vh' }}>
          {clip.preview_url ? <video key={clip.version} src={clip.preview_url} poster={clip.thumb_url || undefined} controls playsInline loop className="h-full w-full object-contain" /> :
            <div className="h-full grid place-items-center text-zinc-500">Noch keine Vorschau</div>}
          {['queued', 'rendering'].includes(clip.render_status) && (
            <div className="absolute inset-0 bg-black/60 grid place-items-center"><div className="flex items-center gap-3"><Spinner /> rendert …</div></div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone="accent">{clip.category}</Badge>
          <Badge>{clip.origin === 'post' ? 'Nachbearbeitung' : clip.origin === 'manual' ? 'manuell markiert' : 'live'}</Badge>
          {clip.live_confirmed && <Badge tone="ok">vom Gesamt-Durchlauf bestätigt</Badge>}
          <Badge tone={clip.review_state === 'approved' ? 'ok' : clip.review_state === 'rejected' ? 'bad' : 'zinc'}>{
            { pending: 'offen', approved: 'freigegeben', rejected: 'abgelehnt', later: 'später' }[clip.review_state] || clip.review_state}</Badge>
        </div>
        {clip.reason && <p className="text-zinc-300">{clip.reason}</p>}
        {clip.safety_flagged && (
          <Card className="p-4 border-warn/40 bg-warn/5">
            <div className="font-semibold text-amber-300">⚠ {clip.safety_labels.join(', ') || 'Safety-Hinweis'}</div>
            {clip.safety_note && <p className="text-sm text-amber-100/80 mt-1">{clip.safety_note}</p>}
            {clip.safety_override && <p className="text-sm text-green-300 mt-1">Ausdrücklich freigegeben.</p>}
          </Card>
        )}

        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="font-semibold">Schnitt</div>
            <div className="text-sm tabular-nums text-zinc-300">{fmtDuration(form.start!)} – {fmtDuration(form.end!)} · <b>{((form.end! - form.start!)).toFixed(1)} s</b></div>
          </div>
          <RangeSlider min={lo} max={hi} start={form.start!} end={form.end!} onChange={(s, e) => setForm({ ...form, start: Math.round(s * 10) / 10, end: Math.round(e * 10) / 10 })} />
          <div className="grid grid-cols-4 gap-2">
            <Button size="sm" variant="soft" onClick={() => setForm({ ...form, start: Math.max(lo, form.start! - 1) })}>Start −1</Button>
            <Button size="sm" variant="soft" onClick={() => setForm({ ...form, start: Math.min(form.end! - 3, form.start! + 1) })}>Start +1</Button>
            <Button size="sm" variant="soft" onClick={() => setForm({ ...form, end: Math.max(form.start! + 3, form.end! - 1) })}>Ende −1</Button>
            <Button size="sm" variant="soft" onClick={() => setForm({ ...form, end: Math.min(hi, form.end! + 1) })}>Ende +1</Button>
          </div>
          <p className="text-xs text-zinc-500">Ziel 10–35 Sekunden. Nach dem Ändern „Neu rendern“.</p>
        </Card>

        <Card className="p-4 space-y-4">
          <Field label="Hook-Untertitel (erste 2–3 Sekunden)">
            <input className={inputCls} value={form.hook_text || ''} maxLength={80} onChange={(e) => setForm({ ...form, hook_text: e.target.value })} />
          </Field>
          <Field label="Kontext-Zeile (optional)">
            <input className={inputCls} value={form.context_line || ''} maxLength={90} placeholder="z. B. Nach 3 Stunden Grind …" onChange={(e) => setForm({ ...form, context_line: e.target.value })} />
          </Field>
          <div>
            <div className="text-sm text-zinc-300 mb-1.5">Untertitel (Wort für Wort, Großbuchstaben)</div>
            <div className="space-y-2">
              {(form.subtitle_lines || []).map((ln, i) => (
                <input key={i} className={`${inputCls} uppercase`} value={ln} aria-label={`Untertitel-Zeile ${i + 1}`}
                  onChange={(e) => { const l = [...(form.subtitle_lines || [])]; l[i] = e.target.value; setForm({ ...form, subtitle_lines: l }) }} />
              ))}
              {!form.subtitle_lines?.length && <p className="text-sm text-zinc-500">Keine Sprache im Clip.</p>}
            </div>
          </div>
        </Card>

        <Card className="p-4 space-y-4">
          <Field label="Arbeitstitel">
            <input className={inputCls} value={form.title || ''} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <div className="grid grid-cols-3 gap-1 rounded-2xl bg-surface-2 p-1" role="tablist">
            {(['tiktok', 'instagram', 'youtube'] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                className={`min-h-10 rounded-xl text-sm font-semibold ${tab === t ? 'bg-accent text-white' : 'text-zinc-400'}`}>{PLATFORM_LABEL[t]}</button>
            ))}
          </div>
          {tab === 'tiktok' && (<>
            <Field label="Beschreibung"><textarea className={`${inputCls} min-h-24`} value={caps.tiktok?.description || ''} onChange={(e) => setCap('tiktok', 'description', e.target.value)} /></Field>
            <Field label="Hashtags (mit Leerzeichen)"><input className={inputCls} value={(caps.tiktok?.hashtags || []).join(' ')} onChange={(e) => setCap('tiktok', 'hashtags', e.target.value.split(/\s+/).filter(Boolean))} /></Field>
          </>)}
          {tab === 'instagram' && (<>
            <Field label="Caption"><textarea className={`${inputCls} min-h-24`} value={caps.instagram?.caption || ''} onChange={(e) => setCap('instagram', 'caption', e.target.value)} /></Field>
            <Field label="Hashtags"><input className={inputCls} value={(caps.instagram?.hashtags || []).join(' ')} onChange={(e) => setCap('instagram', 'hashtags', e.target.value.split(/\s+/).filter(Boolean))} /></Field>
          </>)}
          {tab === 'youtube' && (<>
            <Field label={`Titel (${(caps.youtube?.title || '').length}/100)`}><input className={inputCls} maxLength={100} value={caps.youtube?.title || ''} onChange={(e) => setCap('youtube', 'title', e.target.value)} /></Field>
            <Field label="Beschreibung"><textarea className={`${inputCls} min-h-24`} value={caps.youtube?.description || ''} onChange={(e) => setCap('youtube', 'description', e.target.value)} /></Field>
            <Field label="Tags (Komma)"><input className={inputCls} value={(caps.youtube?.tags || []).join(', ')} onChange={(e) => setCap('youtube', 'tags', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} /></Field>
          </>)}
          <Button variant="ghost" className="w-full" onClick={async () => { await api(`/api/clips/${clip.id}/captions`, { body: {} }); toast('Texte werden neu geschrieben …'); setTimeout(() => { setForm(null); reload() }, 6000) }}>Texte neu generieren</Button>
        </Card>

        {accounts.length > 0 && (
          <Card className="p-4">
            <div className="font-semibold mb-2">Plattformen für diesen Clip</div>
            <div className="flex flex-wrap gap-2">
              {accounts.map((a) => {
                const sel = form.platforms?.length ? form.platforms.includes(a.id) : true
                return (
                  <button key={a.id} onClick={() => {
                    const cur = form.platforms?.length ? form.platforms : accounts.map((x) => x.id)
                    setForm({ ...form, platforms: sel ? cur.filter((x) => x !== a.id) : [...cur, a.id] })
                  }} className={`min-h-10 px-3 rounded-full text-sm font-semibold border ${sel ? 'bg-accent/20 border-accent' : 'border-line text-zinc-500'}`}>
                    {sel ? '✓ ' : ''}{PLATFORM_LABEL[a.platform] || a.platform} · {a.name}
                  </button>
                )
              })}
            </div>
          </Card>
        )}

        {pubs.length > 0 && (
          <Card className="p-4">
            <div className="font-semibold mb-2">Veröffentlichungen</div>
            <ul className="space-y-2 text-sm">
              {pubs.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2">
                  <span>{PLATFORM_LABEL[p.platform] || p.platform} · {p.account_name}</span>
                  <span className="text-zinc-400">{p.status === 'live' && p.external_url ? <a href={p.external_url} className="text-violet-300" target="_blank" rel="noreferrer">live ↗</a> : `${p.status} ${p.scheduled_at ? fmtTime(p.scheduled_at) : ''}`}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Button variant="soft" onClick={rerender} disabled={busy}>Neu rendern</Button>
          <Button variant="soft" onClick={async () => { await api(`/api/clips/${clip.id}/safety-check`, { body: {} }); toast('Safety-Check läuft …'); setTimeout(reload, 5000) }}>Safety-Check</Button>
          <Button variant="soft" onClick={share} disabled={!clip.preview_url}>Teilen</Button>
          <a className="inline-flex items-center justify-center min-h-12 rounded-2xl bg-surface-2 font-semibold" href={`${(clip.final_url || clip.preview_url || '').split('?')[0]}?download=1`}
            aria-disabled={!clip.preview_url}>Aufs Handy speichern</a>
        </div>
        {!clip.final_url && <p className="text-xs text-zinc-500">Speichern lädt die 540p-Vorschau. Das Original (1080×1920) entsteht beim Freigeben.</p>}
      </div>

      <div className="fixed bottom-0 left-0 right-0 z-30 bg-bg/95 backdrop-blur border-t border-line safe-bottom">
        <div className="max-w-2xl mx-auto grid grid-cols-3 gap-2 p-3">
          <Button variant="danger" onClick={() => review('reject')}>Ablehnen</Button>
          <Button variant="soft" onClick={() => save()} disabled={!dirty || busy}>Speichern</Button>
          <Button variant="ok" onClick={() => review('approve')}>Freigeben</Button>
        </div>
      </div>
    </div>
  )
}
