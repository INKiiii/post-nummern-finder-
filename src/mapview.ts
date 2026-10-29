// Eigene SVG-Karte: Straßen, Gebäude, Hausnummern, Ziel, Zufahrt, Fahrzeug. Keine Kacheln,
// daher komplett offline. Verschieben, Zoomen (zwei Finger), langes Tippen.
//
// Live-Karte: Fahrtrichtung oben, Fahrzeug im unteren Teil des freien Kartenbereichs (zwischen
// Kopf und Leiste unten), feste Zoomstufe (gemerkt). Die Karte gleitet zwischen zwei Positionen
// ruhig mit, wie ein Navi: Gezeichnet wird einmal je Position (mit Rand ringsum), dazwischen
// verschiebt und dreht der Browser nur das fertige Bild (Grafikchip, akkuschonend). Das Fahrzeug
// wird leicht vorausberechnet (Tempo × Zeit bis zur nächsten Position), damit es nicht
// hinterherhinkt. Bei „Bewegung reduzieren“ (Systemeinstellung) springt die Karte wie früher.
//
// Navi-Ansicht (Standard): dieselbe flache Karte, nach hinten gekippt (src/perspective.ts) – der
// Blick geht von hinter dem Fahrzeug weit in Fahrtrichtung. Gezeichnet wird weiterhin flach; die
// Neigung rechnet der Browser als eine Matrix. Beschriftungen, Ziel und Pfeile werden an ihrer
// Stelle entzerrt gezeichnet und stehen deshalb aufrecht wie Schilder.

import { makeProjection, distanceM, normHouseNumber } from './core';
import { AHEAD_LEVELS, AHEAD_LEVELS_NAVI, CAR_Y, CAR_Y_NAVI, DEFAULT_LEVEL, NUMBER_FONT, NUMBER_FONT_SMALL, edgePoint, groupSameHouse, joinHouseLabels, labelOrder } from './maplabels';
import { angleDiff, covers, coversPoints, lerpCam, reanchor, sameCam, screenMatrix, toScreen, toWorld, type Cam } from './camera';
import { affine, factorScreen, homography, matrix3d, mul3, perspFor, project, unproject, unskew, type Persp } from './perspective';
import type { HouseNumber, Index, Street } from './types';
import type { Fix } from './gps';
import type { HouseMark, Side } from './preview';

const NS = 'http://www.w3.org/2000/svg';
const MODE_KEY = 'hnf-map-mode2';
const OLD_MODE_KEY = 'hnf-map-mode';
const LEVEL_KEY = 'hnf-map-level2';
/** Rand rund um den sichtbaren Bereich, der mitgezeichnet wird (px): Platz zum Gleiten */
const OVERSCAN = 140;
/** Vorausberechnung: Anteil der Strecke bis zur nächsten Position */
const LEAD = 0.8;
/** Erst ab diesem Tempo (m/s) wird vorausberechnet; langsamer steht das Fahrzeug, wo GPS es sieht */
const LEAD_MIN_SPEED = 1.5;
/** Häuser so weit hinter dem Fahrzeug (m) erscheinen blasser (schon vorbei) */
export const PASSED_DIM_M = 8;
/** Schrift der Markierung „nächstes Haus“ je Straßenseite */
export const PILL_FONT = 21;

/** navi: geneigt, Blick in Fahrtrichtung · heading: flach, Fahrtrichtung oben · north: Norden oben */
export type MapMode = 'navi' | 'heading' | 'north';

export interface MapTarget {
  lat: number;
  lon: number;
  label: string;
  estimated: boolean;
}

export interface MapDriveway {
  line: [number, number][];
  user: boolean;
  /** Seite der Einfahrt in Fahrtrichtung (färbt Linie und Marker), null: unbekannt */
  side?: Side | null;
}

/** Fahrzeug, wie es angezeigt wird (auf die Straße bezogen) */
export interface MapCar {
  pos: [number, number];
  /** Fahrtrichtung in Grad oder null (unbekannt) */
  bearing: number | null;
  accuracy: number;
  /** Tempo in m/s (für die Vorausberechnung), null: unbekannt */
  speed?: number | null;
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
  /** Häuser der aktuellen Straße: Seite, Abstand, nächstes Haus je Seite */
  houses: Map<HouseNumber, HouseMark> | null;
}

/** Fahrzeug in Weltkoordinaten (m) */
interface Pose {
  x: number;
  y: number;
  bearing: number | null;
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
  const m = load(MODE_KEY);
  if (m === 'navi' || m === 'heading' || m === 'north') return m;
  // Wer früher „Norden oben“ gewählt hatte, behält das; sonst Navi-Ansicht
  return load(OLD_MODE_KEY) === 'north' ? 'north' : 'navi';
}
export function setSavedMapMode(m: MapMode) {
  save(MODE_KEY, m);
}

function reducedMotion(): boolean {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function lerpPose(a: Pose, b: Pose, t: number): Pose {
  const bearing = a.bearing === null || b.bearing === null ? b.bearing : a.bearing + angleDiff(a.bearing, b.bearing) * t;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, bearing };
}

export class MapView {
  readonly root: HTMLDivElement;
  private canvas: HTMLDivElement;
  private svg: SVGSVGElement;
  /** Ebene um das SVG: nur sie wird verschoben und gekippt (das SVG selbst zu bewegen kostet Layout) */
  private layer: HTMLDivElement;
  private carEl: HTMLDivElement;
  private accEl: HTMLDivElement;
  private proj = makeProjection(53.3, 10.2);
  private originSet = false;
  /** Zielansicht (wohin die Karte gleitet) */
  private cam: Cam = { ax: 0, ay: 0, sx: 150, sy: 150, rot: 0, scale: 2.5 };
  /** Angezeigte Ansicht (gleitet zur Zielansicht) */
  private view: Cam = this.cam;
  /** Ansicht, für die das SVG zuletzt gezeichnet wurde */
  private drawn: Cam | null = null;
  private drawnKey = '';
  private dataKey = '';
  private svgSize = '';
  /** Flächen von Knöpfen und Maßstab auf der Karte (gemerkt; neu bei Größen- oder Folgewechsel) */
  private ctrlBoxes: number[][] | null = null;
  private layerTf = '';
  private carTf = '';
  private sz: { w: number; h: number } | null = null;
  private anim: { from: Cam; t0: number; dur: number; linear: boolean; turn: boolean } | null = null;
  private fit: { dur: number; linear: boolean; t0?: number } | null = null;
  /** Fahrzeug, wie gezeigt, und wohin es gleitet (mit Vorausberechnung) */
  private pose: Pose | null = null;
  private poseGoal: Pose | null = null;
  private poseAnim: { from: Pose; t0: number; dur: number } | null = null;
  private lastCarT = 0;
  /** Gemessener Abstand zwischen zwei Positionen (ms), höchstens 1,2 s */
  private interval = 0;
  /** Freier Kartenbereich: oben, unten bzw. links von Kopf und Leiste verdeckt (px) */
  private insets = { top: 0, bottom: 0, left: 0 };
  private ov: number;
  private motion: boolean;
  private mode: MapMode = savedMapMode();
  private live: boolean;
  private level = DEFAULT_LEVEL;
  /** true: Karte folgt dem Fahrzeug bzw. zeigt das Ziel; false: von Hand verschoben */
  private auto = true;
  private raf = 0;
  /** Platz jeder Nummer im letzten Bild: beim Fahren bleibt sie möglichst dort (ruhiges Bild) */
  private memo = new Map<string, { k: number; sz: number }>();
  /** Neigung, wie sie gerade angezeigt wird: gleitet, wenn sich Kopf oder Leiste in der Höhe ändern */
  private pv: Persp | null = null;
  private pvAnim: { from: Persp; to: Persp; t0: number } | null = null;
  /** Neigung, für die zuletzt gezeichnet wurde (Beschriftungen sind dafür entzerrt) */
  private drawnP: Persp | null = null;
  /** Zuletzt gewählte Anordnung der Nummern (A, B oder C, siehe render) */
  private layout = 'A';
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
    houses: null,
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
    this.motion = this.live && !reducedMotion();
    this.ov = this.live ? OVERSCAN : 0;
    if (opts.allowHeading === false) this.mode = 'north';
    const stored = load(LEVEL_KEY);
    const lv = stored === null ? NaN : Number(stored);
    if (Number.isInteger(lv) && lv >= 0 && lv < AHEAD_LEVELS_NAVI.length) this.level = lv;
    this.root = document.createElement('div');
    this.root.className = 'map' + (this.live ? ' map-live' : '');
    this.canvas = document.createElement('div');
    this.canvas.className = 'map-canvas';
    this.svg = el('svg', { class: 'map-svg' }) as SVGSVGElement;
    this.layer = document.createElement('div');
    this.layer.className = 'map-layer';
    this.layer.appendChild(this.svg);
    this.accEl = document.createElement('div');
    this.accEl.className = 'map-acc';
    this.accEl.hidden = true;
    this.carEl = document.createElement('div');
    this.carEl.className = 'map-car';
    this.carEl.hidden = true;
    this.carEl.setAttribute('aria-hidden', 'true');
    // Fahrzeug: weiße Scheibe mit dunklem Rand und Pfeil in Fahrtrichtung (auf der gelben Straße gut sichtbar)
    this.carEl.innerHTML =
      '<svg viewBox="-26 -26 52 52" width="52" height="52"><circle class="car-halo" r="24"/><circle class="car-disc" r="17.5"/>' +
      '<path class="car-chev" d="M0 -11.5 L9.5 9 L0 4 L-9.5 9 Z"/><circle class="car-pt" r="6.5"/></svg>';
    this.canvas.append(this.layer, this.accEl, this.carEl);
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
      this.modeBtn = btn('', 'Kartenausrichtung umschalten', () => this.setMode(this.mode === 'north' ? 'heading' : 'north'));
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
        const p = this.local(e);
        this.zoom(e.deltaY < 0 ? 1.25 : 0.8, p.x, p.y);
      },
      { passive: false },
    );
    new ResizeObserver(() => {
      this.sz = null;
      this.ctrlBoxes = null;
      this.requestFit(0);
    }).observe(this.canvas);
  }

  get following() {
    return this.auto;
  }

  setMode(mode: MapMode) {
    this.mode = mode;
    setSavedMapMode(mode);
    this.updateModeBtn();
    this.requestFit(400);
  }

  getMode() {
    return this.mode;
  }

  /** Live-Zoom: eine Stufe näher (+1) oder weiter (-1); wird gemerkt. */
  zoomStep(delta: 1 | -1) {
    this.level = Math.max(0, Math.min(this.levels.length - 1, this.level - delta));
    save(LEVEL_KEY, String(this.level));
    this.setAuto(true);
    this.requestFit(280);
  }

  /** Sicht voraus der aktuellen Zoomstufe in Metern */
  get aheadMeters() {
    return this.levels[this.level];
  }

  private get levels() {
    return this.navi ? AHEAD_LEVELS_NAVI : AHEAD_LEVELS;
  }

  /** Navi-Ansicht aktiv (nur Live-Karte mit Fahrtrichtung) */
  get navi() {
    return this.live && this.mode === 'navi';
  }

  /** Neigung der Navi-Ansicht für die aktuelle Fläche, sonst null (flach) */
  private persp(w: number): Persp | null {
    if (!this.navi) return null;
    const top = this.insets.top;
    const bottom = Math.max(top + 80, this.size().h - this.insets.bottom);
    return perspFor(top, bottom, Math.min(this.insets.left, w - 120), w);
  }

  /** Bildschirm → flache Kartenkoordinaten (in der Navi-Ansicht durch die Neigung zurück) */
  private flat(x: number, y: number): [number, number] {
    const P = this.navi ? (this.pv ?? this.persp(this.size().w)) : null;
    return P ? unproject(P, x, y) : [x, y];
  }

  /**
   * Gezeichneter Bereich (flache Koordinaten) und der Ausschnitt, der sichtbar sein muss. In der
   * Navi-Ansicht reicht der Ausschnitt flach weit nach oben und ist oben breiter (Trapez).
   */
  private extent(w: number, h: number, P: Persp | null) {
    const ov = this.ov;
    if (!P) {
      const need: Array<[number, number]> = [
        [0, 0],
        [w, 0],
        [0, h],
        [w, h],
      ];
      return { ovX: ov, ovTop: ov, need };
    }
    const left = Math.min(this.insets.left, w - 120);
    const yTop = Math.max(-ov, this.insets.top - 30);
    const need: Array<[number, number]> = [
      unproject(P, left - 10, yTop),
      unproject(P, w + 10, yTop),
      unproject(P, left - 10, h),
      unproject(P, w + 10, h),
    ];
    const ovTop = Math.min(2400, Math.max(ov, Math.ceil(-Math.min(...need.map((p) => p[1]))) + ov));
    const ovX = Math.min(1200, Math.max(ov, Math.ceil(Math.max(...need.map((p) => Math.max(-p[0], p[0] - w)))) + 60));
    return { ovX, ovTop, need };
  }

  recenter() {
    this.setAuto(true);
    this.requestFit(400);
  }

  /**
   * Freier Kartenbereich: so viele Pixel sind oben, unten bzw. links (Querformat: Spalte links)
   * von Kopf und Leiste verdeckt. Fahrzeug, Sicht voraus, Knöpfe und Maßstab richten sich danach.
   */
  setInsets(top: number, bottom: number, left = 0) {
    top = Math.max(0, Math.round(top));
    bottom = Math.max(0, Math.round(bottom));
    left = Math.max(0, Math.round(left));
    if (top === this.insets.top && bottom === this.insets.bottom && left === this.insets.left) return;
    this.insets = { top, bottom, left };
    this.ctrlBoxes = null;
    this.root.style.setProperty('--map-top', `${top}px`);
    this.root.style.setProperty('--map-bottom', `${bottom}px`);
    this.root.style.setProperty('--map-left', `${left}px`);
    this.requestFit(this.drawn ? 250 : 0);
  }

  private setAuto(v: boolean) {
    if (this.auto === v) return;
    this.auto = v;
    this.ctrlBoxes = null;
    this.centerBtn?.classList.toggle('active', !v);
    this.onFollowChange?.(v);
  }

  private updateModeBtn() {
    if (!this.modeBtn) return;
    this.modeBtn.textContent = this.mode !== 'north' ? '▲ Fahrt' : 'N ↑';
    this.modeBtn.title = this.mode !== 'north' ? 'Fahrtrichtung oben – tippen für Norden oben' : 'Norden oben – tippen für Fahrtrichtung oben';
  }

  update(partial: Partial<MapData>) {
    const targetChanged = partial.target !== undefined && partial.target !== this.data.target;
    const carChanged = partial.car !== undefined && partial.car !== this.data.car;
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
    this.dataKey = this.contentKey();
    if (carChanged) {
      this.carMoved();
      this.requestFit(this.poseAnim ? this.interval : 0, true, this.lastCarT);
    } else this.requestFit(300);
  }

  /** Karte auf einen Punkt setzen (z. B. für neue Straße). */
  centerOn(lat: number, lon: number, scale = 2) {
    this.setOrigin(lat, lon);
    const { w, h } = this.size();
    this.cam = this.view = { ax: 0, ay: 0, sx: w / 2, sy: h / 2, rot: this.cam.rot, scale };
    this.anim = null;
    this.fit = null;
    this.setAuto(false);
    this.kick();
  }

  /** Index-Inhalt geändert (z. B. eigener Punkt gesetzt): neu zeichnen. */
  refresh() {
    this.drawnKey = '';
    this.ctrlBoxes = null;
    this.kick();
  }

  private setOrigin(lat: number, lon: number) {
    // Ansicht beibehalten, nur Bezugspunkt der Weltkoordinaten wechseln
    const old = this.originSet ? this.proj : null;
    const np = makeProjection(lat, lon);
    const conv = (c: Cam): Cam => {
      const [ax, ay] = old ? np.toXY(...(old.toLatLon(c.ax, c.ay) as [number, number])) : [0, 0];
      return { ...c, ax, ay };
    };
    this.originSet = true;
    this.proj = np;
    this.cam = conv(this.cam);
    this.view = conv(this.view);
    this.anim = null;
    this.drawn = null;
    this.pose = this.poseGoal = null;
    this.poseAnim = null;
  }

  /** Größe der Kartenfläche (gemerkt, damit nicht jedes Bild das Layout abfragt) */
  private size() {
    if (!this.sz) {
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      if (!w || !h) return { w: w || 300, h: h || 300 };
      this.sz = { w, h };
    }
    return this.sz;
  }

  private screenToLatLon(sx: number, sy: number): [number, number] {
    const [x, y] = toWorld(this.view, ...this.flat(sx, sy));
    return this.proj.toLatLon(x, y) as [number, number];
  }

  /** Position des Fahrzeugs (GPS auf der Straße) als lat/lon */
  private carPos(): [number, number] | null {
    if (this.data.car) return this.data.car.pos;
    if (this.data.user) return [this.data.user.lat, this.data.user.lon];
    return null;
  }

  /** Fahrzeug-Ziel in Weltkoordinaten (mit Vorausberechnung); ohne Straßenbezug das rohe GPS */
  private goal(): Pose | null {
    if (this.poseGoal) return this.poseGoal;
    const u = this.data.user;
    if (!this.data.car && u && this.originSet) {
      const [x, y] = this.proj.toXY(u.lat, u.lon);
      return { x, y, bearing: u.heading ?? null };
    }
    return null;
  }

  /** Neue Fahrzeugposition: Ziel mit Vorausberechnung, gleitend über die Zeit bis zur nächsten */
  private carMoved() {
    const c = this.data.car;
    if (!c || !this.originSet) {
      this.pose = this.poseGoal = null;
      this.poseAnim = null;
      return;
    }
    const now = performance.now();
    const dt = this.lastCarT ? now - this.lastCarT : 0;
    this.lastCarT = now;
    this.interval = dt > 0 && dt < 3000 ? Math.min(1200, this.interval ? this.interval * 0.5 + dt * 0.5 : dt) : 0;
    let [x, y] = this.proj.toXY(c.pos[0], c.pos[1]);
    const v = c.speed ?? 0;
    if (this.motion && c.bearing !== null && v >= LEAD_MIN_SPEED && this.interval > 0) {
      const lead = ((v * this.interval) / 1000) * LEAD;
      const r = (c.bearing * Math.PI) / 180;
      x += Math.sin(r) * lead;
      y += Math.cos(r) * lead;
    }
    const goal: Pose = { x, y, bearing: c.bearing };
    const from = this.pose;
    this.poseGoal = goal;
    if (!from || !this.motion || this.interval < 30 || Math.hypot(goal.x - from.x, goal.y - from.y) > 60) {
      this.poseAnim = null;
      this.pose = goal;
    } else this.poseAnim = { from, t0: now, dur: this.interval };
  }

  /** Ausschnitt neu bestimmen (im nächsten Bild); dur: Dauer des Gleitens, linear: gleichmäßig wie Fahren */
  private requestFit(dur: number, linear = false, t0?: number) {
    // Eine Fahrzeugbewegung hat Vorrang vor anderen Anlässen im selben Bild
    if (!this.fit || linear) this.fit = { dur, linear, t0 };
    this.kick();
  }

  private animateTo(dur: number, linear: boolean, t0: number) {
    const { w, h } = this.size();
    if (!this.motion || dur < 30 || sameCam(this.view, this.cam, w, h)) {
      this.anim = null;
      this.view = this.cam;
      return;
    }
    // Großer Richtungswechsel (Abbiegen): Drehung sanft an- und auslaufen lassen – aber nur,
    // wenn gerade nichts gleitet. Kommt die nächste Position mitten im Gleiten, geht es ohne
    // erneutes Anlaufen weiter (sonst käme die Karte bei häufigen Positionen nie an).
    const turn = !this.anim && Math.abs(angleDiff(this.view.rot, this.cam.rot)) > 20;
    this.anim = { from: reanchor(this.view, this.cam.sx, this.cam.sy), t0, dur: turn ? Math.max(dur, 900) : dur, linear, turn };
  }

  /** Laufendes Gleiten anhalten (beim Anfassen): Die Karte bleibt, wo sie gerade ist. */
  private settle() {
    if (this.anim) {
      this.cam = this.view;
      this.anim = null;
    }
    this.fit = null;
  }

  /**
   * Automatischer Ausschnitt.
   * Live mit Fahrzeug: Fahrzeug im unteren Teil des freien Bereichs, Sicht voraus nach Zoomstufe
   * (Standard 80 m bis zur Unterkante des Kopfes). Ein Haus in zweiter Reihe in der Nähe bleibt
   * im Bild. Sonst: etwa 160 m um das Ziel.
   */
  private autoFit() {
    const { target, driveway, focus } = this.data;
    const { w, h } = this.size();
    const top = this.insets.top;
    const bottom = Math.max(top + 80, h - this.insets.bottom);
    const vh = bottom - top;
    const lx0 = Math.min(this.insets.left, w - 120);
    const cx = lx0 + (w - lx0) / 2;
    const goal = this.goal();
    let rot = this.cam.rot;
    if (this.mode === 'north') rot = 0;
    else if (goal && goal.bearing !== null && Number.isFinite(goal.bearing)) rot = goal.bearing;
    const T = target ? this.proj.toXY(target.lat, target.lon) : null;
    const J = driveway?.line.length ? this.proj.toXY(driveway.line[0][0], driveway.line[0][1]) : null;
    const P = this.persp(w);
    // Bildschirmlage eines Weltpunkts unter einer Ansicht (in der Navi-Ansicht mit Neigung)
    const scr = (c: Cam, x: number, y: number): [number, number] => {
      const q = toScreen(c, x, y);
      return P ? project(P, q[0], q[1]) : q;
    };
    if (goal && (this.live || T || focus)) {
      const U: [number, number] = [goal.x, goal.y];
      const ahead = this.live ? this.levels[this.level] : 120;
      let carY: number;
      let base: number;
      if (P) {
        // Navi: Fahrzeug tief im freien Bereich; „ahead“ Meter bis zur Unterkante des Kopfes
        carY = unproject(P, cx, top + vh * CAR_Y_NAVI)[1];
        base = (carY - unproject(P, cx, top)[1]) / ahead;
      } else {
        carY = this.live ? top + vh * CAR_Y : top + vh / 2;
        base = (carY - top) / ahead;
      }
      base = Math.min(14, Math.max(0.05, base));
      const carScreenY = P ? project(P, cx, carY)[1] : carY;
      let cam: Cam = { ax: U[0], ay: U[1], sx: cx, sy: carY, rot, scale: base };
      // Nahbereich: Haus (auch in zweiter Reihe) und Einfahrt sichtbar halten, solange sie
      // voraus oder neben dem Fahrzeug liegen. Erst seitlich verschieben (Fahrzeug aus der
      // Mitte), dann begrenzt herauszoomen; sonst zeigt ein Pfeil am Rand die Richtung.
      const must = [T, J].filter((p): p is [number, number] => {
        if (!p || Math.hypot(p[0] - U[0], p[1] - U[1]) > 120) return false;
        return scr(cam, p[0], p[1])[1] <= carScreenY + 20;
      });
      if (must.length) {
        const left = lx0 + 40;
        const right = w - 95; // rechts liegen die Zoomknöpfe
        let shift = 0;
        for (const [x, y] of must) {
          const sx = scr(cam, x, y)[0];
          if (sx > right) shift = Math.max(shift, sx - right);
          else if (sx < left) shift = Math.min(shift, sx - left);
        }
        shift = Math.max(-(w - lx0) * 0.3, Math.min((w - lx0) * 0.3, shift));
        // In der Navi-Ansicht wirkt eine flache Verschiebung an der Fahrzeugstelle verkleinert
        cam = { ...cam, sx: cx - shift * (P ? 1 / factorScreen(P, carScreenY) : 1) };
        // Je näher, desto mehr darf herausgezoomt werden (stufenlos, kein Sprung): bei 120 m
        // gar nicht, ab 30 m bis auf die Hälfte.
        const dMin = Math.min(...must.map((p) => Math.hypot(p[0] - U[0], p[1] - U[1])));
        const lowest = base * (0.5 + 0.5 * Math.min(1, Math.max(0, (dMin - 30) / 90)));
        const m = 30;
        for (let i = 0; i < 20 && cam.scale * 0.95 >= lowest; i++) {
          const c = cam;
          const out = must.some(([x, y]) => {
            const [sx, sy] = scr(c, x, y);
            return sx < left || sx > right || sy < top + m || sy > bottom - m;
          });
          if (!out) break;
          cam = { ...cam, scale: cam.scale * 0.95 };
        }
      }
      this.cam = cam;
      return;
    }
    const Pt = T ?? J ?? (focus?.bbox ? this.proj.toXY((focus.bbox[0] + focus.bbox[2]) / 2, (focus.bbox[1] + focus.bbox[3]) / 2) : null);
    if (!Pt) return;
    const P2 = P;
    const midY = P2 ? unproject(P2, cx, top + vh / 2)[1] : top + vh / 2;
    this.cam = { ax: Pt[0], ay: Pt[1], sx: cx, sy: midY, rot, scale: Math.min(4, Math.min(w - lx0, vh) / 160) };
  }

  private zoom(f: number, sx?: number, sy?: number) {
    const { w, h } = this.size();
    const px = sx ?? w / 2;
    const py = sy ?? h / 2;
    this.settle();
    const [fx, fy] = this.flat(px, py);
    const [wx, wy] = toWorld(this.cam, fx, fy);
    this.cam = this.view = { ...this.cam, ax: wx, ay: wy, sx: fx, sy: fy, scale: Math.min(14, Math.max(0.02, this.cam.scale * f)) };
    this.setAuto(false);
    this.kick();
  }

  private local(e: PointerEvent | WheelEvent) {
    // Bezug ist die (nicht bewegte) Kartenfläche, nicht das gleitende Bild
    const r = this.canvas.getBoundingClientRect();
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
        this.settle();
        const [wx, wy] = toWorld(this.cam, ...this.flat(prev.x, prev.y));
        const [fx, fy] = this.flat(p.x, p.y);
        this.cam = this.view = { ...this.cam, ax: wx, ay: wy, sx: fx, sy: fy };
        this.setAuto(false);
        this.kick();
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

  /** Inhalt, der das Bild verändert (ohne Fahrzeugposition: die gleitet obenauf) */
  private contentKey() {
    const d = this.data;
    const houses = d.houses
      ? [...d.houses.entries()]
          .filter(([, m]) => m.next || m.ahead < -PASSED_DIM_M)
          .map(([n, m]) => (m.next ? `${n.norm}${m.side[0]}` : n.norm))
          .join(',')
      : '';
    return [
      d.target ? `${d.target.lat},${d.target.lon},${d.target.label},${d.target.estimated}` : '',
      d.focus?.id,
      d.focus?.numbers.length,
      d.index?.streets.size,
      [...d.emphasis].join('|'),
      d.draft?.length,
      d.driveway?.line.flat().join(','),
      d.driveway?.side ?? '',
      d.neighbors.length,
      houses,
    ].join(';');
  }

  private kick() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  /** Ein Bild: Ausschnitt nachführen, gleiten, nur wenn nötig neu zeichnen */
  private frame() {
    this.raf = 0;
    const now = performance.now();
    const { w, h } = this.size();
    if (this.fit) {
      const f = this.fit;
      this.fit = null;
      if (this.auto) {
        this.autoFit();
        this.animateTo(f.dur, f.linear, f.t0 ?? now);
      }
    }
    let moving = false;
    // Neigung: ändert sich der freie Bereich (Kopf, Zielkarte), gleitet sie in 0,3 s hinüber
    const Pt = this.persp(w);
    if (!Pt) {
      this.pv = null;
      this.pvAnim = null;
    } else if (!this.pv || !this.motion) this.pv = Pt;
    else {
      const ziel = this.pvAnim?.to ?? this.pv;
      if (Math.abs(ziel.y0 - Pt.y0) > 0.5 || Math.abs(ziel.cx - Pt.cx) > 0.5 || Math.abs(1 / ziel.k - 1 / Pt.k) > 0.5) this.pvAnim = { from: this.pv, to: Pt, t0: now };
      if (this.pvAnim) {
        const { from, to, t0 } = this.pvAnim;
        const t = Math.min(1, (now - t0) / 300);
        const e = 1 - Math.pow(1 - t, 3);
        this.pv = { y0: from.y0 + (to.y0 - from.y0) * e, cx: from.cx + (to.cx - from.cx) * e, k: 1 / (1 / from.k + (1 / to.k - 1 / from.k) * e) };
        if (t >= 1) this.pvAnim = null;
        else moving = true;
      }
    }
    if (this.anim) {
      const a = this.anim;
      const t = Math.min(1, Math.max(0, (now - a.t0) / a.dur));
      if (t >= 1) {
        this.anim = null;
        this.view = this.cam;
      } else {
        const ease = 1 - Math.pow(1 - t, 3);
        const tRot = a.turn ? (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2) : a.linear ? t : ease;
        this.view = lerpCam(a.from, this.cam, a.linear ? t : ease, tRot);
        moving = true;
      }
    } else this.view = this.cam;
    if (this.poseAnim && this.poseGoal) {
      const a = this.poseAnim;
      const t = Math.min(1, Math.max(0, (now - a.t0) / a.dur));
      if (t >= 1) {
        this.poseAnim = null;
        this.pose = this.poseGoal;
      } else {
        this.pose = lerpPose(a.from, this.poseGoal, t);
        moving = true;
      }
    } else this.pose = this.poseGoal;

    // Neu zeichnen nur, wenn sich der Inhalt geändert hat, das fertige Bild den Bildschirm nicht
    // mehr abdeckt oder das Gleiten zu Ende ist (dann scharf in der Endstellung). Akku schonen.
    const g = this.poseGoal;
    const key = `${this.dataKey};${w};${h};${this.insets.top};${this.insets.bottom};${this.auto || !g ? '' : `${g.x.toFixed(1)},${g.y.toFixed(1)}`}`;
    const d = this.drawn;
    const P = this.pv;
    const ext = this.extent(w, h, P);
    const bounds = { x0: -ext.ovX + 2, y0: -ext.ovTop + 2, x1: w + ext.ovX - 2, y1: h + this.ov - 2 };
    const fits = (dr: Cam, v: Cam) => (P ? coversPoints(dr, v, ext.need, bounds) : covers(dr, v, w, h, this.ov));
    // Navi: Beschriftungen sind für ihre Tiefe entzerrt; rücken sie merklich näher, neu zeichnen
    const drift = (dr: Cam, v: Cam) => {
      if (!P) return false;
      const [x, y] = toScreen(dr, v.ax, v.ay);
      return Math.hypot(x - v.sx, y - v.sy) > 14;
    };
    const fullKey = `${key};${P ? 'navi' : 'flach'}`;
    // Neigung hat sich seit dem Zeichnen merklich geändert: Beschriftungen neu entzerren
    const dp = this.drawnP;
    const pAlt = !!P && !!dp && (Math.abs(P.y0 - dp.y0) > 6 || Math.abs(P.cx - dp.cx) > 6 || Math.abs(1 / P.k - 1 / dp.k) > 20);
    const settled = !this.anim && !this.pvAnim;
    if (fullKey !== this.drawnKey || !d || !fits(d, this.view) || drift(d, this.view) || pAlt || (settled && (!sameCam(d, this.cam, w, h) || (!!P && !!dp && (P.y0 !== dp.y0 || P.cx !== dp.cx || P.k !== dp.k))))) {
      const at = !this.anim || (fits(this.cam, this.view) && !drift(this.cam, this.view)) ? this.cam : this.view;
      this.render(at, w, h);
      this.drawnP = P;
      this.drawn = at;
      this.drawnKey = fullKey;
    }
    this.applyTransform(w, h, P);
    this.placeCar();
    if (moving) this.kick();
  }

  /** Fertiges Bild auf die angezeigte Ansicht schieben und drehen (nur eine CSS-Matrix) */
  private applyTransform(w: number, h: number, P: Persp | null) {
    const d = this.drawn;
    if (!d) return;
    let t = '';
    if (P) t = matrix3d(mul3(homography(P), affine(screenMatrix(d, this.view))));
    else if (!sameCam(d, this.view, w, h)) t = `matrix(${screenMatrix(d, this.view).map((v) => v.toFixed(5)).join(',')})`;
    // nur schreiben, wenn sich etwas ändert (im Stand: gar nichts zu tun)
    if (t !== this.layerTf) {
      this.layerTf = t;
      this.layer.style.transform = t;
    }
  }

  /** Fahrzeug (eigene Ebene über der Karte) an seine angezeigte Stelle setzen */
  private placeCar() {
    let p = this.pose;
    let acc = this.data.car?.accuracy ?? 0;
    if (!this.data.car) {
      p = this.goal();
      acc = this.data.user?.accuracy ?? 0;
    }
    this.carEl.hidden = !p;
    if (!p) {
      this.accEl.hidden = true;
      return;
    }
    const P = this.pv;
    const scr = (wx: number, wy: number): [number, number] => {
      const q = toScreen(this.view, wx, wy);
      return P ? project(P, q[0], q[1]) : q;
    };
    const [x, y] = scr(p.x, p.y);
    let ang = 0;
    if (p.bearing !== null) {
      // Richtung auf dem Bildschirm aus einem Punkt 3 m voraus (stimmt auch in der Navi-Ansicht)
      const r = (p.bearing * Math.PI) / 180;
      const [x2, y2] = scr(p.x + Math.sin(r) * 3, p.y + Math.cos(r) * 3);
      ang = (Math.atan2(x2 - x, y - y2) * 180) / Math.PI;
    }
    const ct = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) rotate(${ang.toFixed(1)}deg)`;
    if (ct !== this.carTf) {
      this.carTf = ct;
      this.carEl.style.transform = ct;
    }
    if (this.carEl.classList.contains('no-heading') !== (p.bearing === null)) this.carEl.classList.toggle('no-heading', p.bearing === null);
    // Ungenauigkeit nur zeigen, wenn sie deutlich größer als das Fahrzeug ist
    const r = acc * this.view.scale * (P ? 1 / factorScreen(P, y) : 1);
    this.accEl.hidden = !(r > 30) || !!P;
    if (r > 30) {
      this.accEl.style.width = this.accEl.style.height = `${(2 * r).toFixed(0)}px`;
      this.accEl.style.transform = `translate(${(x - r).toFixed(1)}px,${(y - r).toFixed(1)}px)`;
    }
  }

  /**
   * Schreibt den Straßennamen entlang eines möglichst geraden, sichtbaren Stücks der Straße.
   * Prüft Kollisionen über Stichproben entlang der Schrift. Gibt true zurück, wenn platziert.
   */
  private placeStreetLabel(
    st: Street,
    isFocus: boolean,
    toS: (lat: number, lon: number) => [number, number],
    area: { x0: number; y0: number; x1: number; y1: number; top: number; bottom: number; left: number; w: number },
    free: (x0: number, y0: number, x1: number, y1: number) => boolean,
    reserve: (x0: number, y0: number, x1: number, y1: number) => void,
    draw: (cx: number, cy: number, ang: number, size: number, cls: string, text: string) => void,
    size = 16,
  ): boolean {
    const tw = st.name.length * size * 0.58 + 6;
    const m = 8;
    const { x0: X0, y0: Y0, x1: X1, y1: Y1 } = area;
    const inside = (p: number[]) => p[0] > X0 + m && p[0] < X1 - m && p[1] > Y0 + m && p[1] < Y1 - m;
    const shown = (x: number, y: number) => x > area.left && x < area.w && y > area.top && y < area.bottom;
    const mx = (area.left + area.w) / 2;
    const my = (area.top + area.bottom) / 2;
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
        if (!(clip(-dx, x0 - (X0 - pad)) && clip(dx, X1 + pad - x0) && clip(-dy, y0 - (Y0 - pad)) && clip(dy, Y1 + pad - y0))) continue;
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
        // Lieber im freien Bereich als unter Kopf oder Leiste (dort sieht man ihn nicht)
        cands.push({ cx, cy, ang, samples, dist: Math.hypot(cx - mx, cy - my) + (shown(cx, cy) ? 0 : 2000) });
      }
    }
    cands.sort((a, b) => a.dist - b.dist);
    for (const c of cands.slice(0, 80)) {
      const half = size * 0.55;
      if (!c.samples.every(([x, y]) => free(x - 5, y - half, x + 5, y + half))) continue;
      for (const [x, y] of c.samples) reserve(x - 5, y - half, x + 5, y + half);
      draw(c.cx, c.cy, c.ang, size, isFocus ? 'st-label st-label-focus' : 'st-label', st.name);
      return true;
    }
    return false;
  }

  /**
   * Zeichnet alles (außer dem Fahrzeug) für die Ansicht `cam`, mit Rand ringsum zum Gleiten.
   * Straßen, Gebäude und Hauspunkte liegen flach auf der Karte; Beschriftungen werden auf dem
   * Bildschirm verteilt und – in der Navi-Ansicht – an ihrer Stelle entzerrt gezeichnet.
   */
  private render(cam: Cam, w: number, h: number) {
    const svg = this.svg;
    const P = this.pv;
    const { ovX, ovTop } = this.extent(w, h, P);
    const ovB = this.ov;
    const geo = `${w}x${h}:${ovX},${ovTop}`;
    if (this.svgSize !== geo) {
      this.svgSize = geo;
      svg.setAttribute('viewBox', `${-ovX} ${-ovTop} ${w + 2 * ovX} ${h + ovTop + ovB}`);
      if (this.ov) {
        const ls = this.layer.style;
        ls.left = `${-ovX}px`;
        ls.top = `${-ovTop}px`;
        ls.width = `${w + 2 * ovX}px`;
        ls.height = `${h + ovTop + ovB}px`;
        ls.transformOrigin = `${ovX}px ${ovTop}px`;
      }
    }
    svg.replaceChildren();
    this.scaleEl.parentElement?.classList.toggle('navi', !!P);
    const S = cam.scale;
    const top = this.insets.top;
    const bottom = Math.max(top + 80, h - this.insets.bottom);
    const left = Math.min(this.insets.left, w - 120);
    const midX = left + (w - left) / 2;
    // Flach: Zeichenfläche mit Rand. Bildschirm: Bereich, in dem Beschriftungen stehen dürfen.
    const FX0 = -ovX;
    const FY0 = -ovTop;
    const FX1 = w + ovX;
    const FY1 = h + ovB;
    const X0 = P ? left - 40 : -this.ov;
    const Y0 = P ? top - 30 : -this.ov;
    const X1 = P ? w + 40 : w + this.ov;
    const Y1 = h + this.ov;
    const toF = (lat: number, lon: number): [number, number] => {
      const [x, y] = this.proj.toXY(lat, lon);
      return toScreen(cam, x, y);
    };
    const proj2 = (q: [number, number]): [number, number] => {
      if (!P) return q;
      // weit hinter dem Fahrzeug liegt nichts mehr im Bild
      if (1 + P.k * (P.y0 - q[1]) < 0.2) return [-1e6, -1e6];
      return project(P, q[0], q[1]);
    };
    const toS = (lat: number, lon: number): [number, number] => proj2(toF(lat, lon));
    const visible = (x: number, y: number, pad = 20) => x > X0 - pad && x < X1 + pad && y > Y0 - pad && y < Y1 + pad;
    const visibleF = (x: number, y: number, pad = 20) => x > FX0 - pad && x < FX1 + pad && y > FY0 - pad && y < FY1 + pad;
    const inBounds = (b: number[]) => b[0] > X0 && b[2] < X1 && b[1] > Y0 && b[3] < Y1;
    // Beschriftungen ohne Überlappung: belegte Rechtecke merken, Überlappendes weglassen
    const placed: number[][] = [];
    const reserve = (x0: number, y0: number, x1: number, y1: number) => placed.push([x0, y0, x1, y1]);
    const free = (x0: number, y0: number, x1: number, y1: number) =>
      !placed.some((b) => x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]);
    // Gezeichneter Bereich in Grad (für Straßen-Auswahl)
    const corners = [
      [FX0, FY0],
      [FX1, FY0],
      [FX0, FY1],
      [FX1, FY1],
    ].map(([sx, sy]) => this.proj.toLatLon(...toWorld(cam, sx, sy)) as [number, number]);
    const south = Math.min(...corners.map((c) => c[0])) - 0.0008;
    const north = Math.max(...corners.map((c) => c[0])) + 0.0008;
    const west = Math.min(...corners.map((c) => c[1])) - 0.0012;
    const east = Math.max(...corners.map((c) => c[1])) + 0.0012;
    const { index, focus, emphasis, target, neighbors, draft, driveway, houses } = this.data;
    const carLL = this.carPos();
    const g0 = this.goal();
    const carS = g0 ? proj2(toScreen(cam, g0.x, g0.y)) : null;
    // Navi: Schrift weiter voraus etwas kleiner (wie Schilder in der Ferne), am Fahrzeug normal
    const fCar = P && carS ? factorScreen(P, carS[1]) : 1;
    const sig = (y: number) => (P ? Math.min(1.08, Math.max(0.62, Math.sqrt(fCar / factorScreen(P, y)))) : 1);
    /** Gruppe an einer Bildschirmstelle: innen gilt Bildschirmmaß, in der Navi-Ansicht entzerrt */
    const bb = (parent: Element, x: number, y: number, attrs: Record<string, string | number> = {}) => {
      let transform: string;
      if (P) {
        const [fx, fy] = unproject(P, x, y);
        const [a, b, c, d] = unskew(P, fx, fy);
        transform = `matrix(${a.toFixed(4)} ${b} ${c.toFixed(4)} ${d.toFixed(4)} ${fx.toFixed(1)} ${fy.toFixed(1)})`;
      } else transform = `translate(${x.toFixed(1)} ${y.toFixed(1)})`;
      return el('g', { ...attrs, transform }, parent);
    };

    // Vorrang: Ziel, Einfahrt, Nachbarn, Fahrzeug – Beschriftungen weichen ihnen aus
    if (target) {
      const [x, y] = toS(target.lat, target.lon);
      reserve(x - 26, y - 26, x + 26, y + 26);
    }
    if (driveway?.line.length) {
      const [x, y] = toS(driveway.line[0][0], driveway.line[0][1]);
      reserve(x - 30, y - 19, x + 30, y + 19);
    }
    // Weitere bekannte Einfahrten der Straße (klein, ohne Ziel): Marker an der Abzweigung
    const sameAs = (a: [number, number], b: [number, number] | undefined) => !!b && Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
    const andere = (focus?.driveways ?? []).filter((d) => d.line.length >= 2 && !sameAs(d.line[0], driveway?.line[0]));
    const andereS: [number, number][] = [];
    for (const d of andere) {
      const q = toS(d.line[0][0], d.line[0][1]);
      if (!visible(q[0], q[1])) continue;
      andereS.push(q);
      reserve(q[0] - 10, q[1] - 10, q[0] + 10, q[1] + 10);
    }
    for (const n of neighbors) {
      const [x, y] = toS(n.lat, n.lon);
      reserve(x - 13, y - 34, x + 13, y + 13);
    }
    if (carS) reserve(carS[0] - 21, carS[1] - 22, carS[0] + 21, carS[1] + 21);
    // Knöpfe und Maßstab auf der Karte freihalten (Lage gemerkt: kein Layout-Abfragen je Bild)
    if (!this.ctrlBoxes) {
      const boxes: number[][] = [];
      const cr = this.canvas.getBoundingClientRect();
      for (const box of [this.controls, this.corner]) {
        if (!box || !box.childElementCount) continue;
        for (const c of box.children) {
          const r = (c as HTMLElement).getBoundingClientRect();
          if (r.width) boxes.push([r.left - cr.left - 6, r.top - cr.top - 6, r.right - cr.left + 6, r.bottom - cr.top + 6]);
        }
      }
      this.ctrlBoxes = boxes;
    }
    for (const b of this.ctrlBoxes) reserve(b[0], b[1], b[2], b[3]);

    // Ziel außerhalb des freien Bereichs: Pfeil am Rand mit Entfernung (Einfahrt zuerst, falls vorhanden)
    const inset = 34;
    const offscreen = (lat: number, lon: number) => {
      const [x, y] = toS(lat, lon);
      return !(x > left + 8 && x < w - 8 && y > top + 8 && y < bottom - 8);
    };
    let arrow: { lat: number; lon: number; text: string } | null = null;
    const J0 = driveway?.line[0];
    if (J0 && offscreen(J0[0], J0[1])) arrow = { lat: J0[0], lon: J0[1], text: 'E' };
    else if (target && offscreen(target.lat, target.lon)) arrow = { lat: target.lat, lon: target.lon, text: target.label };
    let arrowDraw: (() => void) | null = null;
    if (arrow) {
      const from = carS ?? ([midX, (top + bottom) / 2] as [number, number]);
      const ref = g0 ? [g0.x, g0.y] : toWorld(cam, ...(P ? unproject(P, midX, (top + bottom) / 2) : ([midX, (top + bottom) / 2] as [number, number])));
      const [ax0, ay0] = this.proj.toXY(arrow.lat, arrow.lon);
      const r = (cam.rot * Math.PI) / 180;
      const dx = ax0 - ref[0];
      const dy = ay0 - ref[1];
      const angle = (Math.atan2(dx * Math.cos(r) - dy * Math.sin(r), dx * Math.sin(r) + dy * Math.cos(r)) * 180) / Math.PI;
      const ep = edgePoint([from[0] - left, from[1] - top], angle, w - left, bottom - top, inset);
      const px = ep[0] + left;
      const py = ep[1] + top;
      const dist = carLL ? distanceM(carLL[0], carLL[1], arrow.lat, arrow.lon) : null;
      const text = dist === null ? arrow.text : `${arrow.text} · ${dist >= 1000 ? (dist / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(dist / 5) * 5 + ' m'}`;
      // Beschriftung zur Kartenmitte hin versetzt, damit sie im Bild bleibt
      const a = (angle * Math.PI) / 180;
      const tw = text.length * 11 + 18;
      // Beschriftung nah am Pfeil (zur Kartenmitte hin oder daneben), nie über Fahrzeug, Maßstab
      // oder Knöpfen. Passt sie nirgends nah dran, bleibt nur der Pfeil (die Zielkarte nennt die Entfernung).
      const clampX = (x: number) => Math.min(w - tw / 2 - 6, Math.max(left + tw / 2 + 6, x));
      const clampY = (y: number) => Math.min(bottom - 14, Math.max(top + 28, y));
      const okBox = (x: number, y: number) => {
        const b = [x - tw / 2, y - 22, x + tw / 2, y + 12];
        if (!free(b[0], b[1], b[2], b[3])) return false;
        if (b[0] < px + 20 && b[2] > px - 20 && b[1] < py + 14 && b[3] > py - 24) return false;
        if (carS && b[0] < carS[0] + 30 && b[2] > carS[0] - 30 && b[1] < carS[1] + 30 && b[3] > carS[1] - 30) return false;
        return true;
      };
      const cx0 = px - Math.sin(a) * 38;
      const cy0 = py + Math.cos(a) * 38;
      const lage = ([
        [cx0, cy0],
        [px + tw / 2 + 26, py],
        [px - tw / 2 - 26, py],
        [cx0, cy0 - 36],
        [cx0, cy0 + 36],
      ] as [number, number][])
        .map(([x, y]) => [clampX(x), clampY(y)] as [number, number])
        .find(([x, y]) => Math.hypot(x - px, y - py) < tw / 2 + 60 && okBox(x, y));
      // Platz für den Pfeil freihalten, bevor die Hausnummern verteilt werden
      reserve(px - 26, py - 26, px + 26, py + 26);
      if (lage) reserve(lage[0] - tw / 2, lage[1] - 22, lage[0] + tw / 2, lage[1] + 12);
      arrowDraw = () => {
        const g = bb(svg, px, py, { class: 'edge-arrow' });
        el('path', { d: 'M0 -22 L16 8 L0 0 L-16 8 Z', transform: `rotate(${angle.toFixed(1)})`, class: 'edge-arrow-head' }, g);
        if (!lage) return;
        const [lx, ly] = lage;
        el('rect', { x: lx - px - tw / 2, y: ly - py - 20, width: tw, height: 30, rx: 15, class: 'edge-pill' }, g);
        const t = el('text', { x: lx - px, y: ly - py + 2, class: 'edge-label' }, g);
        t.textContent = text;
      };
    }
    const gOutl = el('g', { class: 'outlines' }, svg);
    // Hell wie Apple Karten: weiße Straßen mit feinem Rand (darunter, damit Kreuzungen sauber sind)
    const gCase = el('g', { class: 'cases' }, svg);
    const mitRand = document.documentElement.dataset.theme === 'light';
    const gStreets = el('g', {}, svg);
    const streetW = Math.max(4, Math.min(14, 6.5 * S));
    const pathOf = (line: [number, number][]) =>
      line
        .map(([la, lo], i) => {
          const [x, y] = toF(la, lo);
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
    // Gebäude (wenn im Paket enthalten): leicht gefüllt, damit Häuser als Häuser erkennbar sind
    if (S >= 1.2) {
      let verts = 0;
      for (const s of shown) {
        if (!s.outlines?.length) continue;
        let d = '';
        for (const o of s.outlines) {
          if (verts > 25000) break;
          const [fx, fy] = toF(o[0][0], o[0][1]);
          if (!visibleF(fx, fy, 80)) continue;
          verts += o.length;
          d +=
            o
              .map(([la, lo], i) => {
                const [x, y] = toF(la, lo);
                return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
              })
              .join('') + 'Z';
        }
        if (d) el('path', { d, class: 'bld-outline' }, gOutl);
      }
    }
    // Straßenlinien: Tour-Straßen stärker, Ziel-/aktuelle Straße hervorgehoben (mit Rand)
    const order = [...shown].sort((a, b) => rank(a) - rank(b));
    function rank(s: Street) {
      return s === focus ? 2 : emphasis.has(s.id) ? 1 : 0;
    }
    for (const s of order) {
      const r = rank(s);
      const cls = r === 2 ? 'st st-focus' : r === 1 ? 'st st-tour' : 'st';
      const sw = r === 2 ? streetW + 4 : r === 1 ? streetW + 2 : streetW;
      for (const line of s.lines) {
        const d = pathOf(line);
        if (r === 2) el('path', { d, class: 'st st-focus-case', 'stroke-width': sw + 4 }, gStreets);
        else if (mitRand) el('path', { d, class: 'st-case', 'stroke-width': sw + 2.5 }, gCase);
        el('path', { d, class: cls, 'stroke-width': sw }, gStreets);
      }
      if (!s.lines.length && s.start && s === focus) {
        const [x, y] = toF(s.start[0], s.start[1]);
        el('circle', { cx: x, cy: y, r: 8, class: 'st-start' }, gStreets);
      }
    }
    // Weitere Einfahrten der Straße: dünn gestrichelt
    for (const d of andere) el('path', { d: pathOf(d.line), class: 'drive-other', 'stroke-width': Math.max(2.5, streetW * 0.35) }, svg);
    // Zufahrt zum Ziel: kräftig in der Farbe ihrer Seite, mit hellem Rand (auf jeder Karte sichtbar)
    const dSide = driveway?.side === 'left' ? 'l' : driveway?.side === 'right' ? 'r' : 'n';
    if (driveway && driveway.line.length >= 2) {
      const dw = Math.max(5, streetW * 0.8);
      el('path', { d: pathOf(driveway.line), class: 'drive-case', 'stroke-width': dw + 4 }, svg);
      el('path', { d: pathOf(driveway.line), class: `drive drive-${dSide}` + (driveway.user ? ' drive-user' : ''), 'stroke-width': dw }, svg);
    }

    // ---------- Hausnummern: an jedem Haus, ohne Überlappung, nach Vorrang ----------
    // Die Nummer steht möglichst direkt auf dem Haus (statt Punkt + Nummer daneben): eindeutig
    // und platzsparend, so passen auch dicht stehende Häuser. Nur wenn das nicht geht, steht sie
    // neben dem Punkt. Nie über dem Punkt eines anderen Hauses (sonst ist sie nicht zuzuordnen).
    // Das nächste Haus je Straßenseite (oben groß) steht farbig hinterlegt: links blau, rechts orange.
    const gDots = el('g', {}, svg);
    const gNum = el('g', { class: 'numbers' }, svg);
    const targetNorm = target ? normHouseNumber(target.label) : '';
    type Haus = { n: HouseNumber; x: number; y: number; fx: number; fy: number; isFocus: boolean; label: boolean; street: string; mark: HouseMark | undefined };
    const haeuser: { item: Haus; street: string; x: number; y: number }[] = [];
    let dots = 0;
    for (const s of shown) {
      for (const n of s.numbers) {
        if (dots > 1800) break;
        const [fx, fy] = toF(n.lat, n.lon);
        const [x, y] = proj2([fx, fy]);
        if (!visible(x, y)) continue;
        dots++;
        // Zielnummer steht schon in der Zielmarkierung
        const label = !(s === focus && targetNorm && n.norm === targetNorm);
        const [wx, wy] = this.proj.toXY(n.lat, n.lon);
        // Seite und Abstand gelten für die Straße, auf der man fährt (auch wenn das Ziel woanders liegt)
        const mark = houses?.get(n);
        haeuser.push({ item: { n, x, y, fx, fy, isFocus: s === focus, label, street: s.id, mark }, street: s.id, x: wx, y: wy });
      }
    }
    // Mehrere Nummern an einem Haus (5, 5a, 5b …): eine gemeinsame Beschriftung
    const gruppen = groupSameHouse(haeuser);
    // Hauspunkte mit Gruppe: eine Beschriftung darf nur die Punkte ihres eigenen Hauses verdecken
    const dotBoxes: { g: number; b: number[] }[] = [];
    gruppen.forEach((g, i) =>
      g.forEach((hs) => {
        const r = 5 * sig(hs.y);
        dotBoxes.push({ g: i, b: [hs.x - r, hs.y - r, hs.x + r, hs.y + r] });
      }),
    );
    const freeDots = (x0: number, y0: number, x1: number, y1: number, eigene = -1) =>
      !dotBoxes.some(({ g, b: d }) => g !== eigene && x0 < d[2] && x1 > d[0] && y0 < d[3] && y1 > d[1]);
    type Item = {
      key: string;
      gruppe: number;
      text: string;
      x: number;
      y: number;
      isFocus: boolean;
      est: boolean;
      user: boolean;
      side: Side | null;
      next: boolean;
      passed: boolean;
    };
    const cands = gruppen.flatMap((g, i) => {
      const mit = g.filter((hs) => hs.label);
      if (!mit.length) return [];
      const marks = mit.map((hs) => hs.mark).filter((m): m is HouseMark => !!m);
      const nextMark = marks.find((m) => m.next);
      const text = joinHouseLabels(mit.map((hs) => (hs.n.user ? `•${hs.n.label}` : hs.n.label)));
      const it: Item = {
        key: `${g[0].street}|${text}`,
        gruppe: i,
        text,
        x: g.reduce((a, hs) => a + hs.x, 0) / g.length,
        y: g.reduce((a, hs) => a + hs.y, 0) / g.length,
        isFocus: g[0].isFocus,
        est: mit.every((hs) => hs.n.source === 'osm-interp'),
        user: mit.some((hs) => hs.n.user),
        side: nextMark?.side ?? marks[0]?.side ?? null,
        next: !!nextMark,
        passed: marks.length > 0 && marks.every((m) => m.ahead < -PASSED_DIM_M),
      };
      return [{ item: it, x: it.x, y: it.y, primary: it.isFocus, target: it.next }];
    });
    const minZoomForAll = this.live ? 0.9 : 1.6;
    const ordered = labelOrder(cands, carS, [midX, (top + bottom) / 2]);

    // Zuerst die beiden „nächsten“ Häuser: farbig hinterlegt, direkt auf dem Haus oder daneben
    type Pill = { it: Item; box: number[]; cx: number; cy: number; pw: number; ph: number; auf: boolean; fs: number };
    const pills: Pill[] = [];
    for (const it of ordered) {
      if (!it.next || !it.side) continue;
      const k = sig(it.y);
      // vom Fahrzeug weg ausweichen, falls es direkt daneben steht
      const weg = it.x < (carS?.[0] ?? midX) ? -1 : 1;
      // erst groß, bei dichter Bebauung kompakt (passt zwischen zwei Nachbarhäuser)
      const formen = [
        { fs: PILL_FONT * k, pad: 8 * k, padY: 6 * k },
        { fs: (PILL_FONT - 3) * k, pad: 5 * k, padY: 2 * k },
      ];
      let done = false;
      for (const { fs, pad, padY } of formen) {
        const tw = it.text.length * fs * 0.6 + 2;
        const pw = Math.max(tw + 2 * pad, fs + 2 * pad);
        const ph = fs + 2 * padY;
        const orte: [number, number, boolean][] = [
          [it.x, it.y, true],
          [it.x + weg * 12, it.y, true],
          [it.x + 8 + pw / 2, it.y, false],
          [it.x - 8 - pw / 2, it.y, false],
          [it.x, it.y - 9 - ph / 2, false],
          [it.x, it.y + 9 + ph / 2, false],
        ];
        for (const [cx, cy, auf] of orte) {
          // selbst gesetzte Punkte behalten ihr eigenes Zeichen (Quadrat)
          if (auf && it.user) continue;
          const box = [cx - pw / 2, cy - ph / 2, cx + pw / 2, cy + ph / 2];
          if (!inBounds(box) || !free(box[0], box[1], box[2], box[3]) || !freeDots(box[0], box[1], box[2], box[3], it.gruppe)) continue;
          reserve(box[0], box[1], box[2], box[3]);
          pills.push({ it, box, cx, cy, pw, ph, auf, fs });
          done = true;
          break;
        }
        if (done) break;
      }
    }
    const pillItems = new Set(pills.map((p) => p.it));
    const rest = ordered.filter((it) => !pillItems.has(it));

    /** Plätze: direkt auf dem Haus, sonst daneben (rechts, links, oben, unten, schräg oben) */
    const spots = (x: number, y: number, tw: number, size: number) => [
      // direkt aufs Haus: Ziffern sind etwa 0,72 Schriftgrößen hoch, dazu ein schmaler Rand
      { tx: x, ty: y + size * 0.36, anchor: 'middle', box: [x - tw / 2, y - size * 0.42, x + tw / 2, y + size * 0.42], auf: true },
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
      { eigen: NUMBER_FONT, fremd: 16 },
      { eigen: NUMBER_FONT_SMALL, fremd: 14 },
    ];
    type Platz = { it: Item; spot: ReturnType<typeof spots>[number]; size: number; k: number; sz: number };
    const memo = this.memo;
    /**
     * Verteilt die Nummern nach einer Reihenfolge von Versuchen (je Versuch: direkt aufs Haus
     * oder daneben, Schriftgröße). Rechnet auf einer Kopie der belegten Flächen, damit sich
     * zwei Anordnungen vergleichen lassen. Zuerst bekommt jede Nummer ihren Platz aus dem
     * letzten Bild, wenn er frei ist: Beim Fahren springen die Nummern dann nicht hin und her.
     */
    const platziere = (versuche: Array<{ auf: boolean | null; sz: number }>, jeHaus: boolean, nurSz = -1): Platz[] => {
      const belegt = placed.slice();
      const frei = (b: number[]) => !belegt.some((q) => b[0] < q[2] && b[2] > q[0] && b[1] < q[3] && b[3] > q[1]);
      const erg: Platz[] = [];
      const fertig = new Set<Item>();
      const passt = (it: Item, k: number, sz: number, auf: boolean | null): Platz | null => {
        const g = groessen[sz];
        const size = (it.isFocus ? g.eigen : g.fremd) * sig(it.y);
        // Ziffern sind schmaler als ein Geviert; der Rand (Halo) gehört zum Kasten
        const tw = it.text.length * size * 0.58 + 3;
        const all = spots(it.x, it.y, tw, size);
        const von = k < 0 ? 0 : k;
        const bis = k < 0 ? all.length : Math.min(all.length, k + 1);
        for (let i = von; i < bis; i++) {
          const p = all[i];
          if ((auf !== null && p.auf !== auf) || (p.auf && it.user)) continue;
          if (!inBounds(p.box) || !frei(p.box) || !freeDots(p.box[0], p.box[1], p.box[2], p.box[3], it.gruppe)) continue;
          return { it, spot: p, size, k: i, sz };
        }
        return null;
      };
      const nimm = (pl: Platz) => {
        belegt.push(pl.spot.box);
        erg.push(pl);
        fertig.add(pl.it);
      };
      const grenze = () => erg.length > 260 || (S < minZoomForAll && erg.length > 40);
      for (const it of rest) {
        if (grenze()) break;
        const m = memo.get(it.key);
        const pl = m && (nurSz < 0 || m.sz === nurSz) ? passt(it, m.k, m.sz, null) : null;
        if (pl) nimm(pl);
      }
      if (jeHaus) {
        // Haus für Haus nach Vorrang: der erste passende Versuch zählt
        for (const it of rest) {
          if (grenze()) break;
          if (fertig.has(it)) continue;
          for (const v of versuche) {
            const pl = passt(it, -1, v.sz, v.auf);
            if (pl) {
              nimm(pl);
              break;
            }
          }
        }
      } else {
        // Versuch für Versuch über alle Häuser (erst alle aufs Haus, dann daneben)
        for (const v of versuche)
          for (const it of rest) {
            if (grenze()) break;
            if (fertig.has(it)) continue;
            const pl = passt(it, -1, v.sz, v.auf);
            if (pl) nimm(pl);
          }
      }
      return erg;
    };
    // Zwei Anordnungen: (A) alle Nummern direkt aufs Haus, wo es geht – klar und ruhig;
    // (B) Haus für Haus der erste freie Platz – bringt bei sehr dichter Bebauung mehr unter.
    // Es gewinnt, was mehr Nummern zeigt (eigene Straße zählt doppelt).
    const A = platziere(
      [
        { auf: true, sz: 0 },
        { auf: true, sz: 1 },
        { auf: false, sz: 0 },
        { auf: false, sz: 1 },
      ],
      false,
    );
    const B = platziere(
      [
        { auf: null, sz: 0 },
        { auf: null, sz: 1 },
      ],
      true,
    );
    // (C) alles in der kleineren Schrift: bei dichter Bebauung ruhiger als abwechselnd groß und klein
    const C = platziere(
      [
        { auf: true, sz: 1 },
        { auf: false, sz: 1 },
      ],
      false,
      1,
    );
    const wert = (l: Platz[]) => l.reduce((a, p) => a + (p.it.isFocus ? 2 : 1) * (p.it.text.includes('–') ? 3 : p.it.text.split(',').length), 0);
    // Mehr Nummern gewinnen; bei Gleichstand eine einheitliche Schrift auf der eigenen Straße, dann A
    const einheitlich = (l: Platz[]) => new Set(l.filter((p) => p.it.isFocus).map((p) => p.sz)).size <= 1;
    // Die zuletzt gewählte Anordnung behält den Vorzug, solange keine klar besser ist (ruhiges Bild)
    const namen = new Map<Platz[], string>([
      [A, 'A'],
      [B, 'B'],
      [C, 'C'],
    ]);
    const note = (l: Platz[]) => wert(l) * 10 + (einheitlich(l) ? 5 : 0) + (l === A ? 1 : 0) + (namen.get(l) === this.layout ? 25 : 0);
    const gewaehlt = [A, B, C].reduce((best, l) => (note(l) > note(best) ? l : best));
    this.layout = namen.get(gewaehlt) ?? 'A';
    this.memo = new Map(gewaehlt.map((p) => [p.it.key, { k: p.k, sz: p.sz }]));
    const aufHaus = new Set<number>();
    const sideCls = (it: Item) => (it.isFocus && it.side ? ` hn-${it.side === 'left' ? 'l' : 'r'}` : '');
    for (const { it, spot, size } of gewaehlt) {
      reserve(spot.box[0], spot.box[1], spot.box[2], spot.box[3]);
      if (spot.auf) aufHaus.add(it.gruppe);
      // Selbst gesetzt: mit Punkt davor; geschätzt: kursiv (nicht nur Farbe); vorbei: blasser
      const cls = `hn-label${it.isFocus ? '' : ' hn-label-other'}${it.est ? ' hn-est-label' : ''}${it.user ? ' hn-user-label' : ''}${it.passed ? ' hn-passed' : ''}${sideCls(it)}`;
      const attrs: Record<string, string | number> = { 'text-anchor': spot.anchor, class: cls };
      if (size !== NUMBER_FONT) attrs.style = `font-size:${size.toFixed(1)}px`;
      const t = el('text', attrs, bb(gNum, spot.tx, spot.ty));
      t.textContent = it.text;
    }
    for (const p of pills) {
      if (p.auf) aufHaus.add(p.it.gruppe);
      const g = bb(gNum, p.cx, p.cy, { class: `hn-pill hn-pill-${p.it.side === 'left' ? 'l' : 'r'}${p.it.est ? ' hn-est-label' : ''}` });
      el('rect', { x: -p.pw / 2, y: -p.ph / 2, width: p.pw, height: p.ph, rx: p.ph / 2 }, g);
      const t = el('text', { y: p.fs * 0.36, 'text-anchor': 'middle', style: `font-size:${p.fs.toFixed(1)}px` }, g);
      t.textContent = p.it.text;
    }
    // Punkte nur für Häuser, deren Nummer nicht direkt auf dem Haus steht
    gruppen.forEach((g, i) => {
      if (aufHaus.has(i)) return;
      for (const hs of g) {
        const est = hs.n.source === 'osm-interp';
        const dim = hs.mark && hs.mark.ahead < -PASSED_DIM_M ? ' hn-passed' : '';
        if (hs.n.user) el('rect', { x: hs.fx - 4.5, y: hs.fy - 4.5, width: 9, height: 9, class: 'hn hn-user' + dim }, gDots);
        else el('circle', { cx: hs.fx, cy: hs.fy, r: 4, class: (est ? 'hn hn-est' : 'hn') + dim }, gDots);
      }
    });
    // Straßennamen meiden auch die Hauspunkte
    const freeAll = (x0: number, y0: number, x1: number, y1: number) => free(x0, y0, x1, y1) && freeDots(x0, y0, x1, y1);

    // Straßennamen: sparsam, entlang der Straße, nie über Hausnummern, Ziel oder Fahrzeug
    const gLabels = el('g', { class: 'labels' }, svg);
    const maxStreetLabels = this.live ? 5 : 40;
    const named = shown.filter((s) => s.lines.length).sort((a, b) => rank(b) - rank(a));
    const area = { x0: X0, y0: Y0, x1: X1, y1: Y1, top, bottom, left, w };
    const drawLabel = (cx: number, cy: number, ang: number, size: number, cls: string, text: string) => {
      const t = el('text', { y: size * 0.35, transform: `rotate(${ang.toFixed(1)})`, class: cls, style: `font-size:${size}px` }, bb(gLabels, cx, cy));
      t.textContent = text;
    };
    let labelCount = 0;
    for (const st of named) {
      if (labelCount >= maxStreetLabels) break;
      if (this.placeStreetLabel(st, st === focus, toS, area, freeAll, reserve, drawLabel, 15) || this.placeStreetLabel(st, st === focus, toS, area, freeAll, reserve, drawLabel, 13))
        labelCount++;
    }
    for (const n of neighbors) {
      const [x, y] = toS(n.lat, n.lon);
      el('circle', { r: 11, class: 'nb' }, bb(svg, x, y));
    }
    if (draft && draft.length) {
      el('path', { d: pathOf(draft), class: 'draft' }, svg);
      for (const [la, lo] of draft) {
        const [x, y] = toF(la, lo);
        el('circle', { cx: x, cy: y, r: 7, class: 'draft-pt' }, svg);
      }
    }
    for (const [x, y] of andereS) {
      const g = bb(svg, x, y, { class: 'jn-other' });
      el('circle', { r: 8, class: 'junction-other' }, g);
      const t = el('text', { y: 3.6, class: 'junction-other-label' }, g);
      t.textContent = 'E';
    }
    if (driveway && driveway.line.length) {
      // Abzweigung zum Ziel: „E“ in der Seitenfarbe, ein Pfeil zeigt zur Seite der Einfahrt
      const [x, y] = toS(driveway.line[0][0], driveway.line[0][1]);
      const g = bb(svg, x, y, { class: `jn jn-${dSide}` });
      if (dSide !== 'n') {
        const k = dSide === 'l' ? -1 : 1;
        el('path', { d: `M${k * 17} -9 L${k * 29} 0 L${k * 17} 9 Z`, class: 'junction-arrow' }, g);
      }
      el('circle', { r: 17, class: 'junction' }, g);
      const t = el('text', { y: 6.5, class: 'junction-label' }, g);
      t.textContent = 'E';
    }
    if (target) {
      const [x, y] = toS(target.lat, target.lon);
      const g = bb(svg, x, y);
      if (target.estimated) el('circle', { r: 31, class: 'target-est' }, g);
      el('circle', { r: 22, class: 'target' }, g);
      const t = el('text', { y: 7, class: 'target-label' + (target.estimated ? ' target-label-est' : '') }, g);
      t.textContent = target.label.length > 4 ? target.label.slice(0, 4) : target.label;
    }
    if (arrowDraw) arrowDraw();
    // Maßstab
    const meters = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].find((m) => m * S >= 40) ?? 10000;
    this.scaleEl.style.width = `${Math.round(meters * S)}px`;
    this.scaleEl.textContent = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
  }
}
