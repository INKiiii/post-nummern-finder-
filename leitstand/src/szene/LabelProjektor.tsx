import { useFrame } from '@react-three/fiber';
import { Vector3 } from 'three';
import { anker, elemente } from './beschriftung';

const v = new Vector3();

/** Projiziert alle Ankerpunkte auf den Bildschirm und verschiebt die Beschriftungen */
export function LabelProjektor() {
  useFrame(({ camera, size }) => {
    for (const [id, el] of elemente) {
      const p = anker.get(id);
      if (!p || el.dataset.aus === '1') {
        if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
        continue;
      }
      v.copy(p).project(camera);
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.15 || Math.abs(v.y) > 1.15) {
        if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
        continue;
      }
      const x = ((v.x + 1) / 2) * size.width;
      const y = ((1 - v.y) / 2) * size.height;
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      if (el.style.visibility !== 'visible') el.style.visibility = 'visible';
    }
  });
  return null;
}
