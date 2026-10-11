// Eigene SVG-Karte: Straßen als Linien, Hausnummern, Ziel, Zufahrt, Postauto. Keine
// Kacheln, daher komplett offline. Verschieben, Zoomen (zwei Finger), langes Tippen.
//
// Zwei Ansichten: "Fahrtrichtung oben" (gedreht, leicht geneigt) und "Norden oben".
// Die Knöpfe liegen in einer eigenen Leiste unter der Karte und verdecken nichts.

import { makeProjection, distanceM, normHouseNumber } from './core';
import { AHEAD_MAX, LABEL_NEAR_CAR, edgePoint, followAhead, forcedLabels } from './maplabels';
import type { HouseNumber, Index, Street } from './types';
import type { Fix } from './gps';

const NS = 'http://www.w3.org/2000/svg';
/** Neigung: Oberkante erscheint um diesen Anteil verkleinert (perspektivisch). */
const TILT = 0.35;
const MODE_KEY = 'hnf-map-mode';

export type MapMode = 'heading' | 'north';

export interface MapTarget {
  lat: number;
  lon: number;
  label: string;
  estimated: boolean;
}

export interface MapDriveway {
  line: [number, number][];
  user: boolean;
}

export interface MapData {
  index: Index | null;
  focus: Street | null;
  target: MapTarget | null;
  neighbors: HouseNumber[];
  user: Fix | null;
  draft: [number, number][] | null;
  driveway: MapDriveway | null;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

function loadMode(): MapMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'north' ? 'north' : 'heading';
  } catch {
    return 'heading';
  }
}

export class MapView {
  readonly root: HTMLDivElement;
  private canvas: HTMLDivElement;
  private svg: SVGSVGElement;
  private proj = makeProjection(53.3, 10.2);
  private originSet = false;
  private cx = 0;
  private cy = 0;
  private scale = 2.5; // Pixel pro Meter
  private rot = 0; // Kartendrehung in Grad (Fahrtrichtung oben)
  private mode: MapMode = loadMode();
  private auto = true;
  private following = false;
  private prevScale = 2.5;
  private raf = 0;
  private data: MapData = { index: null, focus: null, target: null, neighbors: [], user: null, draft: null, driveway: null };
  private pointers = new Map<number, { x: number; y: number }>();
  private press: { x: number; y: number; t: number; timer: number; moved: boolean; fired: boolean } | null = null;
  private pinch: { d: number; mx: number; my: number } | null = null;
  private centerBtn: HTMLButtonElement;
  private modeBtn: HTMLButtonElement;
  private scaleEl: HTMLSpanElement;
  onLongPress: ((lat: number, lon: number) => void) | null = null;
  onTap: ((lat: number, lon: number) => void) | null = null;

  constructor(opts: { allowHeading?: boolean } = {}) {
    if (opts.allowHeading === false) this.mode = 'north';
    this.root = document.createElement('div');
    this.root.className = 'map';
    this.canvas = document.createElement('div');
    this.canvas.className = 'map-canvas';
    this.svg = el('svg', { class: 'map-svg' }) as SVGSVGElement;
    this.canvas.appendChild(this.svg);
    this.root.appendChild(this.canvas);

    const bar = document.createElement('div');
    bar.className = 'map-bar';
    const btn = (label: string, title: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      bar.appendChild(b);
      return b;
    };
    btn('−', 'Verkleinern', () => this.zoom(1 / 1.6));
    btn('+', 'Vergrößern', () => this.zoom(1.6));
    this.centerBtn = btn('◎', 'Ziel und Position zeigen', () => {
      this.auto = true;
      this.autoFit();
      this.schedule();
    });
    this.modeBtn = btn('', 'Kartenausrichtung umschalten', () => this.setMode(this.mode === 'heading' ? 'north' : 'heading'));
    this.modeBtn.classList.add('mode');
    if (opts.allowHeading === false) this.modeBtn.hidden = true;
    const info = document.createElement('div');
    info.className = 'map-info';
    this.scaleEl = document.createElement('span');
    this.scaleEl.className = 'map-scale';
    const attr = document.createElement('span');
    attr.className = 'map-attr';
    attr.textContent = '© OpenStreetMap';
    info.append(this.scaleEl, attr);
    bar.appendChild(info);
    this.root.appendChild(bar);
    this.updateModeBtn();

    this.svg.addEventListener('pointerdown', (e) => this.down(e));
    this.svg.addEventListener('pointermove', (e) => this.move(e));
    this.svg.addEventListener('pointerup', (e) => this.up(e));
    this.svg.addEventListener('pointercancel', (e) => this.up(e, true));
    this.svg.addEventListener('contextmenu', (e) => e.preventDefault());
    this.svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom(e.deltaY < 0 ? 1.25 : 0.8, e.offsetX, e.offsetY);
      },
      { passive: false },
    );
    new ResizeObserver(() => {
      if (this.auto) this.autoFit();
      this.schedule();
    }).observe(this.canvas);
  }

  setMode(mode: MapMode) {
    this.mode = mode;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* egal */
    }
    this.updateRotation();
    this.updateModeBtn();
    if (this.auto) this.autoFit();
    this.schedule();
  }

  private updateModeBtn() {
    this.modeBtn.textContent = this.mode === 'heading' ? '▲ Fahrt' : 'N ↑';
    this.modeBtn.title = this.mode === 'heading' ? 'Fahrtrichtung oben – tippen für Norden oben' : 'Norden oben – tippen für Fahrtrichtung oben';
  }

  private get tilted() {
    return this.mode === 'heading';
  }

  private updateRotation() {
    const h = this.data.user?.heading;
    if (this.mode === 'north') this.rot = 0;
    else if (h !== null && h !== undefined && Number.isFinite(h)) this.rot = h;
  }

  update(partial: Partial<MapData>) {
    const targetChanged = partial.target !== undefined && partial.target !== this.data.target;
    Object.assign(this.data, partial);
    if (targetChanged && this.data.target) {
      this.setOrigin(this.data.target.lat, this.data.target.lon);
      this.auto = true;
    } else if (!this.originSet && this.data.user) {
      this.setOrigin(this.data.user.lat, this.data.user.lon);
    } else if (!this.originSet && this.data.focus?.bbox) {
      const b = this.data.focus.bbox;
      this.setOrigin((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
    }
    this.updateRotation();
    if (this.auto) this.autoFit();
    this.schedule();
  }

  /** Karte auf einen Punkt setzen (z. B. für neue Straße). */
  centerOn(lat: number, lon: number, scale = 2) {
    this.setOrigin(lat, lon);
    this.cx = 0;
    this.cy = 0;
    this.scale = scale;
    this.auto = false;
    this.schedule();
  }

  private setOrigin(lat: number, lon: number) {
    // Ansicht beibehalten, nur Bezugspunkt wechseln
    const [clat, clon] = this.originSet ? this.proj.toLatLon(this.cx, this.cy) : [lat, lon];
    this.originSet = true;
    this.proj = makeProjection(lat, lon);
    [this.cx, this.cy] = this.proj.toXY(clat, clon);
  }

  private size() {
    return { w: this.canvas.clientWidth || 300, h: this.canvas.clientHeight || 300 };
  }

  // ---------- Projektion: Welt (m) <-> Bildschirm (px) ----------

  private worldToScreen(x: number, y: number): [number, number] {
    const { w, h } = this.size();
    const r = (this.rot * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const dx = x - this.cx;
    const dy = y - this.cy;
    const u = dx * c - dy * s;
    const v = dx * s + dy * c;
    const px = w / 2 + u * this.scale;
    const py = h / 2 - v * this.scale;
    if (!this.tilted) return [px, py];
    // Perspektive: je weiter oben (voraus), desto kleiner; unterer Rand unverändert
    const q0 = h - py;
    const f = Math.max(0.15, 1 + (q0 * TILT) / h);
    return [w / 2 + (px - w / 2) / f, h - q0 / f];
  }

  private screenToWorld(sx: number, sy: number): [number, number] {
    const { w, h } = this.size();
    let px = sx;
    let py = sy;
    if (this.tilted) {
      const t = TILT / h;
      const q = h - sy;
      const q0 = q / Math.max(0.05, 1 - q * t);
      const f = Math.max(0.15, 1 + q0 * t);
      px = w / 2 + (sx - w / 2) * f;
      py = h - q0;
    }
    const u = (px - w / 2) / this.scale;
    const v = (h / 2 - py) / this.scale;
    const r = (this.rot * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [this.cx + u * c + v * s, this.cy - u * s + v * c];
  }

  private screenToLatLon(sx: number, sy: number): [number, number] {
    const [x, y] = this.screenToWorld(sx, sy);
    return this.proj.toLatLon(x, y);
  }

  /** Verschiebt die Ansicht so, dass Weltpunkt (wx, wy) am Bildschirmpunkt (sx, sy) liegt. */
  private pin(wx: number, wy: number, sx: number, sy: number) {
    const [ax, ay] = this.screenToWorld(sx, sy);
    this.cx += wx - ax;
    this.cy += wy - ay;
  }

  /**
   * Automatische Ansicht.
   * Mit GPS (Folgemodus): Auto im unteren Drittel, höchstens ~120 m voraus, beim Annähern
   * enger. Haus und Einfahrt im Nahbereich bleiben immer im Bild; weiter entfernte Ziele
   * zeigt ein Pfeil am Rand (siehe render), statt herauszuzoomen.
   * Ohne GPS: etwa 160 m um das Ziel.
   */
  private autoFit() {
    const { target, user, focus, driveway } = this.data;
    const { w, h } = this.size();
    const T = target ? this.proj.toXY(target.lat, target.lon) : null;
    const J = driveway?.line.length ? this.proj.toXY(driveway.line[0][0], driveway.line[0][1]) : null;
    if (user && (T || focus)) {
      const U = this.proj.toXY(user.lat, user.lon);
      const dist = T ? Math.hypot(T[0] - U[0], T[1] - U[1]) : Infinity;
      // Fahrtrichtung oben: Auto im unteren Drittel. Norden oben: Auto in der Mitte,
      // dann reicht die Sicht in jede Richtung etwa "ahead" Meter.
      const userY = this.tilted ? h * 0.75 : h * 0.5;
      // Maßstab so, dass vom Auto bis zum oberen Rand "ahead" Meter liegen
      this.scale = 1;
      this.pin(U[0], U[1], w / 2, userY);
      const top = this.screenToWorld(w / 2, 0);
      const span = Math.hypot(top[0] - U[0], top[1] - U[1]);
      const wanted = Math.min(12, Math.max(0.3, span / followAhead(dist)));
      // Sanft annähern, damit die Karte beim Fahren nicht springt
      this.scale = this.following ? this.prevScale + (wanted - this.prevScale) * 0.5 : wanted;
      this.pin(U[0], U[1], w / 2, userY);
      // Nahbereich: Haus (auch in zweiter Reihe) und Einfahrt müssen sichtbar sein
      const must = [T, J].filter((p): p is [number, number] => !!p && Math.hypot(p[0] - U[0], p[1] - U[1]) <= AHEAD_MAX + 40);
      const m = 30;
      for (let i = 0; i < 25; i++) {
        const out = must.some(([x, y]) => {
          const [sx, sy] = this.worldToScreen(x, y);
          return sx < m || sx > w - m || sy < m || sy > h - m;
        });
        if (!out) break;
        this.scale *= 0.88;
        this.pin(U[0], U[1], w / 2, userY);
      }
      this.following = true;
      this.prevScale = this.scale;
      return;
    }
    this.following = false;
    const P = T ?? J ?? (focus?.bbox ? this.proj.toXY((focus.bbox[0] + focus.bbox[2]) / 2, (focus.bbox[1] + focus.bbox[3]) / 2) : null);
    if (!P) return;
    this.scale = Math.min(4, Math.min(w, h) / 160);
    this.pin(P[0], P[1], w / 2, h / 2);
  }

  private zoom(f: number, sx?: number, sy?: number) {
    const { w, h } = this.size();
    const px = sx ?? w / 2;
    const py = sy ?? h / 2;
    const [wx, wy] = this.screenToWorld(px, py);
    this.scale = Math.min(12, Math.max(0.02, this.scale * f));
    this.pin(wx, wy, px, py);
    this.auto = false;
    this.schedule();
  }

  private local(e: PointerEvent) {
    const r = this.svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private down(e: PointerEvent) {
    this.svg.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      const timer = window.setTimeout(() => {
        if (this.press && !this.press.moved && this.onLongPress) {
          this.press.fired = true;
          navigator.vibrate?.(40);
          const [lat, lon] = this.screenToLatLon(this.press.x, this.press.y);
          this.onLongPress(lat, lon);
        }
      }, 600);
      this.press = { x: p.x, y: p.y, t: Date.now(), timer, moved: false, fired: false };
    } else {
      this.cancelPress();
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    }
  }

  private cancelPress() {
    if (this.press) {
      clearTimeout(this.press.timer);
      this.press.moved = true;
    }
  }

  private move(e: PointerEvent) {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      if (this.press && Math.hypot(p.x - this.press.x, p.y - this.press.y) > 10) this.cancelPress();
      if (this.press?.moved) {
        const [wx, wy] = this.screenToWorld(prev.x, prev.y);
        this.pin(wx, wy, p.x, p.y);
        this.auto = false;
        this.schedule();
      }
    } else if (this.pointers.size === 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch.d > 0) this.zoom(d / this.pinch.d, this.pinch.mx, this.pinch.my);
      this.pinch.d = d;
    }
  }

  private up(e: PointerEvent, cancelled = false) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    const pr = this.press;
    if (pr && this.pointers.size === 0) {
      clearTimeout(pr.timer);
      if (!cancelled && !pr.moved && !pr.fired && Date.now() - pr.t < 500 && this.onTap) {
        const [lat, lon] = this.screenToLatLon(pr.x, pr.y);
        this.onTap(lat, lon);
      }
      this.press = null;
    }
  }

  private schedule() {
    if (!this.raf)
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.render();
      });
  }

  private render() {
    const { w, h } = this.size();
    const svg = this.svg;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.replaceChildren();
    this.centerBtn.classList.toggle('active', !this.auto);
    const S = this.scale;
    const toS = (lat: number, lon: number): [number, number] => {
      const [x, y] = this.proj.toXY(lat, lon);
      return this.worldToScreen(x, y);
    };
    const visible = (x: number, y: number, pad = 20) => x > -pad && x < w + pad && y > -pad && y < h + pad;
    // Beschriftungen ohne Überlappung: belegte Rechtecke merken, Überlappendes weglassen
    const placed: number[][] = [];
    const reserve = (x0: number, y0: number, x1: number, y1: number) => placed.push([x0, y0, x1, y1]);
    const hits = (list: number[][], x0: number, y0: number, x1: number, y1: number) =>
      list.some((b) => x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]);
    const free = (x0: number, y0: number, x1: number, y1: number) => !hits(placed, x0, y0, x1, y1);
    const textBox = (x: number, y: number, text: string, size: number, anchor: 'start' | 'middle') => {
      const tw = text.length * size * 0.6;
      const x0 = anchor === 'middle' ? x - tw / 2 : x;
      return [x0 - 2, y - size, x0 + tw + 2, y + 3] as const;
    };
    // Sichtbarer Bereich in Grad (für Straßen-Auswahl)
    const corners = [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
      [w / 2, 0],
    ].map(([sx, sy]) => this.screenToLatLon(sx, sy));
    const south = Math.min(...corners.map((c) => c[0])) - 0.001;
    const north = Math.max(...corners.map((c) => c[0])) + 0.001;
    const west = Math.min(...corners.map((c) => c[1])) - 0.0015;
    const east = Math.max(...corners.map((c) => c[1])) + 0.0015;
    const { index, focus, target, neighbors, user, draft, driveway } = this.data;

    // Vorrang: Ziel, Einfahrt, Nachbarn, Postauto – Beschriftungen weichen ihnen aus
    if (target) {
      const [x, y] = toS(target.lat, target.lon);
      reserve(x - 24, y - 24, x + 24, y + 24);
    }
    if (driveway?.line.length) {
      const [x, y] = toS(driveway.line[0][0], driveway.line[0][1]);
      reserve(x - 17, y - 17, x + 17, y + 17);
    }
    for (const n of neighbors) {
      const [x, y] = toS(n.lat, n.lon);
      reserve(x - 13, y - 34, x + 13, y + 13);
    }
    if (user) {
      const [x, y] = toS(user.lat, user.lon);
      reserve(x - 18, y - 30, x + 18, y + 18);
    }

    const gStreets = el('g', {}, svg);
    const gLabels = el('g', { class: 'labels' }, svg);
    const streetW = Math.max(3, Math.min(14, 7 * S));
    const pathOf = (line: [number, number][]) =>
      line
        .map(([la, lo], i) => {
          const [x, y] = toS(la, lo);
          return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join('');

    const streetLabels: Street[] = [];
    if (index) {
      for (const s of index.streets.values()) {
        if (s === focus || !s.bbox) continue;
        const [y0, x0, y1, x1] = s.bbox;
        if (y1 < south || y0 > north || x1 < west || x0 > east) continue;
        for (const line of s.lines) el('path', { d: pathOf(line), class: 'st', 'stroke-width': streetW }, gStreets);
        // Straßennamen erst nach den Hausnummern platzieren (Hausnummern haben Vorrang)
        if (S > 0.6 && s.lines.length) streetLabels.push(s);
      }
    }
    if (focus) {
      for (const line of focus.lines) el('path', { d: pathOf(line), class: 'st-focus', 'stroke-width': streetW + 4 }, gStreets);
      if (!focus.lines.length && focus.start) {
        const [x, y] = toS(focus.start[0], focus.start[1]);
        el('circle', { cx: x, cy: y, r: 8, class: 'st-start' }, gStreets);
      }
    }
    // Zufahrt zum Haus mit markierter Abzweigung
    if (driveway && driveway.line.length >= 2) {
      el('path', { d: pathOf(driveway.line), class: 'drive' + (driveway.user ? ' drive-user' : ''), 'stroke-width': Math.max(4, streetW * 0.7) }, svg);
    }
    const forced = focus && target ? forcedLabels(focus.numbers, target.label) : new Set<HouseNumber>();
    if (focus) {
      // Ausgedünnt: Ziel + je 3 Nachbarn immer, sonst nur Punkte; im Umkreis von 40 m
      // um das Auto alle sichtbaren Nummern (ohne Überlappung).
      const gDots = el('g', {}, svg);
      const gNum = el('g', {}, svg);
      // Rechts vom Punkt, sonst links. Pflicht-Beschriftungen weichen nur Ziel/Einfahrt/Auto aus.
      const label = (n: HouseNumber, x: number, y: number, strong: boolean) => {
        const size = strong ? 20 : 18;
        const tw = n.label.length * size * 0.6;
        const spots = [
          { tx: x + 7, ty: y + 6, anchor: 'start', box: [x + 5, y + 6 - size, x + 9 + tw, y + 9] },
          { tx: x - 7, ty: y + 6, anchor: 'end', box: [x - 9 - tw, y + 6 - size, x - 5, y + 9] },
          { tx: x, ty: y - 8, anchor: 'middle', box: [x - tw / 2 - 2, y - 8 - size, x + tw / 2 + 2, y - 5] },
          { tx: x, ty: y + 8 + size, anchor: 'middle', box: [x - tw / 2 - 2, y + 6, x + tw / 2 + 2, y + 11 + size] },
        ];
        // Keine Überlappung mit anderen Beschriftungen. Pflicht-Nummern ohne freien Platz
        // erscheinen beim Heranzoomen (die Karte zoomt bei Annäherung von selbst).
        const spot = spots.find((p) => free(p.box[0], p.box[1], p.box[2], p.box[3]));
        if (!spot) return;
        reserve(spot.box[0], spot.box[1], spot.box[2], spot.box[3]);
        const t = el('text', { x: spot.tx, y: spot.ty, 'text-anchor': spot.anchor, class: `hn-label${strong ? ' hn-strong' : ''}${n.user ? ' hn-user' : ''}` }, gNum);
        t.textContent = n.label;
      };
      const targetNorm = target ? normHouseNumber(target.label) : '';
      const near: [HouseNumber, number, number][] = [];
      // Gebäude ohne Hausnummer als kleine Quadrate
      for (const [bl, bo] of focus.buildings ?? []) {
        const [x, y] = toS(bl, bo);
        if (!visible(x, y)) continue;
        el('rect', { x: x - 5, y: y - 5, width: 10, height: 10, class: 'bld' }, gDots);
        reserve(x - 6, y - 6, x + 6, y + 6);
      }
      for (const n of focus.numbers) {
        const [x, y] = toS(n.lat, n.lon);
        if (!visible(x, y)) continue;
        el('circle', { cx: x, cy: y, r: 4, class: n.user ? 'hn hn-user' : 'hn' }, gDots);
        if (n.norm === targetNorm) continue; // steht schon in der Zielmarkierung
        if (forced.has(n)) label(n, x, y, true);
        else if (user && distanceM(user.lat, user.lon, n.lat, n.lon) <= LABEL_NEAR_CAR) near.push([n, x, y]);
      }
      for (const [n, x, y] of near) label(n, x, y, false);
      // Auch unbeschriftete Hauspunkte freihalten
      for (const n of focus.numbers) {
        const [x, y] = toS(n.lat, n.lon);
        if (visible(x, y)) reserve(x - 6, y - 6, x + 6, y + 6);
      }
    }
    // Straßennamen: weichen entlang der Straße aus (Mitte, dann weiter außen, über/unter der
    // Linie) oder werden ausgeblendet. Nie über Hausnummern, Ziel, Einfahrt oder Auto.
    for (const n of neighbors) {
      const [x, y] = toS(n.lat, n.lon);
      reserve(x - 13, y - 36, x + 13, y + 13);
    }
    let labelCount = 0;
    for (const st of streetLabels) {
      if (labelCount >= 40) break;
      const longest = st.lines.reduce((a, l) => (l.length > a.length ? l : a));
      const sp = longest.map(([la, lo]) => toS(la, lo));
      const cum = [0];
      for (let i = 1; i < sp.length; i++) cum.push(cum[i - 1] + Math.hypot(sp[i][0] - sp[i - 1][0], sp[i][1] - sp[i - 1][1]));
      // Kandidaten nur auf dem sichtbaren Teil der Straße, von dessen Mitte nach außen
      const total = cum[cum.length - 1];
      const step = Math.max(20, total / 300);
      const cands: [number, number][] = [];
      for (let d = 0, i = 1; d <= total && sp.length > 1; d += step) {
        while (i < cum.length - 1 && cum[i] < d) i++;
        const t = Math.max(0, Math.min(1, (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)));
        const x = sp[i - 1][0] + (sp[i][0] - sp[i - 1][0]) * t;
        const y = sp[i - 1][1] + (sp[i][1] - sp[i - 1][1]) * t;
        if (x > 40 && x < w - 40 && y > 20 && y < h - 20) cands.push([x, y]);
      }
      const mid = Math.floor(cands.length / 2);
      const order = cands.map((_, k) => k).sort((p1, p2) => Math.abs(p1 - mid) - Math.abs(p2 - mid));
      let placedLabel = false;
      for (const k of order.slice(0, 24)) {
        const [x, y] = cands[k];
        for (const ty of [y - streetW, y + streetW + 15]) {
          const box = textBox(x, ty, st.name, 15, 'middle');
          if (box[0] < 0 || box[2] > w || !free(...box)) continue;
          reserve(...box);
          const t = el('text', { x, y: ty, class: 'st-label' }, gLabels);
          t.textContent = st.name;
          labelCount++;
          placedLabel = true;
          break;
        }
        if (placedLabel) break;
      }
    }
    for (const n of neighbors) {
      const [x, y] = toS(n.lat, n.lon);
      el('circle', { cx: x, cy: y, r: 11, class: 'nb' }, svg);
      if (forced.has(n)) continue; // schon beschriftet
      const t = el('text', { x, y: y - 16, class: 'nb-label' }, svg);
      t.textContent = n.label;
    }
    if (draft && draft.length) {
      el('path', { d: pathOf(draft), class: 'draft' }, svg);
      for (const [la, lo] of draft) {
        const [x, y] = toS(la, lo);
        el('circle', { cx: x, cy: y, r: 7, class: 'draft-pt' }, svg);
      }
    }
    if (driveway && driveway.line.length) {
      const [x, y] = toS(driveway.line[0][0], driveway.line[0][1]);
      const g = el('g', { transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` }, svg);
      el('circle', { r: 15, class: 'junction' }, g);
      const t = el('text', { y: 6, class: 'junction-label' }, g);
      t.textContent = 'E';
    }
    if (target) {
      const [x, y] = toS(target.lat, target.lon);
      if (target.estimated) el('circle', { cx: x, cy: y, r: 30, class: 'target-est' }, svg);
      el('circle', { cx: x, cy: y, r: 20, class: 'target' }, svg);
      const t = el('text', { x, y: y + 7, class: 'target-label' }, svg);
      t.textContent = target.label.length > 4 ? target.label.slice(0, 4) : target.label;
    }
    if (user) {
      const [x, y] = toS(user.lat, user.lon);
      const r = user.accuracy * S;
      if (r > 12 && !this.tilted) el('circle', { cx: x, cy: y, r, class: 'acc' }, svg);
      const g = el('g', { transform: `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${(user.heading ?? 0) - this.rot})` }, svg);
      if (user.heading === null) {
        el('circle', { r: 10, class: 'car-dot' }, g);
      } else {
        // Postauto von oben: gelber Kasten, Fahrtrichtung nach oben
        el('rect', { x: -10, y: -16, width: 20, height: 32, rx: 4, class: 'car' }, g);
        el('rect', { x: -7, y: -12, width: 14, height: 7, rx: 2, class: 'car-window' }, g);
        el('path', { d: 'M0 -30 L8 -20 L-8 -20 Z', class: 'car-arrow' }, g);
      }
    }
    // Ziel außerhalb der Ansicht: Pfeil am Rand mit Entfernung (Einfahrt zuerst, falls vorhanden)
    const inset = 34;
    const offscreen = (lat: number, lon: number) => {
      const [x, y] = toS(lat, lon);
      return !(x > 8 && x < w - 8 && y > 8 && y < h - 8);
    };
    let arrow: { lat: number; lon: number; text: string } | null = null;
    const J0 = driveway?.line[0];
    if (J0 && offscreen(J0[0], J0[1])) arrow = { lat: J0[0], lon: J0[1], text: 'E' };
    else if (target && offscreen(target.lat, target.lon)) arrow = { lat: target.lat, lon: target.lon, text: target.label };
    if (arrow) {
      const from = user ? toS(user.lat, user.lon) : ([w / 2, h / 2] as [number, number]);
      const ref = user ? this.proj.toXY(user.lat, user.lon) : this.screenToWorld(w / 2, h / 2);
      const [ax0, ay0] = this.proj.toXY(arrow.lat, arrow.lon);
      const r = (this.rot * Math.PI) / 180;
      const dx = ax0 - ref[0];
      const dy = ay0 - ref[1];
      const angle = (Math.atan2(dx * Math.cos(r) - dy * Math.sin(r), dx * Math.sin(r) + dy * Math.cos(r)) * 180) / Math.PI;
      const [px, py] = edgePoint(from, angle, w, h, inset);
      const dist = user ? distanceM(user.lat, user.lon, arrow.lat, arrow.lon) : null;
      const g = el('g', { class: 'edge-arrow', transform: `translate(${px.toFixed(1)} ${py.toFixed(1)})` }, svg);
      el('path', { d: 'M0 -22 L16 8 L0 0 L-16 8 Z', transform: `rotate(${angle.toFixed(1)})`, class: 'edge-arrow-head' }, g);
      const text = dist === null ? arrow.text : `${arrow.text} · ${dist >= 1000 ? (dist / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(dist / 5) * 5 + ' m'}`;
      // Beschriftung zur Kartenmitte hin versetzt, damit sie im Bild bleibt
      const a = (angle * Math.PI) / 180;
      const lx = Math.min(w - 70, Math.max(70, px - Math.sin(a) * 38));
      const ly = Math.min(h - 14, Math.max(28, py + Math.cos(a) * 38));
      const tw = text.length * 11 + 18;
      el('rect', { x: lx - px - tw / 2, y: ly - py - 20, width: tw, height: 30, rx: 15, class: 'edge-pill' }, g);
      const t = el('text', { x: lx - px, y: ly - py + 2, class: 'edge-label' }, g);
      t.textContent = text;
    }
    // Maßstab (am unteren Rand gemessen) als Balken in der Leiste
    const [ax, ay] = this.screenToWorld(w / 2 - 50, h - 2);
    const [bx, by] = this.screenToWorld(w / 2 + 50, h - 2);
    const pxPerM = 100 / Math.max(0.01, Math.hypot(bx - ax, by - ay));
    const meters = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].find((m) => m * pxPerM >= 40) ?? 10000;
    this.scaleEl.style.width = `${Math.round(meters * pxPerM)}px`;
    this.scaleEl.textContent = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
  }
}
