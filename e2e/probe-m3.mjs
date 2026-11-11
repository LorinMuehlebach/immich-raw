// Visual check of the M3 colour features. Usage: node e2e/probe-m3.mjs <raw-asset-id> <out-dir> [--save]
import { join } from 'node:path';
import { chromium } from 'playwright-core';
const BASE = 'http://127.0.0.1:8088';
const [id, out, flag] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-gpu', '--use-angle=d3d11'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'admin@example.com', password: 'raw-editor-e2e' } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`${BASE}/immich-raw/?asset=${id}&debug`);
await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
await page.waitForTimeout(700);
const shot = (name) => page.screenshot({ path: join(out, `m3-${name}.png`) });
const settle = () => page.waitForTimeout(500);
const timing = async () =>
  page.evaluate(() => {
    const ed = globalThis.__editor;
    const r = ed.renderer;
    const recipe = $state_snapshot(ed.recipe);
    function $state_snapshot(x) { return JSON.parse(JSON.stringify(x)); }
    r.render(recipe, { mode: 'edit' });
    r.histogram();
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) r.render(recipe, { mode: 'edit' });
    r.histogram(); // readback waits for the GPU
    return Math.round(((performance.now() - t0) / 10) * 10) / 10;
  });

await shot('0-start');
const baseMs = await timing();

// Color Mixer: saturation tab
await page.getByRole('button', { name: 'Color Mixer' }).click();
await page.locator('.tabs button', { hasText: 'Saturation' }).first().click();
await page.locator('input[aria-label="Blue"]').fill('-100');
await page.locator('input[aria-label="Orange"]').fill('60');
await page.locator('input[aria-label="Blue"]').dispatchEvent('change');
await settle();
await shot('1-mixer-sat');

// Hue tab: green towards aqua
await page.locator('.tabs button', { hasText: 'Hue' }).first().click();
await page.locator('input[aria-label="Green"]').fill('80');
await page.locator('input[aria-label="Green"]').dispatchEvent('change');
await settle();

// Targeted adjustment: luminance, drag down on the photo
await page.locator('.tabs button', { hasText: 'Luminance' }).first().click();
await page.getByRole('button', { name: 'Targeted adjustment' }).click();
const box = await page.locator('.frame canvas').boundingBox();
const px = box.x + box.width * 0.5;
const py = box.y + box.height * 0.2;
await page.mouse.move(px, py);
await page.waitForTimeout(150);
const hint = await page.locator('.badge.bottom').textContent();
await page.mouse.down();
await page.mouse.move(px, py + 80, { steps: 10 });
await page.mouse.up();
await settle();
const lum = await page.evaluate(() => ({ ...globalThis.__editor.recipe.colorMixer.luminance }));
await shot('2-tat');
await page.keyboard.press('Escape');

// Color Grading: teal shadows, warm highlights
await page.getByRole('button', { name: 'Color Grading' }).click();
const wheels = page.locator('.wheel');
await wheels.nth(1).scrollIntoViewIfNeeded();
const sh = await wheels.nth(1).boundingBox(); // shadows (midtones is first)
await page.mouse.move(sh.x + sh.width / 2, sh.y + sh.height / 2);
await page.mouse.down();
await page.mouse.move(sh.x + sh.width * 0.2, sh.y + sh.height * 0.62, { steps: 6 });
await page.mouse.up();
await page.evaluate(() => globalThis.__editor.setWheel('highlights', 40, 45, true));
await settle();
const grading = await page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__editor.recipe.colorGrading)));
await shot('3-grading');
await page.locator('section', { has: page.locator('.toggle', { hasText: 'Color Grading' }) }).screenshot({ path: join(out, 'm3-3b-grading-panel.png') });
const fullMs = await timing();

// Calibration: blue primary saturation
await page.evaluate(() => {
  const ed = globalThis.__editor;
  ed.recipe.calibration.blueSaturation = 60;
  ed.recipe.calibration.redHue = 30;
  ed.commit();
  ed.requestRender();
});
await settle();
await shot('4-calibration');
await page.getByRole('button', { name: 'Calibration' }).click();
await page.locator('section', { has: page.locator('.toggle', { hasText: 'Calibration' }) }).scrollIntoViewIfNeeded();
await page.locator('section', { has: page.locator('.toggle', { hasText: 'Calibration' }) }).screenshot({ path: join(out, 'm3-4b-calibration-panel.png') });

// Monochrome with B&W mix
await page.evaluate(() => {
  const ed = globalThis.__editor;
  ed.setProfile('monochrome');
  ed.recipe.bwMix.blue = -80;
  ed.recipe.bwMix.orange = 60;
  ed.recipe.bwMix.yellow = 40;
  ed.commit();
  ed.requestRender();
});
await settle();
await shot('5-bw');
const panelTitle = await page.locator('section header .toggle', { hasText: 'B&W' }).count();

let saved = null;
if (flag === '--save') {
  await page.waitForFunction(() => globalThis.__editor.fullStatus === 'ready', null, { timeout: 120000 });
  const t0 = Date.now();
  saved = await page.evaluate(() => globalThis.__editor.save());
  saved = { ok: saved, seconds: (Date.now() - t0) / 1000, render: await page.evaluate(() => globalThis.__editor.recipe.render?.assetId) };
}

const hist = await page.evaluate(() => globalThis.__editor.historySteps.map((s) => s.label));
console.log(JSON.stringify({ hint, lum, grading, baseMs, fullMs, bwPanel: panelTitle, saved, history: hist, errors }, null, 1));
await browser.close();
