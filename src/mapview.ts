// Eigene SVG-Karte: Straßen als Linien, Hausnummern, Ziel, Zufahrt, Postauto. Keine
// Kacheln, daher komplett offline. Verschieben, Zoomen (zwei Finger), langes Tippen.
//
// Zwei Ansichten: "Fahrtrichtung oben" (gedreht, leicht geneigt) und "Norden oben".
// Die Knöpfe liegen in einer eigenen Leiste unter der Karte und verdecken nichts.

import { makeProjection } from './core';
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
   * Zeigt Ziel, eigene Position (bis 2,5 km) und Einfahrt. Nur das Ziel: etwa 160 m Ausschnitt.
   * Iterativ, weil die Neigung nicht linear ist.
   */
  private autoFit() {
    const { target, user, focus, driveway } = this.data;
    const { w, h } = this.size();
    const pts: [number, number][] = [];
    if (target) pts.push(this.proj.toXY(target.lat, target.lon));
    if (driveway?.line.length) pts.push(this.proj.toXY(driveway.line[0][0], driveway.line[0][1]));
    if (user && (!target || Math.hypot(...this.proj.toXY(user.lat, user.lon)) < 2500)) pts.push(this.proj.toXY(user.lat, user.lon));
    if (!pts.length && focus?.bbox) {
      pts.push(this.proj.toXY(focus.bbox[0], focus.bbox[1]), this.proj.toXY(focus.bbox[2], focus.bbox[3]));
    }
    if (!pts.length) return;
    const maxScale = 4;
    const singleScale = Math.min(w, h) / 160;
    const margin = { l: 50, r: 50, t: 60, b: 50 };
    if (pts.length === 1 || pts.every((p) => Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) < 30)) {
      this.scale = Math.min(maxScale, singleScale);
      this.cx = pts[0][0];
      this.cy = pts[0][1];
      // Im Fahrtrichtungs-Modus etwas unter der Mitte, damit voraus mehr Platz bleibt
      this.pin(pts[0][0], pts[0][1], w / 2, this.tilted ? h * 0.6 : h / 2);
      return;
    }
    this.cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    this.cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    for (let i = 0; i < 30; i++) {
      const sp = pts.map(([x, y]) => this.worldToScreen(x, y));
      const minX = Math.min(...sp.map((p) => p[0]));
      const maxX = Math.max(...sp.map((p) => p[0]));
      const minY = Math.min(...sp.map((p) => p[1]));
      const maxY = Math.max(...sp.map((p) => p[1]));
      // Mitte der Punkte in die Mitte des freien Bereichs schieben
      const [wx, wy] = this.screenToWorld((minX + maxX) / 2, (minY + maxY) / 2);
      this.pin(wx, wy, (margin.l + w - margin.r) / 2, (margin.t + h - margin.b) / 2);
      const availW = w - margin.l - margin.r;
      const availH = h - margin.t - margin.b;
      const bw = maxX - minX;
      const bh = maxY - minY;
      if (bw > availW || bh > availH) this.scale *= 0.85;
      else if (bw < availW * 0.7 && bh < availH * 0.7 && this.scale < maxScale) this.scale = Math.min(maxScale, this.scale * 1.15);
      else break;
      this.scale = Math.max(0.03, this.scale);
    }
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
    const free = (x0: number, y0: number, x1: number, y1: number) =>
      !placed.some((b) => x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]);
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

    // Vorrang: Ziel, Einfahrt, Nachbarn, Postauto
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

    let labelCount = 0;
    if (index) {
      for (const s of index.streets.values()) {
        if (s === focus || !s.bbox) continue;
        const [y0, x0, y1, x1] = s.bbox;
        if (y1 < south || y0 > north || x1 < west || x0 > east) continue;
        for (const line of s.lines) el('path', { d: pathOf(line), class: 'st', 'stroke-width': streetW }, gStreets);
        if (S > 0.6 && labelCount < 40 && s.lines.length) {
          const longest = s.lines.reduce((a, l) => (l.length > a.length ? l : a));
          const mid = longest[Math.floor(longest.length / 2)];
          const [x, y] = toS(mid[0], mid[1]);
          const box = textBox(x, y - streetW, s.name, 13, 'middle');
          if (visible(x, y, -10) && free(...box)) {
            reserve(...box);
            const t = el('text', { x, y: y - streetW, class: 'st-label' }, gLabels);
            t.textContent = s.name;
            labelCount++;
          }
        }
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
    if (focus) {
      const gNum = el('g', {}, svg);
      const showLabels = S > 0.9;
      for (const n of focus.numbers) {
        const [x, y] = toS(n.lat, n.lon);
        if (!visible(x, y)) continue;
        el('circle', { cx: x, cy: y, r: showLabels ? 4 : 3, class: n.user ? 'hn hn-user' : 'hn' }, gNum);
        const box = textBox(x + 6, y + 5, n.label, 15, 'start');
        if (showLabels && free(...box)) {
          reserve(...box);
          const t = el('text', { x: x + 6, y: y + 5, class: n.user ? 'hn-label hn-user' : 'hn-label' }, gNum);
          t.textContent = n.label;
        }
      }
    }
    for (const n of neighbors) {
      const [x, y] = toS(n.lat, n.lon);
      el('circle', { cx: x, cy: y, r: 11, class: 'nb' }, svg);
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
    // Maßstab (am unteren Rand gemessen) als Balken in der Leiste
    const [ax, ay] = this.screenToWorld(w / 2 - 50, h - 2);
    const [bx, by] = this.screenToWorld(w / 2 + 50, h - 2);
    const pxPerM = 100 / Math.max(0.01, Math.hypot(bx - ax, by - ay));
    const meters = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].find((m) => m * pxPerM >= 40) ?? 10000;
    this.scaleEl.style.width = `${Math.round(meters * pxPerM)}px`;
    this.scaleEl.textContent = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
  }
}
