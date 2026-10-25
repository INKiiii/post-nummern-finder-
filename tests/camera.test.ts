// Kamera der Live-Karte: Umrechnung, Gleiten, Abdeckung des fertig gezeichneten Bildes.
import { describe, it, expect } from 'vitest';
import { MAX_TILT, angleDiff, covers, lerpCam, reanchor, sameCam, screenMatrix, toScreen, toWorld, type Cam } from '../src/camera';

const W = 393;
const H = 760;
const cam = (o: Partial<Cam> = {}): Cam => ({ ax: 10, ay: -5, sx: W / 2, sy: 560, rot: 30, scale: 4, ...o });
const near = (a: number[], b: number[], eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);

describe('Kamera', () => {
  it('Welt ↔ Bildschirm sind zueinander umkehrbar; Fahrtrichtung zeigt nach oben', () => {
    const c = cam();
    const [x, y] = toWorld(c, 100, 200);
    expect(near(toScreen(c, x, y), [100, 200])).toBe(true);
    // 10 m in Fahrtrichtung (30°) liegen 40 px genau über dem Bezugspunkt
    const r = (30 * Math.PI) / 180;
    expect(near(toScreen(c, 10 + 10 * Math.sin(r), -5 + 10 * Math.cos(r)), [W / 2, 520])).toBe(true);
  });

  it('kürzeste Drehung über Norden hinweg', () => {
    expect(angleDiff(350, 10)).toBeCloseTo(20);
    expect(angleDiff(10, 350)).toBeCloseTo(-20);
    expect(angleDiff(90, 270)).toBeCloseTo(-180);
  });

  it('Gleiten: das Fahrzeug (Bezugspunkt) bleibt an seiner Stelle, die Karte dreht sich um es', () => {
    const a = cam({ ax: 0, ay: 0, rot: 90 });
    const b = cam({ ax: 6, ay: 0, rot: 0, scale: 5 });
    const from = reanchor(a, b.sx, b.sy);
    for (const t of [0, 0.25, 0.5, 1]) {
      const v = lerpCam(from, b, t);
      // Weltpunkt des Fahrzeugs (geradlinig von a nach b) liegt immer am Bezugspunkt
      expect(near(toScreen(v, from.ax + (b.ax - from.ax) * t, from.ay + (b.ay - from.ay) * t), [b.sx, b.sy])).toBe(true);
    }
    expect(lerpCam(from, b, 0.5).rot).toBeCloseTo(45);
    expect(lerpCam(from, b, 0.5).scale).toBeCloseTo(Math.sqrt(4 * 5));
    // Drehung darf getrennt (sanft) laufen
    expect(lerpCam(from, b, 0.5, 0).rot).toBeCloseTo(90);
  });

  it('CSS-Matrix bildet das fertige Bild genau auf die angezeigte Ansicht ab', () => {
    const drawn = cam();
    const view = cam({ ax: 13, ay: -2, rot: 34, scale: 4.3 });
    const [a, b, c, d, e, f] = screenMatrix(drawn, view);
    for (const [px, py] of [
      [0, 0],
      [W, 0],
      [120, 640],
    ]) {
      const [wx, wy] = toWorld(drawn, px, py);
      expect(near([a * px + c * py + e, b * px + d * py + f], toScreen(view, wx, wy), 1e-6)).toBe(true);
    }
  });

  it('Neu zeichnen nur, wenn das Bild nicht mehr reicht, zu schräg oder zu stark vergrößert ist', () => {
    const d = cam();
    expect(sameCam(d, { ...d }, W, H)).toBe(true);
    // 5 m weiter (20 px) – Rand von 140 px reicht
    expect(covers(d, cam({ ax: 10 + 5 * Math.sin(Math.PI / 6), ay: -5 + 5 * Math.cos(Math.PI / 6) }), W, H, 140)).toBe(true);
    // 60 m weiter – reicht nicht mehr
    expect(covers(d, cam({ ay: 55 }), W, H, 140)).toBe(false);
    // Drehung über der Schwelle: Schrift wäre schief
    expect(covers(d, cam({ rot: 30 + MAX_TILT + 1 }), W, H, 1000)).toBe(false);
    expect(covers(d, cam({ rot: 30 + MAX_TILT - 1 }), W, H, 1000)).toBe(true);
    // stark vergrößert: unscharf
    expect(covers(d, cam({ scale: 5.2 }), W, H, 1000)).toBe(false);
    // ohne Rand (andere Karten): nur dieselbe Ansicht zählt
    expect(covers(d, cam({ ax: 10.5 }), W, H, 0)).toBe(false);
  });
});
