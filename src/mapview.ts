// Eigene SVG-Karte: Straßen als Linien, dünne Gebäudeumrisse, Hausnummern, Ziel, Zufahrt,
// Fahrzeug. Keine Kacheln, daher komplett offline. Verschieben, Zoomen (zwei Finger),
// langes Tippen.
//
// Live-Karte: Fahrtrichtung oben (leicht geneigt), Fahrzeug im unteren Drittel, feste
// Zoomstufe (gemerkt). Keine Animationen; die Karte folgt nur dem (geglätteten) Straßenbezug.

import { makeProjection, distanceM, normHouseNumber } from './core';
import { AHEAD_LEVELS, CAR_Y, DEFAULT_LEVEL, NUMBER_FONT, NUMBER_FONT_SMALL, edgePoint, groupSameHouse, joinHouseLabels, labelOrder } from './maplabels';
import type { HouseNumber, Index, Street } from './types';
import type { Fix } from './gps';

const NS = 'http://www.w3.org/2000/svg';
/** Neigung: Oberkante erscheint um diesen Anteil verkleinert (perspektivisch). */
const TILT = 0.3;
const MODE_KEY = 'hnf-map-mode';
const LEVEL_KEY = 'hnf-map-level';

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

/** Fahrzeug, wie es angezeigt wird (auf die Straße bezogen) */
export interface MapCar {
  pos: [number, number];
  /** Fahrtrichtung in Grad oder null (unbekannt) */
  bearing: number | null;
  accuracy: number;
}

export interface MapData {
  index: Index | null;
  /** Hervorgehobene Straße (Ziel- bzw. aktuelle Straße) */
  focus: Street | null;
  /** Tour-Straßen: etwas stärker gezeichnet */
  emphasis: Set<string>;
  target: MapTarget | null;
  neighbors: HouseNumber[];
  /** Rohes GPS (für Karten ohne Straßenbezug, z. B. Straße zeichnen) */
  user: Fix | null;
  car: MapCar | null;
  draft: [number, number][] | null;
  driveway: MapDriveway | null;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* egal */
  }
}

export function savedMapMode(): MapMode {
  return load(MODE_KEY) === 'north' ? 'north' : 'heading';
}
export function setSavedMapMode(m: MapMode) {
  save(MODE_KEY, m);
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
  private mode: MapMode = savedMapMode();
  private live: boolean;
  private level = DEFAULT_LEVEL;
  /** true: Karte folgt dem Fahrzeug bzw. zeigt das Ziel; false: von Hand verschoben */
  private auto = true;
  private raf = 0;
  private data: MapData = {
    index: null,
    focus: null,
    emphasis: new Set(),
    target: null,
    neighbors: [],
    user: null,
    car: null,
    draft: null,
    driveway: null,
  };
  private pointers = new Map<number, { x: number; y: number }>();
  private press: { x: number; y: number; t: number; timer: number; moved: boolean; fired: boolean } | null = null;
  private pinch: { d: number; mx: number; my: number } | null = null;
  private centerBtn: HTMLButtonElement | null = null;
  private modeBtn: HTMLButtonElement | null = null;
  private scaleEl: HTMLSpanElement;
  private corner: HTMLDivElement | null = null;
  /** Knöpfe auf der Karte (Live); Beschriftungen weichen ihnen aus */
  readonly controls: HTMLDivElement;
  private lastKey = '';
  onLongPress: ((lat: number, lon: number) => void) | null = null;
  onTap: ((lat: number, lon: number) => void) | null = null;
  /** Meldet, ob die Karte gerade dem Fahrzeug folgt (für „Zurück zur Position“). */
  onFollowChange: ((following: boolean) => void) | null = null;

  /**
   * @param opts.live Live-Karte: folgt dem Fahrzeug mit gemerkter Zoomstufe, Knöpfe liefert der Bildschirm
   * @param opts.allowHeading false: immer Norden oben (z. B. Straße zeichnen)
   */
  constructor(opts: { allowHeading?: boolean; live?: boolean } = {}) {
    this.live = !!opts.live;
    if (opts.allowHeading === false) this.mode = 'north';
    const stored = load(LEVEL_KEY);
    const lv = stored === null ? NaN : Number(stored);
    if (Number.isInteger(lv) && lv >= 0 && lv < AHEAD_LEVELS.length) this.level = lv;
    this.root = document.createElement('div');
    this.root.className = 'map' + (this.live ? ' map-live' : '');
    this.canvas = document.createElement('div');
    this.canvas.className = 'map-canvas';
    this.svg = el('svg', { class: 'map-svg' }) as SVGSVGElement;
    this.canvas.appendChild(this.svg);
    this.root.appendChild(this.canvas);

    this.scaleEl = document.createElement('span');
    this.scaleEl.className = 'map-scale';
    const attr = document.createElement('span');
    attr.className = 'map-attr';
    attr.textContent = '© OpenStreetMap';
    this.controls = document.createElement('div');
    this.controls.className = 'map-ctrl';
    if (this.live) {
      // Maßstab und Quellenhinweis klein in der Ecke; Zoomknöpfe am rechten Rand.
      // Hausnummern werden nie unter diese Elemente gelegt (siehe render).
      const info = document.createElement('div');
      info.className = 'map-corner';
      info.append(this.scaleEl, attr);
      this.corner = info;
      this.canvas.append(info, this.controls);
    } else {
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
      this.centerBtn = btn('◎', 'Ziel und Position zeigen', () => this.recenter());
      this.modeBtn = btn('', 'Kartenausrichtung umschalten', () => this.setMode(this.mode === 'heading' ? 'north' : 'heading'));
      this.modeBtn.classList.add('mode');
      if (opts.allowHeading === false) this.modeBtn.hidden = true;
      const info = document.createElement('div');
      info.className = 'map-info';
      info.append(this.scaleEl, attr);
      bar.appendChild(info);
      this.root.appendChild(bar);
      this.updateModeBtn();
    }

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
    new ResizeObserver(() => this.schedule(true)).observe(this.canvas);
  }

  get following() {
    return this.auto;
  }

  setMode(mode: MapMode) {
    this.mode = mode;
    setSavedMapMode(mode);
    this.updateModeBtn();
    this.schedule(true);
  }

  getMode() {
    return this.mode;
  }

  /** Live-Zoom: eine Stufe näher (+1) oder weiter (-1); wird gemerkt. */
  zoomStep(delta: 1 | -1) {
    this.level = Math.max(0, Math.min(AHEAD_LEVELS.length - 1, this.level - delta));
    save(LEVEL_KEY, String(this.level));
    this.setAuto(true);
    this.schedule(true);
  }

  /** Sicht voraus der aktuellen Zoomstufe in Metern */
  get aheadMeters() {
    return AHEAD_LEVELS[this.level];
  }

  recenter() {
    this.setAuto(true);
    this.schedule(true);
  }

  private setAuto(v: boolean) {
    if (this.auto === v) return;
    this.auto = v;
    this.centerBtn?.classList.toggle('active', !v);
    this.onFollowChange?.(v);
  }

  private updateModeBtn() {
    if (!this.modeBtn) return;
    this.modeBtn.textContent = this.mode === 'heading' ? '▲ Fahrt' : 'N ↑';
    this.modeBtn.title = this.mode === 'heading' ? 'Fahrtrichtung oben – tippen für Norden oben' : 'Norden oben – tippen für Fahrtrichtung oben';
  }

  private get tilted() {
    return this.mode === 'heading' && this.live;
  }

  update(partial: Partial<MapData>) {
    const targetChanged = partial.target !== undefined && partial.target !== this.data.target;
    Object.assign(this.data, partial);
    const car = this.data.car;
    if (targetChanged && this.data.target && !car) {
      this.setOrigin(this.data.target.lat, this.data.target.lon);
      this.setAuto(true);
    } else if (!this.originSet && car) {
      this.setOrigin(car.pos[0], car.pos[1]);
    } else if (!this.originSet && this.data.user) {
      this.setOrigin(this.data.user.lat, this.data.user.lon);
    } else if (!this.originSet && this.data.focus?.bbox) {
      const b = this.data.focus.bbox;
      this.setOrigin((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
    }
    if (targetChanged && this.data.target) this.setAuto(true);
    this.schedule();
  }

  /** Karte auf einen Punkt setzen (z. B. für neue Straße). */
  centerOn(lat: number, lon: number, scale = 2) {
    this.setOrigin(lat, lon);
    this.cx = 0;
    this.cy = 0;
    this.scale = scale;
    this.setAuto(false);
    this.schedule(true);
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

  /** Position des Fahrzeugs (Anzeige) als lat/lon */
  private carPos(): [number, number] | null {
    if (this.data.car) return this.data.car.pos;
    if (this.data.user) return [this.data.user.lat, this.data.user.lon];
    return null;
  }

  /**
   * Automatischer Ausschnitt.
   * Live mit Fahrzeug: Fahrzeug im unteren Drittel, Sicht voraus nach Zoomstufe (Standard
   * 80 m, ~20 m zurück). Ein Haus in zweiter Reihe in der Nähe bleibt im Bild.
   * Sonst: etwa 160 m um das Ziel.
   */
  private autoFit() {
    const { target, driveway, focus } = this.data;
    const { w, h } = this.size();
    const car = this.carPos();
    // Ausrichtung
    if (this.mode === 'north') this.rot = 0;
    else {
      const b = this.data.car?.bearing ?? this.data.user?.heading ?? null;
      if (b !== null && Number.isFinite(b)) this.rot = b;
    }
    const T = target ? this.proj.toXY(target.lat, target.lon) : null;
    const J = driveway?.line.length ? this.proj.toXY(driveway.line[0][0], driveway.line[0][1]) : null;
    if (car && (this.live || T || focus)) {
      const U = this.proj.toXY(car[0], car[1]);
      const carY = this.tilted ? h * CAR_Y : h * 0.5;
      const ahead = this.live ? AHEAD_LEVELS[this.level] : 120;
      // Maßstab so, dass vom Fahrzeug bis zum oberen Rand "ahead" Meter liegen
      this.scale = 1;
      this.pin(U[0], U[1], w / 2, carY);
      const top = this.screenToWorld(w / 2, 0);
      const span = Math.hypot(top[0] - U[0], top[1] - U[1]);
      this.scale = Math.min(14, Math.max(0.05, span / ahead));
      this.pin(U[0], U[1], w / 2, carY);
      // Nahbereich: Haus (auch in zweiter Reihe) und Einfahrt sichtbar halten, solange sie
      // voraus oder neben dem Fahrzeug liegen. Erst seitlich verschieben (Fahrzeug aus der
      // Mitte), dann begrenzt herauszoomen; sonst zeigt ein Pfeil am Rand die Richtung.
      const base = this.scale;
      const must = [T, J].filter((p): p is [number, number] => {
        if (!p || Math.hypot(p[0] - U[0], p[1] - U[1]) > 120) return false;
        return this.worldToScreen(p[0], p[1])[1] <= carY + 20;
      });
      if (must.length) {
        const left = 40;
        const right = w - 95; // rechts liegen die Zoomknöpfe
        let shift = 0;
        for (const [x, y] of must) {
          const sx = this.worldToScreen(x, y)[0];
          if (sx > right) shift = Math.max(shift, sx - right);
          else if (sx < left) shift = Math.min(shift, sx - left);
        }
        shift = Math.max(-w * 0.3, Math.min(w * 0.3, shift));
        const carX = w / 2 - shift;
        this.pin(U[0], U[1], carX, carY);
        // Je näher, desto mehr darf herausgezoomt werden (stufenlos, kein Sprung): bei 120 m
        // gar nicht, ab 30 m bis auf die Hälfte.
        const dMin = Math.min(...must.map((p) => Math.hypot(p[0] - U[0], p[1] - U[1])));
        const lowest = base * (0.5 + 0.5 * Math.min(1, Math.max(0, (dMin - 30) / 90)));
        const m = 30;
        for (let i = 0; i < 20 && this.scale * 0.95 >= lowest; i++) {
          const out = must.some(([x, y]) => {
            const [sx, sy] = this.worldToScreen(x, y);
            return sx < left || sx > right || sy < m || sy > h - m;
          });
          if (!out) break;
          this.scale *= 0.95;
          this.pin(U[0], U[1], carX, carY);
        }
      }
      return;
    }
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
    this.scale = Math.min(14, Math.max(0.02, this.scale * f));
    this.pin(wx, wy, px, py);
    this.setAuto(false);
    this.schedule(true);
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
        this.setAuto(false);
        this.schedule(true);
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

  /** Neu zeichnen im nächsten Frame. force: auch wenn sich scheinbar nichts geändert hat. */
  private schedule(force = false) {
    if (force) this.lastKey = '';
    if (!this.raf)
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        if (this.auto) this.autoFit();
        // Akku schonen: nichts zeichnen, wenn sich Ansicht und Inhalt nicht geändert haben
        const { w, h } = this.size();
        const d = this.data;
        const key = [
          w,
          h,
          this.cx.toFixed(2),
          this.cy.toFixed(2),
          this.scale.toFixed(4),
          this.rot.toFixed(1),
          d.car?.pos.join(','),
          d.car?.bearing?.toFixed(1),
          d.car ? Math.round(d.car.accuracy) : '',
          d.user ? `${d.user.lat},${d.user.lon},${d.user.heading}` : '',
          d.target ? `${d.target.lat},${d.target.lon},${d.target.label}` : '',
          d.focus?.id,
          d.focus?.numbers.length,
          d.index?.streets.size,
          [...d.emphasis].join('|'),
          d.draft?.length,
          d.driveway?.line.flat().join(','),
          d.neighbors.length,
        ].join(';');
        if (key === this.lastKey) return;
        this.lastKey = key;
        this.render();
      });
  }

  /** Index-Inhalt geändert (z. B. eigener Punkt gesetzt): neu zeichnen. */
  refresh() {
    this.schedule(true);
  }

  /**
   * Schreibt den Straßennamen entlang eines möglichst geraden, sichtbaren Stücks der Straße.
   * Prüft Kollisionen über Stichproben entlang der Schrift. Gibt true zurück, wenn platziert.
   */
  private placeStreetLabel(
    st: Street,
    isFocus: boolean,
    toS: (lat: number, lon: number) => [number, number],
    w: number,
    h: number,
    free: (x0: number, y0: number, x1: number, y1: number) => boolean,
    reserve: (x0: number, y0: number, x1: number, y1: number) => void,
    parent: Element,
    size = 16,
  ): boolean {
    const tw = st.name.length * size * 0.58 + 6;
    const m = 8;
    const inside = (p: number[]) => p[0] > m && p[0] < w - m && p[1] > m && p[1] < h - m;
    type Cand = { cx: number; cy: number; ang: number; samples: number[][]; dist: number };
    const cands: Cand[] = [];
    for (const line of st.lines) {
      if (line.length < 2) continue;
      const sp = line.map(([la, lo]) => toS(la, lo));
      const cum = [0];
      for (let i = 1; i < sp.length; i++) cum.push(cum[i - 1] + Math.hypot(sp[i][0] - sp[i - 1][0], sp[i][1] - sp[i - 1][1]));
      const total = cum[cum.length - 1];
      if (total < tw + 4) continue;
      const at = (d: number) => {
        let i = 1;
        while (i < cum.length - 1 && cum[i] < d) i++;
        const t = Math.max(0, Math.min(1, (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)));
        return [sp[i - 1][0] + (sp[i][0] - sp[i - 1][0]) * t, sp[i - 1][1] + (sp[i][1] - sp[i - 1][1]) * t];
      };
      // Nur auf sichtbaren Abschnitten suchen (die ganze Straße kann sehr lang sein)
      const ds: number[] = [];
      const pad = tw;
      for (let i = 1; i < sp.length && ds.length < 400; i++) {
        const [x0, y0] = sp[i - 1];
        const [x1, y1] = sp[i];
        // Liang-Barsky: sichtbaren Teil [t0, t1] des Abschnitts bestimmen
        let t0 = 0;
        let t1 = 1;
        const dx = x1 - x0;
        const dy = y1 - y0;
        const clip = (p: number, q: number) => {
          if (p === 0) return q >= 0;
          const r = q / p;
          if (p < 0) {
            if (r > t1) return false;
            if (r > t0) t0 = r;
          } else {
            if (r < t0) return false;
            if (r < t1) t1 = r;
          }
          return true;
        };
        if (!(clip(-dx, x0 + pad) && clip(dx, w + pad - x0) && clip(-dy, y0 + pad) && clip(dy, h + pad - y0))) continue;
        const segLen = cum[i] - cum[i - 1];
        for (let d = cum[i - 1] + t0 * segLen; d <= cum[i - 1] + t1 * segLen && ds.length < 400; d += 12) ds.push(d);
      }
      for (const d of ds) {
        if (d < tw / 2 || d > total - tw / 2) continue;
        const A = at(d - tw / 2);
        const B = at(d + tw / 2);
        const P = at(d);
        if (!inside(A) || !inside(B)) continue;
        // Nur gerade Stücke: Mitte darf kaum von der Verbindung A–B abweichen
        const ab = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
        const off = Math.abs((B[0] - A[0]) * (A[1] - P[1]) - (A[0] - P[0]) * (B[1] - A[1])) / ab;
        if (off > 5 || ab < tw * 0.9) continue;
        let ang = (Math.atan2(B[1] - A[1], B[0] - A[0]) * 180) / Math.PI;
        if (ang > 90) ang -= 180;
        if (ang < -90) ang += 180;
        const cx = (A[0] + B[0]) / 2;
        const cy = (A[1] + B[1]) / 2;
        const samples: number[][] = [];
        const n = Math.max(2, Math.ceil(tw / 9));
        for (let k = 0; k <= n; k++) {
          const f = k / n;
          samples.push([A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f]);
        }
        cands.push({ cx, cy, ang, samples, dist: Math.hypot(cx - w / 2, cy - h / 2) });
      }
    }
    cands.sort((a, b) => a.dist - b.dist);
    for (const c of cands.slice(0, 80)) {
      const half = size * 0.55;
      if (!c.samples.every(([x, y]) => free(x - 5, y - half, x + 5, y + half))) continue;
      for (const [x, y] of c.samples) reserve(x - 5, y - half, x + 5, y + half);
      const t = el(
        'text',
        {
          x: c.cx,
          y: c.cy + size * 0.35,
          transform: `rotate(${c.ang.toFixed(1)} ${c.cx.toFixed(1)} ${c.cy.toFixed(1)})`,
          class: isFocus ? 'st-label st-label-focus' : 'st-label',
          style: `font-size:${size}px`,
        },
        parent,
      );
      t.textContent = st.name;
      return true;
    }
    return false;
  }

  private render() {
    const { w, h } = this.size();
    const svg = this.svg;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.replaceChildren();
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
    // Sichtbarer Bereich in Grad (für Straßen-Auswahl)
    const corners = [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
      [w / 2, 0],
    ].map(([sx, sy]) => this.screenToLatLon(sx, sy));
    const south = Math.min(...corners.map((c) => c[0])) - 0.0008;
    const north = Math.max(...corners.map((c) => c[0])) + 0.0008;
    const west = Math.min(...corners.map((c) => c[1])) - 0.0012;
    const east = Math.max(...corners.map((c) => c[1])) + 0.0012;
    const { index, focus, emphasis, target, neighbors, draft, driveway } = this.data;
    const carLL = this.carPos();
    const carS = carLL ? toS(carLL[0], carLL[1]) : null;

    // Vorrang: Ziel, Einfahrt, Nachbarn, Fahrzeug – Beschriftungen weichen ihnen aus
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
    if (carS) reserve(carS[0] - 16, carS[1] - 32, carS[0] + 16, carS[1] + 20);
    // Knöpfe und Maßstab auf der Karte freihalten
    const cr = this.canvas.getBoundingClientRect();
    for (const box of [this.controls, this.corner]) {
      if (!box || !box.childElementCount) continue;
      for (const c of box.children) {
        const r = (c as HTMLElement).getBoundingClientRect();
        if (r.width) reserve(r.left - cr.left - 6, r.top - cr.top - 6, r.right - cr.left + 6, r.bottom - cr.top + 6);
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
    let arrowDraw: (() => void) | null = null;
    if (arrow) {
      const from = carS ?? ([w / 2, h / 2] as [number, number]);
      const ref = carLL ? this.proj.toXY(carLL[0], carLL[1]) : this.screenToWorld(w / 2, h / 2);
      const [ax0, ay0] = this.proj.toXY(arrow.lat, arrow.lon);
      const r = (this.rot * Math.PI) / 180;
      const dx = ax0 - ref[0];
      const dy = ay0 - ref[1];
      const angle = (Math.atan2(dx * Math.cos(r) - dy * Math.sin(r), dx * Math.sin(r) + dy * Math.cos(r)) * 180) / Math.PI;
      const [px, py] = edgePoint(from, angle, w, h, inset);
      const dist = carLL ? distanceM(carLL[0], carLL[1], arrow.lat, arrow.lon) : null;
      // Platz für den Pfeil freihalten, bevor die Hausnummern verteilt werden
      const tw0 = (dist === null ? arrow.text : `${arrow.text} · 0000 m`).length * 11 + 18;
      reserve(px - 26, py - 26, px + 26, py + 26);
      {
        const a0 = (angle * Math.PI) / 180;
        const lx0 = Math.min(w - 70, Math.max(70, px - Math.sin(a0) * 38));
        const ly0 = Math.min(h - 14, Math.max(28, py + Math.cos(a0) * 38));
        reserve(lx0 - tw0 / 2, ly0 - 22, lx0 + tw0 / 2, ly0 + 12);
      }
      arrowDraw = () => {
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
      };
    }
    const gOutl = el('g', { class: 'outlines' }, svg);
    const gStreets = el('g', {}, svg);
    const streetW = Math.max(3, Math.min(12, 6 * S));
    const pathOf = (line: [number, number][]) =>
      line
        .map(([la, lo], i) => {
          const [x, y] = toS(la, lo);
          return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join('');

    // Sichtbare Straßen (alle geladenen Gebiete)
    const shown: Street[] = [];
    if (index) {
      for (const s of index.streets.values()) {
        if (!s.bbox) continue;
        const [y0, x0, y1, x1] = s.bbox;
        if (y1 < south || y0 > north || x1 < west || x0 > east) continue;
        shown.push(s);
      }
    }
    if (focus && !shown.includes(focus)) shown.push(focus);
    // Dünne Gebäudeumrisse (wenn im Paket enthalten); nur bei genügend Zoom
    if (S >= 1.2) {
      let verts = 0;
      for (const s of shown) {
        if (!s.outlines?.length) continue;
        let d = '';
        for (const o of s.outlines) {
          if (verts > 25000) break;
          const [fx, fy] = toS(o[0][0], o[0][1]);
          if (!visible(fx, fy, 80)) continue;
          verts += o.length;
          d += o.map(([la, lo], i) => {
            const [x, y] = toS(la, lo);
            return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
          }).join('') + 'Z';
        }
        if (d) el('path', { d, class: 'bld-outline' }, gOutl);
      }
    }
    // Straßenlinien: Tour-Straßen stärker, Ziel-/aktuelle Straße hervorgehoben
    const order = [...shown].sort((a, b) => rank(a) - rank(b));
    function rank(s: Street) {
      return s === focus ? 2 : emphasis.has(s.id) ? 1 : 0;
    }
    for (const s of order) {
      const r = rank(s);
      const cls = r === 2 ? 'st st-focus' : r === 1 ? 'st st-tour' : 'st';
      const sw = r === 2 ? streetW + 4 : r === 1 ? streetW + 2 : streetW;
      for (const line of s.lines) el('path', { d: pathOf(line), class: cls, 'stroke-width': sw }, gStreets);
      if (!s.lines.length && s.start && s === focus) {
        const [x, y] = toS(s.start[0], s.start[1]);
        el('circle', { cx: x, cy: y, r: 8, class: 'st-start' }, gStreets);
      }
    }
    // Zufahrt zum Haus mit markierter Abzweigung
    if (driveway && driveway.line.length >= 2) {
      el('path', { d: pathOf(driveway.line), class: 'drive' + (driveway.user ? ' drive-user' : ''), 'stroke-width': Math.max(4, streetW * 0.7) }, svg);
    }

    // ---------- Hausnummern: an jedem Haus, ohne Überlappung, nach Vorrang ----------
    // Die Nummer steht möglichst direkt auf dem Haus (statt Punkt + Nummer daneben): eindeutig
    // und platzsparend, so passen auch dicht stehende Häuser. Nur wenn das nicht geht, steht sie
    // neben dem Punkt. Nie über dem Punkt eines anderen Hauses (sonst ist sie nicht zuzuordnen).
    const gDots = el('g', {}, svg);
    const gNum = el('g', { class: 'numbers' }, svg);
    const targetNorm = target ? normHouseNumber(target.label) : '';
    type Haus = { n: HouseNumber; x: number; y: number; isFocus: boolean; label: boolean };
    const haeuser: { item: Haus; street: string; x: number; y: number }[] = [];
    let dots = 0;
    for (const s of shown) {
      for (const n of s.numbers) {
        if (dots > 1500) break;
        const [x, y] = toS(n.lat, n.lon);
        if (!visible(x, y)) continue;
        dots++;
        // Zielnummer steht schon in der Zielmarkierung
        const label = !(s === focus && targetNorm && n.norm === targetNorm);
        const [wx, wy] = this.proj.toXY(n.lat, n.lon);
        haeuser.push({ item: { n, x, y, isFocus: s === focus, label }, street: s.id, x: wx, y: wy });
      }
    }
    // Mehrere Nummern an einem Haus (5, 5a, 5b …): eine gemeinsame Beschriftung
    const gruppen = groupSameHouse(haeuser);
    // Hauspunkte mit Gruppe: eine Beschriftung darf nur die Punkte ihres eigenen Hauses verdecken
    const dotBoxes: { g: number; b: number[] }[] = [];
    gruppen.forEach((g, i) => g.forEach((h) => dotBoxes.push({ g: i, b: [h.x - 5, h.y - 5, h.x + 5, h.y + 5] })));
    const freeDots = (x0: number, y0: number, x1: number, y1: number, eigene = -1) =>
      !dotBoxes.some(({ g, b: d }) => g !== eigene && x0 < d[2] && x1 > d[0] && y0 < d[3] && y1 > d[1]);
    type Item = { gruppe: number; text: string; x: number; y: number; isFocus: boolean; est: boolean; user: boolean };
    const cands = gruppen.flatMap((g, i) => {
      const mit = g.filter((h) => h.label);
      if (!mit.length) return [];
      const it: Item = {
        gruppe: i,
        text: joinHouseLabels(mit.map((h) => (h.n.user ? `•${h.n.label}` : h.n.label))),
        x: g.reduce((a, h) => a + h.x, 0) / g.length,
        y: g.reduce((a, h) => a + h.y, 0) / g.length,
        isFocus: g[0].isFocus,
        est: mit.every((h) => h.n.source === 'osm-interp'),
        user: mit.some((h) => h.n.user),
      };
      return [{ item: it, x: it.x, y: it.y, primary: it.isFocus }];
    });
    const minZoomForAll = this.live ? 0.9 : 1.6;
    const ordered = labelOrder(cands, carS, [w / 2, h / 2]);
    /** Plätze: direkt auf dem Haus, sonst daneben (rechts, links, oben, unten, schräg oben) */
    const spots = (x: number, y: number, tw: number, size: number) => [
      { tx: x, ty: y + size * 0.36, anchor: 'middle', box: [x - tw / 2, y - size * 0.5, x + tw / 2, y + size * 0.5], auf: true },
      { tx: x + 7, ty: y + 7, anchor: 'start', box: [x + 5, y + 7 - size, x + 9 + tw, y + 10], auf: false },
      { tx: x - 7, ty: y + 7, anchor: 'end', box: [x - 9 - tw, y + 7 - size, x - 5, y + 10], auf: false },
      { tx: x, ty: y - 8, anchor: 'middle', box: [x - tw / 2 - 1, y - 8 - size, x + tw / 2 + 1, y - 5], auf: false },
      { tx: x, ty: y + 8 + size, anchor: 'middle', box: [x - tw / 2 - 1, y + 6, x + tw / 2 + 1, y + 11 + size], auf: false },
      { tx: x + 5, ty: y - 7, anchor: 'start', box: [x + 3, y - 7 - size, x + 7 + tw, y - 5], auf: false },
      { tx: x - 5, ty: y - 7, anchor: 'end', box: [x - 7 - tw, y - 7 - size, x - 3, y - 5], auf: false },
    ];
    // Nummern anderer Straßen (Eckhäuser, Nebenstraßen) etwas kleiner als die der eigenen Straße;
    // bei Platzmangel etwas kleinere Schrift statt gar keiner Nummer
    const groessen = [
      { eigen: NUMBER_FONT, fremd: 17 },
      { eigen: NUMBER_FONT_SMALL, fremd: 14 },
    ];
    type Platz = { it: Item; spot: ReturnType<typeof spots>[number]; size: number };
    /**
     * Verteilt die Nummern nach einer Reihenfolge von Versuchen (je Versuch: direkt aufs Haus
     * oder daneben, Schriftgröße). Rechnet auf einer Kopie der belegten Flächen, damit sich
     * zwei Anordnungen vergleichen lassen.
     */
    const platziere = (versuche: Array<{ auf: boolean | null; g: (typeof groessen)[number] }>, jeHaus: boolean): Platz[] => {
      const belegt = placed.slice();
      const frei = (b: number[]) => !belegt.some((q) => b[0] < q[2] && b[2] > q[0] && b[1] < q[3] && b[3] > q[1]);
      const erg: Platz[] = [];
      const fertig = new Set<Item>();
      const versuch = (it: Item, v: (typeof versuche)[number]) => {
        // selbst gesetzte Punkte behalten ihr eigenes Zeichen (Quadrat), die Nummer steht daneben
        const size = it.isFocus ? v.g.eigen : v.g.fremd;
        // Ziffern sind schmaler als ein Geviert; der Rand (Halo) gehört zum Kasten
        const tw = it.text.length * size * 0.58 + 3;
        const spot = spots(it.x, it.y, tw, size).find(
          (p) =>
            (v.auf === null || p.auf === v.auf) &&
            !(p.auf && it.user) &&
            p.box[0] > 0 && p.box[2] < w && p.box[1] > 0 && p.box[3] < h &&
            frei(p.box) && freeDots(p.box[0], p.box[1], p.box[2], p.box[3], it.gruppe),
        );
        if (!spot) return false;
        belegt.push(spot.box);
        erg.push({ it, spot, size });
        fertig.add(it);
        return true;
      };
      const grenze = () => erg.length > 260 || (S < minZoomForAll && erg.length > 40);
      if (jeHaus) {
        // Haus für Haus nach Vorrang: der erste passende Versuch zählt
        for (const it of ordered) {
          if (grenze()) break;
          for (const v of versuche) if (versuch(it, v)) break;
        }
      } else {
        // Versuch für Versuch über alle Häuser (erst alle aufs Haus, dann daneben)
        for (const v of versuche)
          for (const it of ordered) {
            if (grenze()) break;
            if (!fertig.has(it)) versuch(it, v);
          }
      }
      return erg;
    };
    // Zwei Anordnungen: (A) alle Nummern direkt aufs Haus, wo es geht – klar und ruhig;
    // (B) Haus für Haus der erste freie Platz – bringt bei sehr dichter Bebauung mehr unter.
    // Es gewinnt, was mehr Nummern zeigt (eigene Straße zählt doppelt); bei Gleichstand A.
    const A = platziere(
      [
        { auf: true, g: groessen[0] },
        { auf: true, g: groessen[1] },
        { auf: false, g: groessen[0] },
        { auf: false, g: groessen[1] },
      ],
      false,
    );
    const B = platziere(
      [
        { auf: null, g: groessen[0] },
        { auf: null, g: groessen[1] },
      ],
      true,
    );
    const wert = (l: Platz[]) => l.reduce((a, p) => a + (p.it.isFocus ? 2 : 1) * (p.it.text.includes('–') ? 3 : p.it.text.split(',').length), 0);
    const gewaehlt = wert(B) > wert(A) ? B : A;
    const aufHaus = new Set<number>();
    for (const { it, spot, size } of gewaehlt) {
      reserve(spot.box[0], spot.box[1], spot.box[2], spot.box[3]);
      if (spot.auf) aufHaus.add(it.gruppe);
      // Selbst gesetzt: mit Punkt davor; geschätzt: kursiv (nicht nur Farbe)
      const cls = `hn-label${it.isFocus ? '' : ' hn-label-other'}${it.est ? ' hn-est-label' : ''}${it.user ? ' hn-user-label' : ''}`;
      const attrs: Record<string, string | number> = { x: spot.tx, y: spot.ty, 'text-anchor': spot.anchor, class: cls };
      if (size !== NUMBER_FONT) attrs.style = `font-size:${size}px`;
      const t = el('text', attrs, gNum);
      t.textContent = it.text;
    }
    // Punkte nur für Häuser, deren Nummer nicht direkt auf dem Haus steht
    gruppen.forEach((g, i) => {
      if (aufHaus.has(i)) return;
      for (const hs of g) {
        const est = hs.n.source === 'osm-interp';
        if (hs.n.user) el('rect', { x: hs.x - 4.5, y: hs.y - 4.5, width: 9, height: 9, class: 'hn hn-user' }, gDots);
        else el('circle', { cx: hs.x, cy: hs.y, r: 4, class: est ? 'hn hn-est' : 'hn' }, gDots);
      }
    });
    // Straßennamen meiden auch die Hauspunkte
    const freeAll = (x0: number, y0: number, x1: number, y1: number) => free(x0, y0, x1, y1) && freeDots(x0, y0, x1, y1);

    // Straßennamen: sparsam, entlang der Straße, nie über Hausnummern, Ziel oder Fahrzeug
    const gLabels = el('g', { class: 'labels' }, svg);
    const maxStreetLabels = this.live ? 5 : 40;
    const named = shown
      .filter((s) => s.lines.length)
      .sort((a, b) => rank(b) - rank(a));
    let labelCount = 0;
    for (const st of named) {
      if (labelCount >= maxStreetLabels) break;
      if (this.placeStreetLabel(st, st === focus, toS, w, h, freeAll, reserve, gLabels, 16) || this.placeStreetLabel(st, st === focus, toS, w, h, freeAll, reserve, gLabels, 13))
        labelCount++;
    }
    for (const n of neighbors) {
      const [x, y] = toS(n.lat, n.lon);
      el('circle', { cx: x, cy: y, r: 11, class: 'nb' }, svg);
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
      el('circle', { cx: x, cy: y, r: 21, class: 'target' }, svg);
      const t = el('text', { x, y: y + 7, class: 'target-label' + (target.estimated ? ' target-label-est' : '') }, svg);
      t.textContent = target.label.length > 4 ? target.label.slice(0, 4) : target.label;
    }
    // Fahrzeug
    const car = this.data.car;
    const user = this.data.user;
    if (carS) {
      const [x, y] = carS;
      const acc = car?.accuracy ?? user?.accuracy ?? 0;
      const r = acc * S;
      if (r > 14 && !this.tilted) el('circle', { cx: x, cy: y, r, class: 'acc' }, svg);
      const heading = car ? car.bearing : user?.heading ?? null;
      const g = el('g', { transform: `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${((heading ?? 0) - this.rot).toFixed(1)})` }, svg);
      if (heading === null) {
        el('circle', { r: 10, class: 'car-dot' }, g);
      } else {
        // Postauto von oben: gelber Kasten, Fahrtrichtung nach oben
        el('rect', { x: -10, y: -16, width: 20, height: 32, rx: 4, class: 'car' }, g);
        el('rect', { x: -7, y: -12, width: 14, height: 7, rx: 2, class: 'car-window' }, g);
        el('path', { d: 'M0 -30 L8 -20 L-8 -20 Z', class: 'car-arrow' }, g);
      }
    }
    if (arrowDraw) arrowDraw();
    // Maßstab (am unteren Rand gemessen)
    const [ax, ay] = this.screenToWorld(w / 2 - 50, h - 2);
    const [bx, by] = this.screenToWorld(w / 2 + 50, h - 2);
    const pxPerM = 100 / Math.max(0.01, Math.hypot(bx - ax, by - ay));
    const meters = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].find((m) => m * pxPerM >= 40) ?? 10000;
    this.scaleEl.style.width = `${Math.round(meters * pxPerM)}px`;
    this.scaleEl.textContent = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
  }
}
