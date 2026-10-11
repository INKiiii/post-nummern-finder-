// Eigene SVG-Karte: Straßen als Linien, Hausnummern, Ziel, Postauto. Keine Kacheln,
// daher komplett offline. Verschieben, Zoomen (zwei Finger), langes Tippen.

import { makeProjection } from './core';
import type { HouseNumber, Index, Street } from './types';
import type { Fix } from './gps';

const NS = 'http://www.w3.org/2000/svg';

export interface MapTarget {
  lat: number;
  lon: number;
  label: string;
  estimated: boolean;
}

export interface MapData {
  index: Index | null;
  focus: Street | null;
  target: MapTarget | null;
  neighbors: HouseNumber[];
  user: Fix | null;
  draft: [number, number][] | null;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

export class MapView {
  readonly root: HTMLDivElement;
  private svg: SVGSVGElement;
  private proj = makeProjection(53.3, 10.2);
  private originSet = false;
  private cx = 0;
  private cy = 0;
  private scale = 1.5; // Pixel pro Meter
  private auto = true;
  private raf = 0;
  private data: MapData = { index: null, focus: null, target: null, neighbors: [], user: null, draft: null };
  private pointers = new Map<number, { x: number; y: number }>();
  private press: { x: number; y: number; t: number; timer: number; moved: boolean; fired: boolean } | null = null;
  private pinch: { d: number; mx: number; my: number } | null = null;
  private centerBtn: HTMLButtonElement;
  onLongPress: ((lat: number, lon: number) => void) | null = null;
  onTap: ((lat: number, lon: number) => void) | null = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'map';
    this.svg = el('svg', { class: 'map-svg' }) as SVGSVGElement;
    this.root.appendChild(this.svg);
    const controls = document.createElement('div');
    controls.className = 'map-controls';
    const btn = (label: string, title: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      controls.appendChild(b);
      return b;
    };
    btn('+', 'Vergrößern', () => this.zoom(1.6));
    btn('−', 'Verkleinern', () => this.zoom(1 / 1.6));
    this.centerBtn = btn('◎', 'Ziel und Position zeigen', () => {
      this.auto = true;
      this.autoFit();
      this.schedule();
    });
    this.root.appendChild(controls);
    const attr = document.createElement('div');
    attr.className = 'map-attr';
    attr.textContent = '© OpenStreetMap-Mitwirkende';
    this.root.appendChild(attr);

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
    new ResizeObserver(() => this.schedule()).observe(this.root);
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

  /** Mittelpunkt der aktuellen Ansicht. */
  center(): [number, number] {
    return this.proj.toLatLon(this.cx, this.cy);
  }

  private setOrigin(lat: number, lon: number) {
    // Ansicht beibehalten, nur Bezugspunkt wechseln
    const [clat, clon] = this.originSet ? this.proj.toLatLon(this.cx, this.cy) : [lat, lon];
    this.originSet = true;
    this.proj = makeProjection(lat, lon);
    [this.cx, this.cy] = this.proj.toXY(clat, clon);
  }

  private size() {
    return { w: this.root.clientWidth || 300, h: this.root.clientHeight || 300 };
  }

  private autoFit() {
    const { target, user, focus } = this.data;
    const { w, h } = this.size();
    const pts: [number, number][] = [];
    if (target) pts.push([target.lat, target.lon]);
    if (user && (!target || Math.hypot(...this.proj.toXY(user.lat, user.lon)) < 2500)) pts.push([user.lat, user.lon]);
    if (!pts.length && focus?.bbox) {
      pts.push([focus.bbox[0], focus.bbox[1]], [focus.bbox[2], focus.bbox[3]]);
    }
    if (!pts.length) return;
    const xy = pts.map(([la, lo]) => this.proj.toXY(la, lo));
    const xs = xy.map((p) => p[0]);
    const ys = xy.map((p) => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    this.cx = (minX + maxX) / 2;
    this.cy = (minY + maxY) / 2;
    const span = Math.max((maxX - minX) / (w - 80), (maxY - minY) / (h - 80), 1 / 3);
    this.scale = Math.min(4, Math.max(0.05, 1 / span));
  }

  private zoom(f: number, sx?: number, sy?: number) {
    const { w, h } = this.size();
    const px = sx ?? w / 2;
    const py = sy ?? h / 2;
    const mx = this.cx + (px - w / 2) / this.scale;
    const my = this.cy - (py - h / 2) / this.scale;
    this.scale = Math.min(12, Math.max(0.02, this.scale * f));
    this.cx = mx - (px - w / 2) / this.scale;
    this.cy = my + (py - h / 2) / this.scale;
    this.auto = false;
    this.schedule();
  }

  private screenToLatLon(sx: number, sy: number): [number, number] {
    const { w, h } = this.size();
    return this.proj.toLatLon(this.cx + (sx - w / 2) / this.scale, this.cy - (sy - h / 2) / this.scale);
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
        this.cx -= (p.x - prev.x) / this.scale;
        this.cy += (p.y - prev.y) / this.scale;
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
    if (!this.raf) this.raf = requestAnimationFrame(() => {
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
      return [(x - this.cx) * S + w / 2, h / 2 - (y - this.cy) * S];
    };
    const [south, west] = this.screenToLatLon(-50, h + 50);
    const [north, east] = this.screenToLatLon(w + 50, -50);
    const { index, focus, target, neighbors, user, draft } = this.data;

    const gStreets = el('g', {}, svg);
    const gLabels = el('g', { class: 'labels' }, svg);
    const streetW = Math.max(3, Math.min(14, 7 * S));
    const pathOf = (line: [number, number][]) =>
      line.map(([la, lo], i) => {
        const [x, y] = toS(la, lo);
        return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join('');

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
          if (x > 0 && x < w && y > 0 && y < h) {
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
      const gNum = el('g', {}, svg);
      const showLabels = S > 0.9;
      for (const n of focus.numbers) {
        const [x, y] = toS(n.lat, n.lon);
        if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
        el('circle', { cx: x, cy: y, r: showLabels ? 4 : 3, class: n.user ? 'hn hn-user' : 'hn' }, gNum);
        if (showLabels) {
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
      if (r > 12) el('circle', { cx: x, cy: y, r, class: 'acc' }, svg);
      const g = el('g', { transform: `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${user.heading ?? 0})` }, svg);
      if (user.heading === null) {
        el('circle', { r: 10, class: 'car-dot' }, g);
      } else {
        // Postauto von oben: gelber Kasten, Fahrtrichtung nach oben
        el('rect', { x: -10, y: -16, width: 20, height: 32, rx: 4, class: 'car' }, g);
        el('rect', { x: -7, y: -12, width: 14, height: 7, rx: 2, class: 'car-window' }, g);
        el('path', { d: 'M0 -30 L8 -20 L-8 -20 Z', class: 'car-arrow' }, g);
      }
    }
    // Maßstab
    const meters = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((m) => m * S > 60) ?? 5000;
    const sb = el('g', { transform: `translate(12 ${h - 18})` }, svg);
    el('path', { d: `M0 0 H${meters * S}`, class: 'scale' }, sb);
    const st = el('text', { x: 0, y: -6, class: 'scale-label' }, sb);
    st.textContent = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
  }
}
