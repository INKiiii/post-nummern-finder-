// Einstellungen (lokal, pro Gerät): Hell/Dunkel, Töne.

export type ThemeChoice = 'auto' | 'light' | 'dark';

const THEME_KEY = 'hnf-theme';
const PASS_KEY = 'hnf-pass-beep';

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function set(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* egal */
  }
}

export function themeChoice(): ThemeChoice {
  const v = get(THEME_KEY);
  return v === 'light' || v === 'dark' ? v : 'auto';
}

let mql: MediaQueryList | null = null;

/** Wendet Hell/Dunkel an: automatisch nach Systemeinstellung oder fest gewählt. */
export function applyTheme(choice: ThemeChoice = themeChoice()) {
  set(THEME_KEY, choice);
  if (typeof window === 'undefined') return;
  mql ??= window.matchMedia?.('(prefers-color-scheme: light)') ?? null;
  const resolve = () => {
    const c = themeChoice();
    const light = c === 'light' || (c === 'auto' && !!mql?.matches);
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f4f4f0' : '#000000');
  };
  resolve();
  if (mql && !(mql as any)._hnf) {
    (mql as any)._hnf = true;
    mql.addEventListener?.('change', resolve);
  }
}

/** Signalton, wenn man am Ziel vorbeigefahren ist (Standard: aus). */
export function passBeepEnabled(): boolean {
  return get(PASS_KEY) === 'on';
}
export function setPassBeep(on: boolean) {
  set(PASS_KEY, on ? 'on' : 'off');
}
