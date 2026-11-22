import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import * as tus from 'tus-js-client'
import { api, fmtDuration } from '../api'
import { Button, Card, Field, inputCls, PageHeader, Progress, Toggle, usePoll, useToast } from '../components/ui'
import type { Channel } from '../types'

export default function Upload() {
  const toast = useToast()
  const { data: channels } = usePoll(() => api<Channel[]>('/api/channels'), 0)
  const [file, setFile] = useState<File | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const [estimate, setEstimate] = useState<{ usd: number; eur: number; ai: string } | null>(null)
  const [channelId, setChannelId] = useState<string>('')
  const [auto, setAuto] = useState(true)
  const [progress, setProgress] = useState<number | null>(null)
  const [done, setDone] = useState<number | null>(null)
  const uploadRef = useRef<tus.Upload | null>(null)
  const [url, setUrl] = useState('')
  const [rights, setRights] = useState(false)

  useEffect(() => {
    if (!file) return
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.onloadedmetadata = () => { setDuration(v.duration); URL.revokeObjectURL(v.src) }
    v.src = URL.createObjectURL(file)
  }, [file])

  useEffect(() => {
    if (!duration) return
    api<{ usd: number; eur: number; ai: string }>(`/api/estimate?duration=${Math.round(duration)}`).then(setEstimate).catch(() => {})
  }, [duration])

  function start() {
    if (!file) return
    setProgress(0)
    const up = new tus.Upload(file, {
      endpoint: '/api/uploads/tus',
      chunkSize: 16 * 1024 * 1024,
      retryDelays: [0, 2000, 5000, 10000, 30000, 60000],
      removeFingerprintOnSuccess: true,
      metadata: { filename: file.name, title: file.name.replace(/\.[^.]+$/, ''), channel_id: channelId, auto_process: auto ? '1' : '0' },
      onError: (err) => { toast(`Upload unterbrochen: ${err.message}. Erneut tippen setzt fort.`, 'bad'); setProgress(null) },
      onProgress: (sent, total) => setProgress(sent / total),
      onSuccess: async () => {
        const id = up.url?.split('/').pop()
        try {
          const r = await api<{ stream_id: number | null; error: string | null }>(`/api/uploads/${id}`)
          if (r.error) throw new Error(r.error)
          setDone(r.stream_id)
          toast(auto ? 'Hochgeladen – Analyse läuft' : 'Hochgeladen', 'ok')
        } catch (e) { toast((e as Error).message, 'bad') }
        setProgress(null)
      },
    })
    uploadRef.current = up
    // Wiederaufnahme nach Abbruch (Funkloch, App im Hintergrund)
    up.findPreviousUploads().then((prev) => {
      if (prev.length) up.resumeFromPreviousUpload(prev[0])
      up.start()
    })
  }

  async function importUrl() {
    try {
      await api('/api/uploads/url', { body: { url, rights_confirmed: rights, channel_id: channelId ? Number(channelId) : null } })
      toast('Import gestartet – siehe Aktivität', 'ok')
      setUrl('')
    } catch (e) { toast((e as Error).message, 'bad') }
  }

  return (
    <div>
      <PageHeader title="Upload" />
      <div className="p-4 space-y-5">
        <Card className="p-4 space-y-4">
          <div className="font-semibold">Kompletten Stream hochladen</div>
          <p className="text-sm text-zinc-400">1–8 Stunden sind kein Problem: Der Upload läuft in Stücken und setzt nach Abbrüchen fort. Rohmaterial bleibt auf dem Server, nicht auf dem Handy.</p>
          <label className="flex items-center justify-center min-h-24 rounded-2xl border-2 border-dashed border-line bg-surface-2 text-zinc-300 text-center px-4">
            <input type="file" accept="video/*,.mkv,.ts,.flv" className="hidden" onChange={(e) => { setFile(e.target.files?.[0] || null); setDone(null); setDuration(null); setEstimate(null) }} />
            {file ? <span><b>{file.name}</b><br /><span className="text-sm text-zinc-400">{(file.size / 1e9).toFixed(2)} GB{duration ? ` · ${fmtDuration(duration)}` : ''}</span></span> : 'Video auswählen'}
          </label>
          {estimate && (
            <div className="rounded-2xl bg-surface-2 p-3 text-sm">
              Geschätzte KI-Kosten: <b>{estimate.eur.toFixed(2)} €</b> ({estimate.usd.toFixed(2)} $){estimate.ai === 'heuristik' && ' – ohne API-Key läuft der kostenlose Heuristik-Modus'}
            </div>
          )}
          <Field label="Kanal (optional, für Brand-Voice und Lernbeispiele)">
            <select className={inputCls} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
              <option value="">– keiner –</option>
              {channels?.map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}
            </select>
          </Field>
          <Toggle label="Nach dem Upload automatisch analysieren" checked={auto} onChange={setAuto} />
          {progress !== null && <div><Progress value={progress} /><div className="text-sm text-zinc-400 mt-1 tabular-nums">{Math.round(progress * 100)} %</div></div>}
          {progress === null ? (
            <Button size="lg" className="w-full" disabled={!file} onClick={start}>Hochladen</Button>
          ) : (
            <Button size="lg" variant="ghost" className="w-full" onClick={() => { uploadRef.current?.abort(); setProgress(null) }}>Pausieren</Button>
          )}
          {done && <Link to="/streams" className="block text-center text-violet-300 font-semibold">Zum Stream →</Link>}
        </Card>

        <Card className="p-4 space-y-4">
          <div className="font-semibold">VOD per Link importieren</div>
          <input className={inputCls} placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" aria-label="Video-Link" />
          <label className="flex gap-3 items-start text-sm">
            <input type="checkbox" className="mt-0.5 h-6 w-6 accent-violet-500 shrink-0" checked={rights} onChange={(e) => setRights(e.target.checked)} />
            <span>Ich habe die Rechte an diesem Material (z. B. eigener Kanal oder Zustimmung des Streamers).</span>
          </label>
          <Button className="w-full" variant="soft" disabled={!url || !rights} onClick={importUrl}>Importieren</Button>
        </Card>
        <p className="text-xs text-zinc-500 px-1">Tipp: Dateien im Server-Ordner <code>data/inbox</code> werden automatisch importiert.</p>
      </div>
    </div>
  )
}
