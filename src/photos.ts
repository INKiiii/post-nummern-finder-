// Ein Foto pro Haus (Einfahrt/Briefkasten), nur lokal gespeichert. Hilft, alte Häuser,
// lange Auffahrten und kleine Hausnummern sofort wiederzuerkennen.

import * as db from './db';

export interface HousePhoto {
  key: string; // wie Haus-Info: plz|straße|nummer
  dataUrl: string; // JPEG, verkleinert
  updated: number;
}

const cache = new Map<string, HousePhoto>();
let loaded = false;

export async function loadPhotos(): Promise<Map<string, HousePhoto>> {
  if (!loaded) {
    for (const p of await db.getAll<HousePhoto>('photos')) cache.set(p.key, p);
    loaded = true;
  }
  return cache;
}

export function getPhoto(key: string): HousePhoto | undefined {
  return cache.get(key);
}

export async function savePhoto(key: string, dataUrl: string, updated = Date.now()): Promise<void> {
  const p = { key, dataUrl, updated };
  cache.set(key, p);
  await db.put('photos', p);
}

export async function deletePhoto(key: string): Promise<void> {
  cache.delete(key);
  await db.del('photos', key);
}

/** Verkleinert ein Kamerabild auf max. 1024 px (JPEG ~100–200 KB). */
export async function shrinkImage(file: Blob, max = 1024, quality = 0.72): Promise<string> {
  const bmp = await createImageBitmap(file).catch(() => null);
  let w: number;
  let h: number;
  let draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  if (bmp) {
    w = bmp.width;
    h = bmp.height;
    draw = (ctx, cw, ch) => ctx.drawImage(bmp, 0, 0, cw, ch);
  } else {
    const url = URL.createObjectURL(file);
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    w = img.naturalWidth;
    h = img.naturalHeight;
    draw = (ctx, cw, ch) => ctx.drawImage(img, 0, 0, cw, ch);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const f = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * f);
  canvas.height = Math.round(h * f);
  draw(canvas.getContext('2d')!, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}
