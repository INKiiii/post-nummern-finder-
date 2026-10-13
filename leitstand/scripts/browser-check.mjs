/**
 * Browsertest: baut nicht selbst, startet `vite preview`, öffnet die App in Chromium
 * (Laptop- und Handygröße), sammelt Konsolenfehler und speichert Bildschirmfotos.
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

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const fehler = [];
try {
  for (const [name, opts] of [
    ['laptop', { viewport: { width: 1440, height: 900 } }],
    ['iphone', { ...devices['iPhone 13'] }],
  ]) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') fehler.push(`[${name}] ${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => fehler.push(`[${name}] pageerror: ${e.message}`));
    console.log(`[${name}] öffne Seite`);
    await page.goto(`http://localhost:${port}/`);
    await page.waitForSelector('.vorschlag', { timeout: 20000 });
    await page.screenshot({ path: path.join(out, `${name}-start.png`), fullPage: name === 'laptop' });
    // Rechenweg öffnen
    await page.locator('.kennzahl .wert-knopf').first().click();
    await page.waitForSelector('.dialog');
    await page.screenshot({ path: path.join(out, `${name}-rechenweg.png`) });
    await page.keyboard.press('Escape');
    // Vorschlag übernehmen
    await page.locator('.vorschlag .knopf.primaer').first().click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(out, `${name}-nach-vorschlag.png`), fullPage: name === 'laptop' });
    // Behälter „Andere Tour“
    await page.locator('td .chip').first().click();
    await page.waitForSelector('text=Andere Tour');
    await page.screenshot({ path: path.join(out, `${name}-andere-tour.png`), fullPage: name === 'laptop' });
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
if (fehler.length) {
  console.error('Konsolenmeldungen:\n' + fehler.join('\n'));
  process.exit(1);
}
console.log(`Browsertest ok, Bilder in ${out}`);
