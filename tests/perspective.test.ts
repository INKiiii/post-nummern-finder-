// Navi-Ansicht: Neigung der flachen Karte, Entzerrung der Beschriftungen, CSS-Matrix.
import { describe, it, expect } from 'vitest';
import { affine, applyH, factorFlat, factorScreen, homography, mul3, perspFor, project, unproject, unskew } from '../src/perspective';

const P = perspFor(200, 690, 0, 393);
const near = (a: number[], b: number[], eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);

describe('Navi-Ansicht (Neigung)', () => {
  it('unten 1:1, nach oben kleiner; Horizont liegt über dem freien Bereich', () => {
    expect(near(project(P, 100, 690), [100, 690])).toBe(true);
    expect(factorFlat(P, 690)).toBe(1);
    // Ein Punkt weit voraus rückt zur Mitte und nach oben, bleibt aber unter dem Horizont
    const [x, y] = project(P, 0, -2000);
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(P.y0 - 1 / P.k);
    // Die Oberkante des freien Bereichs entspricht flach einer weiten Strecke (Blick nach vorn)
    expect(P.y0 - unproject(P, 196, 200)[1]).toBeGreaterThan(2 * (690 - 200));
  });

  it('Bildschirm ↔ flach sind zueinander umkehrbar', () => {
    for (const [x, y] of [
      [10, 650],
      [300, 250],
      [196, 400],
    ]) {
      const [X, Y] = project(P, x, y);
      expect(near(unproject(P, X, Y), [x, y], 1e-6)).toBe(true);
    }
    expect(factorScreen(P, project(P, 0, 300)[1])).toBeCloseTo(factorFlat(P, 300), 9);
  });

  it('Entzerrung: eine so gezeichnete Beschriftung erscheint unverzerrt (aufrecht, gleich groß)', () => {
    const [fx, fy] = [80, 260];
    const [a, b, c, d] = unskew(P, fx, fy);
    const [X0, Y0] = project(P, fx, fy);
    // kleine Strecke 1 px nach rechts bzw. unten auf dem Bildschirm
    const e = 1e-3;
    const right = project(P, fx + a * e, fy + b * e);
    const down = project(P, fx + c * e, fy + d * e);
    expect(near([(right[0] - X0) / e, (right[1] - Y0) / e], [1, 0], 1e-3)).toBe(true);
    expect(near([(down[0] - X0) / e, (down[1] - Y0) / e], [0, 1], 1e-3)).toBe(true);
  });

  it('eine Matrix für Gleiten und Neigung zusammen (wie im Browser)', () => {
    const glide: [number, number, number, number, number, number] = [0.99, 0.05, -0.05, 0.99, 4, -7];
    const H = mul3(homography(P), affine(glide));
    const [x, y] = [120, 420];
    const gx = glide[0] * x + glide[2] * y + glide[4];
    const gy = glide[1] * x + glide[3] * y + glide[5];
    expect(near(applyH(H, x, y), project(P, gx, gy), 1e-9)).toBe(true);
  });
});
