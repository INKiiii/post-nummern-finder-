// Live-GPS mit Fahrtrichtung (aus GPS-Kurs oder aus der Bewegung berechnet).

import { bearingDeg, distanceM } from './core';

export interface Fix {
  lat: number;
  lon: number;
  accuracy: number;
  heading: number | null;
  /** Kurs direkt vom GPS (nur bei Fahrt sinnvoll), sonst null */
  course: number | null;
  speed: number | null;
  time: number;
}

type Listener = (fix: Fix | null, error?: string) => void;

class Gps {
  fix: Fix | null = null;
  error: string | null = null;
  /** Standortzugriff wurde verweigert (Nutzer muss ihn in den Einstellungen erlauben) */
  denied = false;
  private watchId: number | null = null;
  private listeners = new Set<Listener>();
  private anchor: { lat: number; lon: number } | null = null;
  private heading: number | null = null;

  start() {
    if (this.watchId !== null || !('geolocation' in navigator)) {
      if (!('geolocation' in navigator)) this.error = 'Kein GPS verfügbar';
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (p) => this.onPosition(p),
      (e) => {
        this.denied = e.code === e.PERMISSION_DENIED;
        this.error = this.denied ? 'Standortzugriff verweigert' : 'Kein GPS-Signal';
        // Nach einer Verweigerung liefert die Abfrage nichts mehr: beenden, damit
        // retry() sie neu starten kann, sobald der Standort erlaubt wurde.
        if (this.denied) this.stop();
        this.emit();
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    );
  }

  /** Erneut versuchen (z. B. nach Rückkehr aus den Einstellungen). */
  retry() {
    if (this.watchId === null) this.start();
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    this.start();
    // Letzte bekannte Position sofort liefern (z. B. Postauto beim Öffnen des Ergebnisses)
    if (this.fix || this.error) queueMicrotask(() => fn(this.fix, this.error ?? undefined));
    return () => this.listeners.delete(fn);
  }

  private onPosition(p: GeolocationPosition) {
    const { latitude: lat, longitude: lon, accuracy, heading, speed } = p.coords;
    this.error = null;
    this.denied = false;
    // Kurs vom GPS nur bei Fahrt verlässlich; sonst aus der Bewegung (> 8 m) berechnen.
    if (heading !== null && Number.isFinite(heading) && speed !== null && speed > 1.5) {
      this.heading = heading;
      this.anchor = { lat, lon };
    } else if (!this.anchor) {
      this.anchor = { lat, lon };
    } else {
      const moved = distanceM(this.anchor.lat, this.anchor.lon, lat, lon);
      if (moved > Math.max(8, Math.min(accuracy, 25))) {
        this.heading = bearingDeg(this.anchor.lat, this.anchor.lon, lat, lon);
        this.anchor = { lat, lon };
      }
    }
    const course = heading !== null && Number.isFinite(heading) ? heading : null;
    this.fix = { lat, lon, accuracy, heading: this.heading, course, speed, time: p.timestamp };
    this.emit();
  }

  private emit() {
    for (const l of this.listeners) l(this.fix, this.error ?? undefined);
  }
}

export const gps = new Gps();

// Zurück aus den Einstellungen: Standort automatisch neu abfragen, ohne Neuladen.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    // Akku: im Hintergrund kein GPS; beim Zurückkehren sofort wieder an
    if (document.visibilityState === 'hidden') gps.stop();
    else gps.retry();
  });
  window.addEventListener('focus', () => gps.denied && gps.retry());
  // Chrome/Android meldet Änderungen der Berechtigung direkt
  navigator.permissions
    ?.query({ name: 'geolocation' as PermissionName })
    .then((st) => {
      st.onchange = () => {
        if (st.state !== 'denied') gps.retry();
      };
    })
    .catch(() => {});
}
