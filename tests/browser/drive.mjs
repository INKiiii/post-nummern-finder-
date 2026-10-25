#!/usr/bin/env node
// Browsertests in Handygröße mit simulierter GPS-Fahrt im erfundenen Testgebiet „Musterdorf“.
// Baut die App in einen temporären Ordner, legt die Demo-Gebiete dazu, startet einen kleinen
// Server und fährt mit einem simulierten GPS (Position, Genauigkeit, Geschwindigkeit, Kurs).
//
//   npm run test:browser
//
// Szenarien: lange Straße, Kurve, Kreuzung, Abbiegen, Umkehr (Schritttempo), Haus in zweiter
// Reihe, fehlende Nummer, Straße über zwei PLZ-Gebiete, Vorbeifahren, Eingabesperre bei Fahrt,
// Stillstand ohne Springen, Fahrtansicht (gleiche Markierung oben und auf der Karte, Gleiten
// zwischen zwei Positionen, kein Neuzeichnen im Stand). Echte Geräte verhalten sich anders (GPS-Rauschen, iOS) – siehe README.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { makeProjection } from '../../src/shared/geo.js';
import { SYNTH_ORIGIN } from '../../scripts/lib/synthetic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hnf-browser-'));
const dist = path.join(tmp, 'dist');
const quiet = { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] };

// ---------- Bauen und ausliefern ----------
execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], quiet);
fs.rmSync(path.join(dist, 'regions'), { recursive: true, force: true });
execFileSync(process.execPath, ['scripts/make-demo-data.mjs', '--out', path.join(dist, 'regions')], { cwd: ROOT, stdio: 'ignore' });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.gz': 'application/gzip', '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (!file.startsWith(dist)) return res.writeHead(403).end();
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

// ---------- Simuliertes GPS ----------
const proj = makeProjection(SYNTH_ORIGIN[0], SYNTH_ORIGIN[1]);
const fakeGeolocation = () => {
  const watchers = new Map();
  let id = 0;
  let last = null;
  const geo = {
    watchPosition(ok) {
      const i = ++id;
      watchers.set(i, ok);
      if (last) setTimeout(() => ok(last), 0);
      return i;
    },
    clearWatch(i) {
      watchers.delete(i);
    },
    getCurrentPosition(ok) {
      if (last) ok(last);
    },
  };
  Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
  window.__fix = (latitude, longitude, accuracy, speed, heading) => {
    last = { coords: { latitude, longitude, accuracy, speed, heading, altitude: null, altitudeAccuracy: null }, timestamp: Date.now() };
    for (const ok of watchers.values()) ok(last);
  };
};

/** Pseudo-Zufall mit festem Startwert */
let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

/**
 * Fährt einen Weg (x/y in Metern im Testgebiet) ab.
 * Schritttempo: Geschwindigkeit 1,2 m/s und unbrauchbarer Kurs (wie echte Geräte im Schritttempo).
 */
async function drive(page, pts, { speed = 1.2, step = 6, noise = 2.5, acc = 6 } = {}) {
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const course = ((Math.atan2(bx - ax, by - ay) * 180) / Math.PI + 360) % 360;
    for (let d = 0; d < len; d += step) {
      const f = d / len;
      const [lat, lon] = proj.toLatLon(ax + (bx - ax) * f + (rnd() - 0.5) * 2 * noise, ay + (by - ay) * f + (rnd() - 0.5) * 2 * noise);
      const heading = speed >= 2.5 ? course : rnd() * 360;
      await page.evaluate(([a, b, c, s, h]) => window.__fix(a, b, c, s, h), [lat, lon, acc, speed, heading]);
      await page.waitForTimeout(25);
    }
  }
  await page.waitForTimeout(150);
}
async function stand(page, x, y, n = 15, acc = 10) {
  for (let i = 0; i < n; i++) {
    const [lat, lon] = proj.toLatLon(x + (rnd() - 0.5) * 8, y + (rnd() - 0.5) * 8);
    await page.evaluate(([a, b, c, h]) => window.__fix(a, b, c, 0, h), [lat, lon, acc, rnd() * 360]);
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(150);
}

// ---------- Prüfungen ----------
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` – ${detail}` : ''}`);
}
const text = async (page, sel) => ((await page.locator(sel).first().textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
const nums = async (page, side) => (await page.locator(`.lt-${side} .lt-num`).allTextContents()).map((s) => s.trim()).filter(Boolean);
const parity = (list) => list.map((l) => Number.parseInt(l, 10) % 2);
const ascending = (list) => list.every((v, i) => !i || Number.parseInt(v, 10) >= Number.parseInt(list[i - 1], 10));
const descending = (list) => list.every((v, i) => !i || Number.parseInt(v, 10) <= Number.parseInt(list[i - 1], 10));

async function setTarget(page, nr) {
  await page.click('.lb-search');
  await page.waitForSelector('.screen-search');
  await page.locator('.near-card').click({ timeout: 2000 }).catch(() => {});
  for (const c of nr) await page.click(`.keys .key >> text="${c}"`);
  await page.click('.key.enter');
  await page.waitForSelector('.screen-live');
  await page.waitForTimeout(150);
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];
/** Neue Seite; storage: Einstellungen vorab (z. B. Kartenansicht) */
async function freshPage(storage = {}) {
  const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'], viewport: { width: 393, height: 760 }, locale: 'de-DE', serviceWorkers: 'block' });
  await ctx.addInitScript(fakeGeolocation);
  await ctx.addInitScript((st) => {
    for (const [k, v] of Object.entries(st)) localStorage.setItem(k, v);
  }, storage);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.fill('.screen-regions input.search', '0000');
  for (const n of ['00001 Musterdorf', '00002 Beispielhausen']) {
    await page.locator('.region', { hasText: n }).locator('button', { hasText: 'Herunterladen' }).click();
    await page.waitForSelector(`.region-list >> nth=0 >> text=${n}`);
  }
  await page.click('text=Zurück');
  await page.waitForSelector('.screen-live');
  return { ctx, page };
}

try {
  // 1. Lange Straße im Schritttempo, Kreuzung, zwei PLZ-Gebiete
  {
    const { ctx, page } = await freshPage();
    await drive(page, [[-900, -3], [-760, -3]]);
    const l = await nums(page, 'left');
    const r = await nums(page, 'right');
    check('Lange Straße (Schritttempo): Straße erkannt', (await text(page, '.lt-street')) === 'Elbuferstraße');
    check('Lange Straße: links ungerade, rechts gerade (Fahrt nach Osten)', l.length === 3 && r.length === 3 && parity(l).every((p) => p === 1) && parity(r).every((p) => p === 0), `links ${l.join(' ')} | rechts ${r.join(' ')}`);
    check('Lange Straße: Nummern voraus aufsteigend', ascending(l) && ascending(r));
    await drive(page, [[-760, -3], [-240, -3]], { speed: 1.4, step: 7 });
    check('Kreuzung (Blumenstraße) geradeaus: Straße bleibt', (await text(page, '.lt-street')) === 'Elbuferstraße');
    await drive(page, [[-240, -3], [0, -2], [120, 10]], { speed: 1.4, step: 7 });
    check('Über zwei PLZ-Gebiete: weiterhin dieselbe Straße', (await text(page, '.lt-street')) === 'Elbuferstraße', await text(page, '.lt-place'));
    // Kurve
    await drive(page, [[120, 10], [400, 38], [520, 38]], { speed: 1.4, step: 7 });
    const lk = await nums(page, 'left');
    check('Kurve: Straße bleibt, Vorschau weiter richtig', (await text(page, '.lt-street')) === 'Elbuferstraße' && parity(lk).every((p) => p === 1), `links ${lk.join(' ')}`);
    // Umkehr im Schritttempo
    await drive(page, [[520, 34], [470, 34]]);
    const lu = await nums(page, 'left');
    const ru = await nums(page, 'right');
    check('Umkehr (Schritttempo): Seiten getauscht', parity(lu).every((p) => p === 0) && parity(ru).every((p) => p === 1), `links ${lu.join(' ')} | rechts ${ru.join(' ')}`);
    check('Umkehr: Reihenfolge jetzt absteigend', descending(lu) && descending(ru));
    // Stillstand mit springendem GPS
    const before = await text(page, '.lt-preview');
    await stand(page, 470, 34);
    check('Stillstand: Vorschau springt nicht', (await text(page, '.lt-preview')) === before);
    await ctx.close();
  }

  // 2. Abbiegen, Ziel auf anderer Straße
  {
    const { ctx, page } = await freshPage();
    await drive(page, [[-420, -3], [-302, -3], [-302, 110]], { speed: 5, step: 5 });
    check('Abbiegen: neue Straße erkannt', (await text(page, '.lt-street')) === 'Blumenstraße');
    const l = await nums(page, 'left');
    check('Abbiegen: Seiten passen (Norden: West links)', parity(l).every((p) => p === 1), `links ${l.join(' ')}`);
    await ctx.close();
  }

  // 2b. Langsam abbiegen: Karte dreht sich mit; dicht bebaute Straße: Nummern stehen am Haus
  {
    const { ctx, page } = await freshPage();
    await drive(page, [[-420, -3], [-302, -3]], { speed: 5, step: 5 });
    await drive(page, [[-302, -3], [-302, 18]], { speed: 2, step: 2 });
    // Die neue Straße (hervorgehoben) läuft auf dem Bildschirm senkrecht: Fahrtrichtung oben
    const winkel = await page.evaluate(() => {
      const d = document.querySelector('.screen-live .map-svg .st-focus')?.getAttribute('d') ?? '';
      const p = [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
      if (p.length < 2) return null;
      const [a, b] = [p[0], p[p.length - 1]];
      return Math.abs((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI);
    });
    const senkrecht = winkel !== null && (winkel < 15 || winkel > 165);
    check('Langsam abgebogen (18 m): Karte dreht mit, Straße zeigt nach oben', (await text(page, '.lt-street')) === 'Blumenstraße' && senkrecht, `Winkel ${winkel?.toFixed(0)}°`);
    await ctx.close();
  }
  // Dicht bebaut: flache Karte (80 m voraus) – jede Nummer im Bild; Navi-Ansicht – im Nahbereich
  // (untere Hälfte des freien Bereichs) jede Nummer, weit voraus darf es enger werden
  const zaehle = (page, nurUnten) =>
    page.evaluate((unten) => {
      // Sichtbar ist die Karte zwischen Kopf und Leiste (die Karte liegt unter beiden)
      const svg = document.querySelector('.screen-live .map-svg');
      const c = document.querySelector('.screen-live .map-canvas').getBoundingClientRect();
      const top = document.querySelector('.live-top').getBoundingClientRect().bottom;
      const bottom = document.querySelector('.live-bottom').getBoundingClientRect().top;
      const r = { left: c.left, right: c.right, top: unten ? (top + bottom) / 2 : top, bottom };
      const drin = (e) => { const b = e.getBoundingClientRect(); return b.left >= r.left && b.right <= r.right && b.top >= r.top && b.bottom <= r.bottom; };
      const els = [...svg.querySelectorAll('.numbers text')].filter(drin);
      const texte = els.map((t) => t.textContent);
      // Punkt ohne Nummer: keine Beschriftung in 14 px Umkreis (sonst steht die Nummer daneben)
      const boxen = els.map((t) => t.getBoundingClientRect());
      const ohne = [...svg.querySelectorAll('.hn')].filter(drin).filter((d) => {
        const b = d.getBoundingClientRect();
        const x = b.left + b.width / 2;
        const y = b.top + b.height / 2;
        return !boxen.some((q) => x > q.left - 14 && x < q.right + 14 && y > q.top - 14 && y < q.bottom + 14);
      }).length;
      return { texte, nummern: texte.reduce((a, t) => a + (t.includes('–') ? 3 : t.split(',').length), 0), punkte: ohne };
    }, nurUnten);
  {
    const { ctx, page } = await freshPage({ 'hnf-map-mode2': 'navi' });
    await drive(page, [[-1000, 297], [-870, 297]], { speed: 2, step: 2 });
    const z = await zaehle(page, true);
    check('Navi-Ansicht, dicht bebaut: im Nahbereich jede Nummer beschriftet', z.nummern >= 10 && z.punkte <= 1, `${z.nummern} Nummern, ${z.punkte} Punkte`);
    await ctx.close();
  }
  {
    const { ctx, page } = await freshPage({ 'hnf-map-mode2': 'heading', 'hnf-map-level2': '3' });
    await drive(page, [[-1000, 297], [-870, 297]], { speed: 2, step: 2 });
    const z = await zaehle(page, false);
    check('Dicht bebaut (Lindenhof, flach): Nummern im Bild beschriftet, kaum Punkte ohne Nummer', z.nummern >= 26 && z.punkte <= 6, `${z.nummern} Nummern, ${z.punkte} Punkte`);
    check('Mehrere Nummern an einem Haus zusammengefasst („33–33b“)', z.texte.includes('33–33b'));
    await ctx.close();
  }

  // 2c. Fahrtansicht: nächstes Haus je Seite oben und auf der Karte gleich, Fahrzeug fest im freien
  // Bereich, Karte gleitet zwischen zwei Positionen, im Stand wird nichts neu gezeichnet
  {
    const { ctx, page } = await freshPage();
    await drive(page, [[-900, -3], [-800, -3]], { speed: 6, step: 6 });
    const z = await page.evaluate(() => {
      const t = (s) => document.querySelector(s)?.textContent?.trim() ?? '';
      const car = document.querySelector('.map-car').getBoundingClientRect();
      const top = document.querySelector('.live-top').getBoundingClientRect().bottom;
      const bot = document.querySelector('.live-bottom').getBoundingClientRect().top;
      return { kl: t('.lt-left .lt-next'), kr: t('.lt-right .lt-next'), ml: t('.hn-pill-l text'), mr: t('.hn-pill-r text'), cx: car.left + car.width / 2, cy: car.top + car.height / 2, top, bot, w: innerWidth };
    });
    check('Nächstes Haus je Seite: oben und auf der Karte gleich markiert', z.kl && z.kl === z.ml && z.kr && z.kr === z.mr, `oben ${z.kl}/${z.kr}, Karte ${z.ml}/${z.mr}`);
    check('Fahrzeug im freien Kartenbereich (unten, mittig)', Math.abs(z.cx - z.w / 2) < 3 && z.cy > z.top + (z.bot - z.top) * 0.6 && z.cy < z.bot - 20, `x ${z.cx.toFixed(0)}, y ${z.cy.toFixed(0)} zwischen ${z.top.toFixed(0)} und ${z.bot.toFixed(0)}`);
    // Echte Taktung: eine Position pro Sekunde, 6 m/s nach Osten
    const fixAt = async (x) => {
      const [lat, lon] = proj.toLatLon(x, -3);
      await page.evaluate(([a, b]) => window.__fix(a, b, 5, 6, 90), [lat, lon]);
    };
    for (const x of [-794, -788]) {
      await fixAt(x);
      await page.waitForTimeout(1000);
    }
    await page.evaluate(() => {
      const svg = document.querySelector('.screen-live .map-svg');
      window.__renders = 0;
      new MutationObserver(() => window.__renders++).observe(svg, { childList: true });
    });
    await fixAt(-782);
    const glide = await page.evaluate(
      () =>
        new Promise((done) => {
          const svg = document.querySelector('.screen-live .map-svg');
          const tf = new Set();
          const cars = [];
          const t0 = performance.now();
          const step = () => {
            tf.add(svg.style.transform);
            const r = document.querySelector('.map-car').getBoundingClientRect();
            cars.push(r.top);
            if (performance.now() - t0 < 600) requestAnimationFrame(step);
            else done({ stufen: tf.size, carSpan: Math.max(...cars) - Math.min(...cars), renders: window.__renders });
          };
          requestAnimationFrame(step);
        }),
    );
    check('Karte gleitet zwischen zwei Positionen (Fahrzeug bleibt stehen)', glide.stufen >= 10 && glide.carSpan < 1.5 && glide.renders <= 1, `${glide.stufen} Zwischenstellungen, Fahrzeug ±${glide.carSpan.toFixed(1)} px, ${glide.renders}× neu gezeichnet`);
    // Anhalten: Die Vorausberechnung wird einmal zurückgenommen, danach steht alles
    await stand(page, -782, -3, 4, 8);
    await page.waitForTimeout(500);
    await page.evaluate(() => (window.__renders = 0));
    await stand(page, -782, -3, 12, 8);
    const still = await page.evaluate(() => window.__renders);
    check('Stillstand: Karte wird nicht neu gezeichnet (Akku)', still === 0, `${still}× neu gezeichnet`);
    await ctx.close();
  }

  // 3. Haus in zweiter Reihe, Vorbeifahren, Eingabesperre
  {
    const { ctx, page } = await freshPage();
    await drive(page, [[-720, -3], [-680, -3]]);
    await setTarget(page, '61');
    await drive(page, [[-680, -3], [-450, -3]], { speed: 6, step: 6 });
    const side = await text(page, '.live-target .side');
    check('Zweite Reihe: Führung zur Einfahrt links', side === 'EINFAHRT LINKS', `${await text(page, '.live-target .dist')} ${side}`);
    check('Eingabesperre bei Fahrt: „Nr. suchen“ gesperrt', await page.locator('.lb-search').isDisabled(), await text(page, '.lb-search'));
    await drive(page, [[-450, -3], [-400, -3]], { speed: 1, step: 5 });
    check('Im Stand: „Nr. suchen“ wieder frei', !(await page.locator('.lb-search').isDisabled()));
    // Haus (2. Reihe) und Einfahrt sichtbar, nicht unter den Knöpfen
    const box = await page.evaluate(() => {
      const c = document.querySelector('.screen-live .map-canvas').getBoundingClientRect();
      const top = document.querySelector('.live-top').getBoundingClientRect().bottom;
      return { x: c.left, y: top, width: c.width, height: document.querySelector('.live-bottom').getBoundingClientRect().top - top };
    });
    const t = await page.locator('circle.target').boundingBox();
    const j = await page.locator('circle.junction').boundingBox();
    const ctl = await page.locator('.map-ctrl').boundingBox();
    const inside = (b) => b && b.x >= box.x && b.y >= box.y && b.x + b.width <= box.x + box.width && b.y + b.height <= box.y + box.height;
    const overlaps = (a, b) => a && b && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    check('Zweite Reihe: Haus und Einfahrt im Bild', inside(t) && inside(j));
    check('Zweite Reihe: Haus nicht unter den Zoomknöpfen', !overlaps(t, ctl));
    await drive(page, [[-400, -3], [-330, -3]], { speed: 1.2, step: 6 });
    const passed = await text(page, '.live-target .dist');
    check('Vorbeigefahren: „Zurück … m“ in Warnfarbe', /^Zurück \d+ m$/.test(passed) && (await page.locator('.live-target.dir-behind').count()) === 1, passed);
    await ctx.close();
  }

  // 4. Fehlende Nummer (geschätzt) und eigener Punkt
  {
    const { ctx, page } = await freshPage();
    await drive(page, [[-960, -3], [-920, -3]]);
    await setTarget(page, '17');
    const tags = await text(page, '.live-target .tags');
    check('Fehlende Nummer: als „geschätzt“ markiert', tags.includes('geschätzt'), tags);
    check('Fehlende Nummer: Seite links (ungerade, Fahrt nach Osten)', (await text(page, '.live-target .side')) === 'LINKS');
    await drive(page, [[-920, -3], [-821, -3]]);
    await page.click('.lb-here');
    await page.click('.here-side:has-text("Links")');
    await page.waitForTimeout(150);
    const t2 = await text(page, '.live-target .tags');
    check('„Hier ist Nr. 17“: selbst gesetzt, nicht mehr geschätzt', t2.includes('selbst gesetzt') && !t2.includes('geschätzt'), t2);
    check('Karte: selbst gesetzter Punkt anders gezeichnet (Quadrat statt Kreis)', (await page.locator('rect.hn-user').count()) === 1);
    await page.click('.toast-action');
    await page.waitForTimeout(150);
    check('Rückgängig: wieder geschätzt', (await text(page, '.live-target .tags')).includes('geschätzt'));
    await ctx.close();
  }
} catch (e) {
  check('Ablauf ohne Ausnahme', false, String(e?.message ?? e).split('\n')[0]);
} finally {
  await browser.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

check('Keine Fehler in der Seite', errors.length === 0, errors.join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} Browserprüfungen bestanden.`);
process.exit(failed.length ? 1 : 0);
