// Fotos werden nicht mehr gespeichert (Datenschutz: keine Fotos). Ältere Versionen konnten
// ein Foto pro Haus ablegen; diese lassen sich hier zählen und löschen.

import * as db from './db';

export async function countOldPhotos(): Promise<number> {
  try {
    return (await db.getAll('photos')).length;
  } catch {
    return 0;
  }
}

export async function deleteOldPhotos(): Promise<void> {
  await db.clear('photos');
}
