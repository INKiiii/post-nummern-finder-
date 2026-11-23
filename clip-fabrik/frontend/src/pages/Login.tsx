import { useState } from 'react'
import { api } from '../api'
import { Button, inputCls } from '../components/ui'

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await api('/api/auth/login', { body: { password: pw } })
      onLogin()
    } catch (ex) {
      setErr((ex as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-full flex flex-col justify-center px-6 py-10 max-w-sm mx-auto safe-top">
      <img src="/icons/icon.svg" alt="" className="w-20 h-20 mb-6" />
      <h1 className="text-3xl font-black">Clip-Fabrik</h1>
      <p className="text-zinc-400 mt-2 mb-8">Stream rein, fertige Clips raus.</p>
      <form onSubmit={submit} className="space-y-4">
        <input className={inputCls} type="password" autoComplete="current-password" placeholder="Passwort" value={pw}
          onChange={(e) => setPw(e.target.value)} aria-label="Passwort" autoFocus />
        {err && <p className="text-red-300 text-sm" role="alert">{err}</p>}
        <Button type="submit" size="lg" className="w-full" disabled={busy || !pw}>{busy ? 'Prüfe …' : 'Einloggen'}</Button>
      </form>
    </div>
  )
}
