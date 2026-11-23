// Oberflächen-Test im Handyformat (iPhone 13): Login, Kanäle, Karten-Review mit Wischgeste,
// Editor, Warteschlange, Einstellungen. Prüft: kein horizontales Scrollen, große Tippflächen.
// Start: BASE_URL=http://127.0.0.1:8765 PASSWORD=… SHOTS=./shots node tests/e2e.mjs
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

// Playwright wird global oder im Projekt gesucht (CI installiert es, siehe Workflow)
const require = createRequire(import.meta.url)
const { chromium, devices } = require('playwright')

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765'
const PASSWORD = process.env.PASSWORD || 'demo-passwort-123'
const SHOTS = process.env.SHOTS || ''
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

const failures = []
const check = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '✓' : '✗'} ${msg}`) }

const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'de-DE', colorScheme: 'dark' })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon') && !m.text().startsWith('Failed to load resource')) errors.push(m.text()) })

async function noHorizontalScroll(name) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
  check(sw <= iw + 1, `${name}: kein horizontales Scrollen (${sw} ≤ ${iw})`)
}
async function shot(name) { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }) }

// --- Login
await page.goto(BASE + '/')
await page.getByLabel('Passwort').fill('falsch')
await page.getByRole('button', { name: 'Einloggen' }).click()
await page.getByRole('alert').waitFor()
check((await page.getByRole('alert').textContent()).includes('falsch'), 'Falsches Passwort wird abgelehnt')
await page.getByLabel('Passwort').fill(PASSWORD)
await page.getByRole('button', { name: 'Einloggen' }).click()
await page.getByRole('heading', { name: 'Kanäle' }).waitFor()
check(true, 'Login klappt')

// --- Kanäle
await page.getByText('MeinKollege').waitFor()
await page.waitForTimeout(400)
await shot('1-kanaele')
await noHorizontalScroll('Kanäle')
check(await page.getByRole('button', { name: 'Jetzt clippen' }).isVisible(), '„Jetzt clippen“ sichtbar bei laufender Aufnahme')
const clipBtn = await page.getByRole('button', { name: 'Jetzt clippen' }).boundingBox()
check(clipBtn && clipBtn.height >= 52, `„Jetzt clippen“ ist daumengroß (${clipBtn?.height}px)`)
const tabs = await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link').all()
for (const t of tabs) {
  const b = await t.boundingBox()
  if (b.height < 48) failures.push(`Tab zu klein: ${b.height}px`)
}
check(tabs.length === 4, 'Untere Navigation mit 4 Tabs')

// Kanal hinzufügen ohne Zustimmung geht nicht
await page.getByRole('button', { name: 'Kanal hinzufügen' }).first().click()
await page.getByLabel('Twitch-Name').fill('neuerkanal')
check(await page.getByRole('button', { name: 'Hinzufügen', exact: true }).isDisabled(), 'Ohne Zustimmung kein Kanal')
await page.getByLabel('Zustimmung').check()
await shot('2-kanal-hinzufuegen')
check(await page.getByRole('button', { name: 'Hinzufügen', exact: true }).isEnabled(), 'Mit Zustimmung freigeschaltet')
await page.getByRole('button', { name: 'Schließen' }).click()

// --- Review
await page.getByRole('link', { name: /Review/ }).click()
await page.getByRole('group', { name: /Clip:/ }).waitFor()
await page.waitForTimeout(800)
await shot('3-review')
await noHorizontalScroll('Review')
const before = await page.getByText(/\d+ offen/).textContent()
const card = page.getByRole('group', { name: /Clip:/ })
const box = await card.boundingBox()
// Wischgeste nach rechts = freigeben
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await page.mouse.down()
for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + box.width / 2 + i * 20, box.y + box.height / 2 + 5)
await shot('4-review-wischen')
await page.mouse.up()
await page.getByText(/Freigegeben/).first().waitFor({ timeout: 5000 })
check(true, 'Wischen nach rechts gibt frei')
await page.waitForTimeout(500)
const after = await page.getByText(/\d+ offen/).textContent()
check(parseInt(after) === parseInt(before) - 1, `Zähler sinkt (${before} → ${after})`)

// --- Editor
const editBtn = page.getByRole('button', { name: 'Bearbeiten' })
if (await editBtn.count()) {
  await editBtn.click()
  await page.getByRole('heading', { name: 'Clip bearbeiten' }).waitFor()
  await page.waitForTimeout(600)
  await shot('5-editor')
  await noHorizontalScroll('Editor')
  await page.getByRole('tab', { name: 'YouTube' }).click()
  check(await page.getByText(/Titel \(\d+\/100\)/).isVisible(), 'YouTube-Texte getrennt bearbeitbar')
  await page.getByRole('button', { name: 'Start +1' }).click()
  check(await page.getByRole('button', { name: 'Speichern', exact: true }).isEnabled(), 'Trim macht Änderungen speicherbar')
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await shot('6-editor-texte')
  await page.getByRole('button', { name: 'Speichern', exact: true }).click()
  await page.getByText('Gespeichert').first().waitFor()
  check(true, 'Speichern im Editor')
  await page.getByRole('button', { name: 'Zurück' }).click()
}

// --- Warteschlange
await page.getByRole('link', { name: /Plan/ }).click()
await page.getByRole('heading', { name: 'Warteschlange' }).waitFor()
await page.getByText('Heute noch möglich').waitFor()
await page.waitForTimeout(400)
await shot('7-warteschlange')
await noHorizontalScroll('Warteschlange')
check(await page.getByText('geplant').first().isVisible(), 'Freigegebene Clips sind eingeplant')

// --- Mehr / Einstellungen / Archiv / Auswertung
for (const [link, heading, name] of [['Einstellungen', 'Einstellungen', '8-einstellungen'], ['Archiv & Export', 'Archiv', '9-archiv'], ['Auswertung', 'Auswertung', '10-auswertung'], ['Konten', 'Konten', '11-konten']]) {
  await page.getByRole('link', { name: /Mehr/ }).click()
  await page.getByText(link, { exact: true }).click()
  await page.getByRole('heading', { name: heading }).waitFor()
  await page.waitForTimeout(400)
  await shot(name)
  await noHorizontalScroll(heading)
}

// --- Öffentliche Einladungsseite (ohne Login)
const ctx2 = await browser.newContext({ ...devices['iPhone 13'], locale: 'de-DE' })
const p2 = await ctx2.newPage()
await p2.goto(BASE + '/einladung/ungueltig')
await p2.getByText(/ungültig|abgelaufen/).waitFor()
check(true, 'Einladungsseite ohne Login erreichbar, ungültiger Link sauber abgefangen')

check(errors.length === 0, `Keine JS-Fehler (${errors.slice(0, 3).join(' | ')})`)
await browser.close()
if (failures.length) {
  console.error(`\n${failures.length} Prüfung(en) fehlgeschlagen`)
  process.exit(1)
}
console.log('\nAlle Oberflächen-Prüfungen bestanden')
