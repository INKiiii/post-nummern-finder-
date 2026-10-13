/**
 * Browsertest: startet `vite preview` (vorher `npm run build`), öffnet die App in Chromium
 * (Laptop- und Handygröße), klickt die wichtigsten Abläufe durch, sammelt Konsolenfehler,
 * misst grob die Bildrate und speichert Bildschirmfotos.
 *
 *   npm run build && npm run test:browser [-- --out ordner]
 */
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const outIdx = process.argv.indexOf('--out');
const out = outIdx > 0 ? process.argv[outIdx + 1] : 'test-results/browser';
fs.mkdirSync(out, { recursive: true });

const port = 4179;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort'], { stdio: 'pipe' });
await new Promise((ok, fehler) => {
  const t = setTimeout(() => fehler(new Error('vite preview startet nicht')), 20000);
  server.stdout.on('data', (d) => {
    if (String(d).includes(String(port))) {
      clearTimeout(t);
      ok();
    }
  });
});

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const fehler = [];
const bild = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const fps = (page) =>
  page.evaluate(
    () =>
      new Promise((ok) => {
        let n = 0;
        const t0 = performance.now();
        const f = () => {
          n++;
          if (performance.now() - t0 < 2000) requestAnimationFrame(f);
          else ok(Math.round((n * 1000) / (performance.now() - t0)));
        };
        requestAnimationFrame(f);
      }),
  );

/** Zeitleiste per Regler auf eine Uhrzeit (Minuten) stellen */
const zeitStellen = (page, minuten) =>
  page.locator('.regler').first().evaluate((el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, minuten);

try {
  for (const [name, opts] of [
    ['laptop', { viewport: { width: 1440, height: 900 } }],
    ['iphone', { ...devices['iPhone 13'] }],
  ]) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    let schritt = 'Start';
    const beobachten = (p, wer) => {
      p.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') fehler.push(`[${name}/${wer} · ${schritt}] ${m.type()}: ${m.text()}`);
      });
      p.on('pageerror', (e) => fehler.push(`[${name}/${wer} · ${schritt}] pageerror: ${e.message}`));
    };
    beobachten(page, 'leitstand');
    const s = (x) => {
      schritt = x;
      console.log(`[${name}] ${x}`);
    };
    const schmal = name === 'iphone';

    s('3D-Leitstand');
    await page.goto(`http://localhost:${port}/`);
    await page.waitForSelector('canvas', { timeout: 30000 });
    await page.waitForTimeout(2500);
    await bild(page, `${name}-3d-uebersicht`);
    console.log(`[${name}] Bildrate (Software-Rendering, nur Anhaltspunkt): ${await fps(page)} fps`);

    s('Basis zeigen');
    await page.getByRole('button', { name: 'Basis zeigen' }).click();
    await page.waitForTimeout(2200);
    await bild(page, `${name}-3d-basis`);

    s('Uhr läuft (Beladen)');
    if ((await page.locator('.regler-marken span').count()) < 3) fehler.push(`[${name}] Zeitleiste ohne Stundenmarken`);
    await zeitStellen(page, 7 * 60 + 18);
    await page.waitForTimeout(1500);
    await bild(page, `${name}-3d-beladen`);

    s('Abfahrt');
    await zeitStellen(page, 7 * 60 + 31.5);
    await page.waitForTimeout(1200);
    await bild(page, `${name}-3d-abfahrt`);

    s('Vormittag');
    await zeitStellen(page, 10 * 60);
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Menü' }).click();
    await page.getByRole('button', { name: 'Ganze Karte' }).click();
    await page.locator('button[aria-label="Start"]').first().click();
    await page.waitForTimeout(2500);
    await bild(page, `${name}-3d-vormittag`);

    s('Tour wählen');
    if (schmal) await page.locator('.blatt-tabs button').first().click().catch(() => {});
    await page.locator('.tour-zeile:visible').nth(1).click();
    await page.waitForSelector('.panel .route');
    await page.waitForTimeout(2000);
    await bild(page, `${name}-3d-fahrzeug`);
    const geschaetzt = await page.locator('.panel .marke.geschaetzt').count();
    if (!geschaetzt) fehler.push(`[${name}] Fahrzeug-Panel zeigt keine Kennzeichnung „geschätzt“`);

    if (!schmal) {
      s('Folgen beim Zoomen');
      const cb = await page.locator('canvas').first().boundingBox();
      await page.mouse.move(cb.x + cb.width * 0.3, cb.y + cb.height * 0.35);
      await page.mouse.wheel(0, -250);
      await page.waitForTimeout(1500);
      const l1 = await page.locator('.fahrzeug-label.aktiv').boundingBox();
      await page.waitForTimeout(2500);
      const l2 = await page.locator('.fahrzeug-label.aktiv').boundingBox();
      if (l1 && l2 && Math.hypot(l2.x - l1.x, l2.y - l1.y) > 80) fehler.push(`[${name}] Kamera folgt dem Fahrzeug nach dem Zoomen nicht (${Math.round(l1.x)},${Math.round(l1.y)} → ${Math.round(l2.x)},${Math.round(l2.y)})`);
      await bild(page, `${name}-3d-folgen`);
    }

    s('Geräte-Ansicht');
    const geraet = await ctx.newPage();
    beobachten(geraet, 'gerät');
    await geraet.goto(`http://localhost:${port}/#/fahrer/T2`);
    await geraet.waitForSelector('.geraet-punkt.an', { timeout: 15000 });
    await geraet.waitForTimeout(800);
    await bild(geraet, `${name}-geraet`);

    s('Nachricht senden');
    await page.bringToFront();
    await page.locator('.panel .chip.text').first().click();
    await geraet.waitForSelector('.geraet-meldung', { timeout: 10000 });
    await bild(geraet, `${name}-geraet-nachricht`);
    await geraet.getByRole('button', { name: 'Verstanden' }).click();
    await page.waitForSelector('.nachrichten .gut', { timeout: 10000 });
    await bild(page, `${name}-3d-bestaetigt`);
    await geraet.close();

    if (!schmal) {
      s('Klick in Szene');
      await page.locator('button[aria-label="Pause"]').first().click().catch(() => {});
      await page.getByRole('button', { name: 'Basis zeigen' }).click();
      await page.waitForTimeout(2000);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      // knapp unter das Label von Tour 1: steht noch an der Rampe? sonst egal
      const labels = page.locator('.label-ebene .fahrzeug-label');
      if (await labels.count()) {
        const b = await labels.first().boundingBox();
        if (b && b.y > 80) {
          await page.mouse.click(b.x + b.width / 2, b.y + b.height + 30);
          await page.waitForTimeout(500);
        }
      }
    }

    if (!schmal) {
      s('Tasten');
      await page.evaluate(() => document.activeElement?.blur());
      const uhr = () => page.locator('.ls-uhr .uhr-klein').first().textContent();
      const vorher = await uhr();
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(400);
      const nachher = await uhr();
      const min = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      if (min(nachher) - min(vorher) !== 10) fehler.push(`[${name}] Pfeiltaste stellt die Uhr nicht 10 Minuten vor (${vorher} → ${nachher})`);
      await page.keyboard.press(' ');
      await page.waitForSelector('button[aria-label="Pause"]', { timeout: 3000 }).catch(() => fehler.push(`[${name}] Leertaste startet die Uhr nicht`));
      await page.keyboard.press(' ');
      await page.waitForSelector('button[aria-label="Start"]', { timeout: 3000 }).catch(() => fehler.push(`[${name}] Leertaste hält die Uhr nicht an`));
    }

    s('Draufsicht');
    if (schmal && (await page.locator('.panel-kopf button:visible').count())) await page.locator('.panel-kopf button:visible').click();
    await page.getByRole('button', { name: 'Draufsicht' }).click();
    await page.waitForTimeout(1500);
    await bild(page, `${name}-3d-draufsicht`);

    if (schmal) {
      s('Ereignisse (Handy)');
      await page.locator('.blatt-tabs button', { hasText: 'Ereignisse' }).click();
      await page.waitForTimeout(800);
      await bild(page, `${name}-ereignisse`);
    }

    s('Info');
    await page.getByRole('button', { name: 'Menü' }).click();
    await page.getByRole('button', { name: 'Info und Datenschutz' }).click();
    await page.waitForSelector('text=Datenschutz by Design');
    await page.keyboard.press('Escape');

    s('Datenquellen');
    await page.goto(`http://localhost:${port}/#/datenquellen`);
    await page.waitForSelector('text=Keine neue Hardware');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, `${name}-datenquellen.png`), fullPage: true });

    s('Rechenkern');
    await page.goto(`http://localhost:${port}/#/kern`);
    await page.waitForSelector('.karte-svg', { timeout: 20000 });
    await page.waitForTimeout(800);
    await bild(page, `${name}-kern`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
if (fehler.length) {
  console.error('Fehler:\n' + fehler.join('\n'));
  process.exit(1);
}
console.log(`Browsertest ok, Bilder in ${out}`);
