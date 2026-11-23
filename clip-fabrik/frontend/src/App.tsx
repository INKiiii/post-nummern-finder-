import { lazy, Suspense, useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { api, setUnauthorizedHandler } from './api'
import { Spinner } from './components/ui'
import Login from './pages/Login'
import Channels from './pages/Channels'
import Review from './pages/Review'
import More from './pages/More'
import { Invite, InviteDone } from './pages/Invite'

// Seltener genutzte Seiten werden erst bei Bedarf geladen (schneller Start im Mobilfunk)
const ClipEditor = lazy(() => import('./pages/ClipEditor'))
const Archive = lazy(() => import('./pages/Archive'))
const Queue = lazy(() => import('./pages/Queue'))
const Accounts = lazy(() => import('./pages/Accounts'))
const Upload = lazy(() => import('./pages/Upload'))
const Settings = lazy(() => import('./pages/Settings'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Jobs = lazy(() => import('./pages/Jobs'))
const Streams = lazy(() => import('./pages/Streams'))

const TABS = [
  { to: '/', label: 'Kanäle', icon: IconChannels, end: true },
  { to: '/review', label: 'Review', icon: IconCards },
  { to: '/warteschlange', label: 'Plan', icon: IconQueue },
  { to: '/mehr', label: 'Mehr', icon: IconMore },
]

export default function App() {
  const [auth, setAuth] = useState<'unknown' | 'in' | 'out'>('unknown')
  const [pending, setPending] = useState(0)
  const loc = useLocation()
  const nav = useNavigate()
  const isPublic = loc.pathname.startsWith('/einladung')

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth('out'))
    api<{ logged_in: boolean }>('/api/auth/me').then((r) => setAuth(r.logged_in ? 'in' : 'out')).catch(() => setAuth('out'))
  }, [])

  useEffect(() => {
    if (auth !== 'in') return
    const load = () => api<{ id: number }[]>('/api/clips?bucket=review&state=pending&limit=300').then((c) => setPending(c.length)).catch(() => {})
    load()
    const id = setInterval(() => document.visibilityState === 'visible' && load(), 15000)
    return () => clearInterval(id)
  }, [auth, loc.pathname])

  if (isPublic) {
    return (
      <Routes>
        <Route path="/einladung/fertig" element={<InviteDone />} />
        <Route path="/einladung/:token" element={<Invite />} />
      </Routes>
    )
  }
  if (auth === 'unknown') return <div className="h-full grid place-items-center"><Spinner /></div>
  if (auth === 'out') return <Login onLogin={() => { setAuth('in'); nav(loc.pathname + loc.search, { replace: true }) }} />

  const hideTabs = loc.pathname.startsWith('/clips/')
  return (
    <div className="min-h-full flex flex-col max-w-2xl mx-auto">
      <main className={`flex-1 ${hideTabs ? '' : 'pb-24'}`}>
        <Suspense fallback={<div className="grid place-items-center py-24"><Spinner /></div>}>
        <Routes>
          <Route path="/" element={<Channels />} />
          <Route path="/review" element={<Review />} />
          <Route path="/clips/:id" element={<ClipEditor />} />
          <Route path="/archiv" element={<Archive />} />
          <Route path="/warteschlange" element={<Queue />} />
          <Route path="/konten" element={<Accounts />} />
          <Route path="/upload" element={<Upload />} />
          <Route path="/einstellungen" element={<Settings />} />
          <Route path="/auswertung" element={<Dashboard />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/streams" element={<Streams />} />
          <Route path="/mehr" element={<More onLogout={() => setAuth('out')} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </main>
      {!hideTabs && (
        <nav className="fixed bottom-0 left-0 right-0 z-30 bg-bg/95 backdrop-blur border-t border-line safe-bottom" aria-label="Hauptnavigation">
          <div className="max-w-2xl mx-auto grid grid-cols-4">
            {TABS.map((t) => (
              <NavLink key={t.to} to={t.to} end={t.end}
                className={({ isActive }) => `relative flex flex-col items-center justify-center gap-1 h-16 text-xs font-medium ${isActive ? 'text-white' : 'text-zinc-500'}`}>
                {({ isActive }) => (
                  <>
                    <t.icon active={isActive} />
                    <span>{t.label}</span>
                    {t.to === '/review' && pending > 0 && (
                      <span className="absolute top-2 left-1/2 ml-2 min-w-5 h-5 px-1 rounded-full bg-hl text-black text-[11px] font-bold grid place-items-center">{pending > 99 ? '99+' : pending}</span>
                    )}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        </nav>
      )}
    </div>
  )
}

function IconChannels({ active }: { active: boolean }) {
  return <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.4 : 1.8}><rect x="3" y="5" width="18" height="12" rx="3" /><path d="M8 21h8M12 17v4" /><circle cx="17.5" cy="8.5" r="1.3" fill={active ? '#ef4444' : 'currentColor'} stroke="none" /></svg>
}
function IconCards({ active }: { active: boolean }) {
  return <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.4 : 1.8}><rect x="6" y="3" width="12" height="18" rx="3" /><path d="M3 6v12M21 6v12" /><path d="M10.5 9.5l4 2.5-4 2.5z" fill="currentColor" /></svg>
}
function IconQueue({ active }: { active: boolean }) {
  return <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.4 : 1.8}><rect x="3" y="4" width="18" height="17" rx="3" /><path d="M3 9h18M8 2v4M16 2v4M7 13h4M7 17h7" /></svg>
}
function IconMore({ active }: { active: boolean }) {
  return <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" stroke="none" opacity={active ? 1 : 0.85}><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
}
