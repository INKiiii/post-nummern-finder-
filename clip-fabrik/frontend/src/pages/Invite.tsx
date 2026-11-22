import { useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { Card, Spinner, usePoll } from '../components/ui'

type Info = { platform: string; label: string; used: boolean; channel: string | null; note: string; expires_at: string }

// Öffentliche Seite für den Streamer: bestätigt selbst am Handy (OAuth), ohne Login in der Clip-Fabrik
export function Invite() {
  const { token } = useParams()
  const { data, error, loading } = usePoll(() => api<Info>(`/api/invites/${token}`), 0, [token])
  return (
    <div className="min-h-full max-w-md mx-auto px-6 py-12 safe-top">
      <img src="/icons/icon.svg" alt="" className="w-16 h-16 mb-6" />
      {loading && <Spinner />}
      {error && <p className="text-red-300">{error}</p>}
      {data && (
        <>
          <h1 className="text-2xl font-black">{data.platform === 'twitch' ? 'Zustimmung bestätigen' : `${data.label} verbinden`}</h1>
          <p className="text-zinc-300 mt-3 leading-relaxed">
            {data.platform === 'twitch'
              ? <>Dein Mod nutzt die Clip-Fabrik, um aus deinen Streams{data.channel ? <> (<b>{data.channel}</b>)</> : null} kurze Clips zu schneiden. Mit deinem Twitch-Login bestätigst du, dass du einverstanden bist. Es werden keine Rechte an deinem Kanal vergeben.</>
              : <>Du wurdest eingeladen, dein {data.label}-Konto zu verbinden, damit freigegebene Clips dort veröffentlicht werden können. Du meldest dich direkt bei {data.label} an – die Clip-Fabrik sieht dein Passwort nie. Du kannst den Zugriff jederzeit in {data.label} widerrufen.</>}
          </p>
          {data.note && <Card className="p-4 mt-4 text-sm">{data.note}</Card>}
          {data.used ? <p className="mt-6 text-green-300 font-semibold">✓ Bereits bestätigt. Danke!</p> : (
            <a href={`/api/invites/${token}/start`} className="mt-8 flex items-center justify-center min-h-14 rounded-2xl bg-accent text-white text-lg font-bold">Weiter zu {data.label}</a>
          )}
          <p className="text-xs text-zinc-500 mt-6">Link gültig bis {new Date(data.expires_at).toLocaleDateString('de-DE')}.</p>
        </>
      )}
    </div>
  )
}

export function InviteDone() {
  const [p] = useSearchParams()
  const err = p.get('fehler')
  return (
    <div className="min-h-full max-w-md mx-auto px-6 py-16 text-center safe-top">
      <div className="text-5xl mb-4">{err ? '⚠️' : '✅'}</div>
      <h1 className="text-2xl font-black">{err ? 'Hat nicht geklappt' : 'Danke, erledigt!'}</h1>
      <p className="text-zinc-400 mt-3">{err || 'Du kannst dieses Fenster jetzt schließen.'}</p>
    </div>
  )
}
