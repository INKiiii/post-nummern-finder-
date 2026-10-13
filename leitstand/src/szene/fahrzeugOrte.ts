/**
 * Wo jedes Fahrzeug gerade gezeichnet wird (Szenen-Koordinaten, jedes Bild aktualisiert).
 * Die Kamera folgt diesem Punkt – auch an der Rampe und auf dem Hof.
 */
export const fahrzeugOrte = new Map<string, { x: number; z: number }>();
