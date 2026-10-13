import type { KantenId, KnotenId, Strassennetz } from './types';

interface Nachbar {
  nach: KnotenId;
  kante: KantenId;
  km: number;
}

interface Baum {
  dist: Float64Array;
  /** Vorgängerknoten auf dem kürzesten Weg, -1 = keiner */
  vor: Int32Array;
}

/**
 * Kürzeste Wege im Straßennetz (Dijkstra, ungerichtet).
 * Gesperrte Kanten werden übersprungen. Ergebnisse werden je Startknoten zwischengespeichert.
 */
export class Wegenetz {
  readonly netz: Strassennetz;
  readonly gesperrt: ReadonlySet<KantenId>;
  private readonly adj: Nachbar[][];
  private readonly baeume = new Map<KnotenId, Baum>();

  constructor(netz: Strassennetz, gesperrt: Iterable<KantenId> = []) {
    this.netz = netz;
    this.gesperrt = new Set(gesperrt);
    this.adj = netz.knoten.map(() => []);
    for (const k of netz.kanten) {
      if (this.gesperrt.has(k.id)) continue;
      this.adj[k.a].push({ nach: k.b, kante: k.id, km: k.laengeKm });
      this.adj[k.b].push({ nach: k.a, kante: k.id, km: k.laengeKm });
    }
  }

  /**
   * Länge des kürzesten Weges in km (Infinity, wenn nicht erreichbar).
   * Immer vom kleineren Knoten aus gerechnet, damit das Ergebnis nicht davon abhängt,
   * welche Bäume schon im Zwischenspeicher liegen (Rundungsreste → Determinismus).
   */
  distanz(von: KnotenId, nach: KnotenId): number {
    if (von === nach) return 0;
    return von < nach ? this.baum(von).dist[nach] : this.baum(nach).dist[von];
  }

  /** Knotenfolge des kürzesten Weges, inklusive Start und Ziel ([] wenn nicht erreichbar) */
  pfad(von: KnotenId, nach: KnotenId): KnotenId[] {
    if (von === nach) return [von];
    const b = this.baum(von);
    if (!Number.isFinite(b.dist[nach])) return [];
    const weg: KnotenId[] = [];
    for (let k = nach; k !== -1; k = b.vor[k]) weg.push(k);
    return weg.reverse();
  }

  /** Kante zwischen zwei benachbarten Knoten (kürzeste, falls mehrere) */
  kanteZwischen(a: KnotenId, b: KnotenId): KantenId | undefined {
    let beste: Nachbar | undefined;
    for (const n of this.adj[a]) if (n.nach === b && (!beste || n.km < beste.km)) beste = n;
    return beste?.kante;
  }

  private baum(quelle: KnotenId): Baum {
    const vorhanden = this.baeume.get(quelle);
    if (vorhanden) return vorhanden;
    const n = this.adj.length;
    const dist = new Float64Array(n).fill(Infinity);
    const vor = new Int32Array(n).fill(-1);
    dist[quelle] = 0;
    const heap = new MinHeap();
    heap.push(quelle, 0);
    while (heap.size > 0) {
      const [u, du] = heap.pop();
      if (du > dist[u]) continue;
      for (const { nach, km } of this.adj[u]) {
        const d = du + km;
        // Gleichstand: kleinerer Vorgänger gewinnt, damit Wege deterministisch sind
        if (d < dist[nach] - 1e-12 || (Math.abs(d - dist[nach]) <= 1e-12 && u < vor[nach])) {
          dist[nach] = d;
          vor[nach] = u;
          heap.push(nach, d);
        }
      }
    }
    const b = { dist, vor };
    this.baeume.set(quelle, b);
    return b;
  }
}

/** Binärer Min-Heap für Dijkstra */
class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(id: number, key: number): void {
    this.ids.push(id);
    this.keys.push(key);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.ids[0], this.keys[0]];
    const lastId = this.ids.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.ids.length > 0) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.ids.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.ids.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}

/** Länge eines Knotenweges in km (über die tatsächlichen Kanten) */
export function wegLaenge(netz: Strassennetz, weg: KnotenId[]): number {
  let km = 0;
  for (let i = 1; i < weg.length; i++) {
    const a = netz.knoten[weg[i - 1]];
    const b = netz.knoten[weg[i]];
    km += Math.hypot(a.x - b.x, a.y - b.y);
  }
  return km;
}
