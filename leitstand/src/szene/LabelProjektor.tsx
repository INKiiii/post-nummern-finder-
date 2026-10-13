import { useFrame } from '@react-three/fiber';
import { Vector3 } from 'three';
import { anker, elemente } from './beschriftung';

const v = new Vector3();
/** Größe der Beschriftungen, die sich nicht überdecken sollen (einmal gemessen) */
const groesse = new WeakMap<HTMLElement, { w: number; h: number }>();

/** Basis und Ortsnamen: überdecken sich zwei, bleibt der wichtigere stehen (Basis zuerst) */
function mitKollision(id: string): boolean {
  return id === 'basis' || id.startsWith('ort:');
}

function verstecken(el: HTMLElement): void {
  if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
}

/** Projiziert alle Ankerpunkte auf den Bildschirm und verschiebt die Beschriftungen */
export function LabelProjektor() {
  useFrame(({ camera, size }) => {
    const platz = (id: string, el: HTMLElement): { x: number; y: number } | null => {
      const p = anker.get(id);
      if (!p || el.dataset.aus === '1') return null;
      v.copy(p).project(camera);
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.15 || Math.abs(v.y) > 1.15) return null;
      return { x: ((v.x + 1) / 2) * size.width, y: ((1 - v.y) / 2) * size.height };
    };
    const zeigen = (el: HTMLElement, x: number, y: number) => {
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      if (el.style.visibility !== 'visible') el.style.visibility = 'visible';
    };

    const kollision: Array<[string, HTMLElement]> = [];
    for (const [id, el] of elemente) {
      if (mitKollision(id)) {
        kollision.push([id, el]);
        continue;
      }
      const q = platz(id, el);
      if (q) zeigen(el, q.x, q.y);
      else verstecken(el);
    }

    // Basis zuerst, dann die Ortsnamen; was sich mit schon Gezeigtem überdeckt, bleibt weg
    kollision.sort((a, b) => (a[0] === 'basis' ? -1 : b[0] === 'basis' ? 1 : 0));
    const boxen: Array<{ l: number; r: number; o: number; u: number }> = [];
    for (const [id, el] of kollision) {
      const q = platz(id, el);
      if (!q) {
        verstecken(el);
        continue;
      }
      let g = groesse.get(el);
      if (!g || g.w === 0) {
        const inhalt = (el.firstElementChild as HTMLElement | null) ?? el;
        g = { w: inhalt.offsetWidth, h: inhalt.offsetHeight };
        groesse.set(el, g);
      }
      const box = { l: q.x - g.w / 2 - 4, r: q.x + g.w / 2 + 4, o: q.y - g.h - 2, u: q.y + 2 };
      if (boxen.some((b) => box.l < b.r && box.r > b.l && box.o < b.u && box.u > b.o)) {
        verstecken(el);
        continue;
      }
      boxen.push(box);
      zeigen(el, q.x, q.y);
    }
  });
  return null;
}
