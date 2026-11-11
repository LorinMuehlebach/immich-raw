// Checks Transform, brush and colour range masks in the browser.
// Usage: node e2e/probe-local.mjs <out-dir> <asset-id>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
const [out, id] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-gpu', '--use-angle=d3d11'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'admin@example.com', password: 'raw-editor-e2e' } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`${BASE}/immich-raw/?asset=${id}&debug`);
await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
await page.waitForFunction(() => !globalThis.__editor.lensInfo.searching, null, { timeout: 30000 });
await page.evaluate(() => globalThis.__editor.resetAll());
await page.waitForTimeout(500);
const canvas = page.locator('.frame canvas');
const shot = async (name) => {
  await page.waitForTimeout(500);
  await canvas.screenshot({ path: join(out, `${name}.png`) });
};
const E = (fn, arg) => page.evaluate(fn, arg);
const report = {};

// Transform
await E(() => {
  const e = globalThis.__editor;
  const T = { vertical: 'transform.vertical', rotate: 'transform.rotate' };
  const spec = (path) => ({ path, label: path, min: -100, max: 100, default: 0, step: 1, decimals: 0 });
  e.setParam(spec(T.vertical), -45, true);
});
await shot('1-vertical-45');
await E(() => globalThis.__editor.setConstrainCrop(true));
await shot('2-constrained');
report.crop = await E(() => JSON.parse(JSON.stringify(globalThis.__editor.recipe.crop)));
await E(() => globalThis.__editor.resetAll());

// Brush, painted with the mouse.
await E(() => {
  const e = globalThis.__editor;
  e.setTool('mask');
  e.setBrush({ size: 30, feather: 60, flow: 100, density: 100 });
  e.startMask('brush');
});
await page.waitForTimeout(300);
const box = await canvas.boundingBox();
const at = (x, y) => [box.x + box.width * x, box.y + box.height * y];
await page.mouse.move(...at(0.2, 0.7));
await page.mouse.down();
for (let i = 0; i <= 30; i++) await page.mouse.move(...at(0.2 + 0.5 * (i / 30), 0.7 - 0.2 * Math.sin((i / 30) * Math.PI)));
await page.mouse.up();
await E(() => {
  const e = globalThis.__editor;
  e.setMaskParam({ path: 'adjust.exposure', label: 'Exposure', min: -4, max: 4, default: 0, step: 0.01, decimals: 2 }, 1.5, true);
});
await shot('3-brush');
// Erase part of it with Alt.
await page.keyboard.down('Alt');
await page.mouse.move(...at(0.45, 0.4));
await page.mouse.down();
await page.mouse.move(...at(0.45, 0.8), { steps: 15 });
await page.mouse.up();
await page.keyboard.up('Alt');
await shot('4-brush-erased');
report.brush = await E(() => {
  const m = globalThis.__editor.recipe.masks[0];
  return { comps: m.components.map((c) => ({ kind: c.kind, strokes: c.strokes?.map((s) => ({ erase: s.erase, n: s.points.length / 2, size: s.size })) })) };
});
report.history = await E(() => globalThis.__editor.historySteps.slice(-4).map((s) => s.label));
await E(() => globalThis.__editor.toggleMaskOverlay());
await shot('5-brush-overlay');
await E(() => globalThis.__editor.toggleMaskOverlay());

// Colour range on the sky (top middle), with Saturation -100.
await E(() => globalThis.__editor.resetAll());
await E(() => globalThis.__editor.startMask('color'));
await page.waitForTimeout(200);
await page.mouse.click(...at(0.5, 0.12));
await E(() => {
  const e = globalThis.__editor;
  e.setMaskParam({ path: 'adjust.saturation', label: 'Saturation', min: -100, max: 100, default: 0, step: 1, decimals: 0 }, -100, true);
});
await shot('6-color-range');
await page.keyboard.down('Shift');
await page.mouse.click(...at(0.15, 0.85));
await page.keyboard.up('Shift');
await shot('7-color-range-2');
report.color = await E(() => JSON.parse(JSON.stringify(globalThis.__editor.recipe.masks[0]?.components)));
await E(() => globalThis.__editor.toggleMaskOverlay());
await shot('8-color-overlay');

report.errors = errors;
console.log(JSON.stringify(report, null, 1));
await browser.close();
