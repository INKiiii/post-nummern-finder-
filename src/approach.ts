// Hinweis bei Annäherung an Einfahrt bzw. Haus: kurzer Ton (und Vibration, wo erlaubt).
// iPhone-Web-Apps dürfen nicht vibrieren; der Ton ist hörbar, wenn der Stummschalter aus ist
// (oder über Bluetooth im Auto).

const KEY = 'hnf-sound';
export const APPROACH_FAR = 50;
export const APPROACH_NEAR = 15;

let ctx: AudioContext | null = null;

export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* egal */
  }
}

/** Muss einmal nach einem Tippen aufgerufen werden (iOS gibt Ton erst danach frei). */
export function unlockAudio() {
  try {
    const AC = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    /* kein Ton möglich */
  }
}

export function beep(times = 1, freq = 880) {
  navigator.vibrate?.(times === 1 ? 200 : [150, 100, 150]);
  if (!soundEnabled() || !ctx) return;
  const t0 = ctx.currentTime + 0.02;
  for (let i = 0; i < times; i++) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    const start = t0 + i * 0.25;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.6, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.2);
  }
}

/**
 * Löst je Ziel einmal bei 50 m (ein Ton) und einmal bei 15 m (zwei Töne) aus,
 * nur wenn man sich nähert und das Ziel nicht hinter einem liegt.
 */
export class ApproachAlert {
  private fired = new Set<number>();
  private last = Infinity;

  /** @returns 'far' | 'near' wenn gerade ausgelöst, sonst null */
  update(distance: number, behind: boolean): 'far' | 'near' | null {
    const approaching = distance < this.last - 1;
    this.last = distance;
    if (behind || !approaching) return null;
    if (distance <= APPROACH_NEAR && !this.fired.has(APPROACH_NEAR)) {
      this.fired.add(APPROACH_NEAR).add(APPROACH_FAR);
      beep(2, 1046);
      return 'near';
    }
    if (distance <= APPROACH_FAR && distance > APPROACH_NEAR && !this.fired.has(APPROACH_FAR)) {
      this.fired.add(APPROACH_FAR);
      beep(1, 880);
      return 'far';
    }
    return null;
  }
}
