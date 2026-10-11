// Bildschirm bleibt an, solange die App sichtbar ist.
//
// 1. Screen Wake Lock API (Chrome/Android, Safari ab iOS 16.4). In Web-Apps vom
//    Home-Bildschirm funktioniert sie auf dem iPhone laut WebKit erst ab iOS 18.4 zuverlässig.
// 2. Ausweichweg für iPhone-Web-Apps: ein winziges, stummes Video in Endlosschleife
//    (dieselbe Methode wie die Bibliothek NoSleep.js). Muss nach einem Tippen starten.
// Ob es wirklich wirkt, lässt sich nicht abfragen. Sicher ist nur:
// Einstellungen › Anzeige & Helligkeit › Automatische Sperre › Nie.

type WakeState = 'aus' | 'wakelock' | 'video' | 'nicht möglich';

let sentinel: { release: () => Promise<void>; addEventListener?: (t: string, f: () => void) => void } | null = null;
let video: HTMLVideoElement | null = null;
let wanted = false;
let status: WakeState = 'aus';
const listeners = new Set<(s: WakeState) => void>();

function setStatus(s: WakeState) {
  status = s;
  for (const l of listeners) l(s);
}

export function wakeStatus(): WakeState {
  return status;
}

export function onWakeStatus(fn: (s: WakeState) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const isIOS = () => typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => (navigator as any).standalone === true || matchMedia?.('(display-mode: standalone)').matches;

async function requestLock(): Promise<boolean> {
  const wl = (navigator as any).wakeLock;
  if (!wl?.request) return false;
  try {
    sentinel = await wl.request('screen');
    sentinel?.addEventListener?.('release', () => {
      sentinel = null;
    });
    return true;
  } catch {
    return false;
  }
}

function startVideo(): boolean {
  try {
    if (!video) {
      video = document.createElement('video');
      video.setAttribute('playsinline', '');
      video.setAttribute('muted', '');
      video.muted = true;
      video.loop = true;
      video.src = new URL('keepawake.mp4', document.baseURI).toString();
      Object.assign(video.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0.01', pointerEvents: 'none', left: '0', bottom: '0' });
      document.body.appendChild(video);
    }
    void video.play().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Einschalten (am besten nach einem Tippen aufrufen, iOS verlangt das für das Video). */
export async function keepAwake() {
  wanted = true;
  if (document.visibilityState !== 'visible') return;
  const locked = sentinel ? true : await requestLock();
  // iPhone-Web-App vom Home-Bildschirm: zusätzlich das Video (Wake Lock wirkt dort ggf. nicht)
  const useVideo = !locked || (isIOS() && standalone());
  const vid = useVideo ? startVideo() : false;
  setStatus(locked ? 'wakelock' : vid ? 'video' : 'nicht möglich');
}

export function releaseAwake() {
  wanted = false;
  void sentinel?.release().catch(() => {});
  sentinel = null;
  video?.pause();
  setStatus('aus');
}

if (typeof document !== 'undefined') {
  // Nach dem Zurückkehren in die App (Sperre wird beim Verstecken aufgehoben) neu anfordern
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wanted) void keepAwake();
  });
  // Erstes Tippen: Video darf jetzt starten
  document.addEventListener(
    'pointerdown',
    () => {
      if (wanted && (status !== 'wakelock' || (isIOS() && standalone()))) void keepAwake();
    },
    { passive: true },
  );
}
