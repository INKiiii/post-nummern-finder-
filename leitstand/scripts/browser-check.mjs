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

try {
  for (const [name, opts] of [
    ['laptop', { viewport: { width: 1440, height: 900 } }],
    ['iphone', { ...devices['iPhone 13'] }],
  ]) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    let schritt = 'Start';
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') fehler.push(`[${name} · ${schritt}] ${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => fehler.push(`[${name} · ${schritt}] pageerror: ${e.message}`));
    const s = (x) => {
      schritt = x;
      console.log(`[${name}] ${x}`);
    };
    const schmal = name === 'iphone';

    // 3D-Leitstand
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

    // Tour aus der Liste wählen → Fahrzeug-Panel, Kamera fliegt hin
    s('Tour wählen');
    await page.locator('.tour-zeile:visible').nth(1).click();
    await page.waitForSelector('.panel .route');
    await page.waitForTimeout(1800);
    await bild(page, `${name}-3d-fahrzeug`);

    // Klick in die Szene (Fahrzeug steht nach dem Flug in der Bildmitte)
    s('Klick in Szene');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    // knapp unter das Label von Tour 2 klicken: dort steht das Fahrzeug
    const label = await page.locator('.label-ebene .fahrzeug-label').nth(1).boundingBox();
    await page.mouse.click(label.x + label.width / 2, label.y + label.height + (schmal ? 16 : 30));
    await page.waitForTimeout(500);
    const treffer = await page.locator('.panel .route').count();
    if (!treffer) fehler.push(`[${name}] Klick auf das Fahrzeug in der Szene hat kein Panel geöffnet`);

    // Behälter aus der Ladung → Behälter-Panel
    s('Behälter wählen');
    await page.locator('.panel .chip:visible').first().click();
    await page.waitForSelector('.panel .mengen');
    await page.waitForTimeout(1800);
    await bild(page, `${name}-3d-behaelter`);

    // Draufsicht
    s('Draufsicht');
    if (schmal) await page.locator('.panel-kopf button:visible').click();
    await page.getByRole('button', { name: 'Draufsicht' }).click();
    await page.waitForTimeout(1500);
    await bild(page, `${name}-3d-draufsicht`);

    // Info und Datenschutz
    s('Info');
    await page.getByRole('button', { name: 'Menü' }).click();
    await page.getByRole('button', { name: 'Info und Datenschutz' }).click();
    await page.waitForSelector('text=Datenschutz by Design');
    await bild(page, `${name}-info`);
    await page.keyboard.press('Escape');

    // 2D-Prüfansicht des Rechenkerns
    s('Rechenkern');
    await page.goto(`http://localhost:${port}/#/kern`);
    await page.waitForSelector('.vorschlag', { timeout: 20000 });
    await page.locator('.vorschlag .knopf.primaer').first().click();
    await page.waitForTimeout(600);
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
