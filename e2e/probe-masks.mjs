// Checks masking and the Auto settings on one seeded RAW.
// Usage: node e2e/probe-masks.mjs <out-dir> <asset-id>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
const [out, id] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: !process.env.HEADED, args: ['--enable-gpu', '--use-angle=d3d11'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'admin@example.com', password: 'raw-editor-e2e' } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) });
const ed = (fn, arg) => page.evaluate(fn, arg);
const results = {};

await page.goto(`${BASE}/immich-raw/?asset=${id}&debug`);
await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
await page.waitForTimeout(500);
await ed(() => globalThis.__editor.resetAll());
const box = await page.locator('.frame canvas').boundingBox();
const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
async function dragOnPhoto(from, to, opts = {}) {
  const [x0, y0] = at(...from);
  const [x1, y1] = at(...to);
  if (opts.shift) await page.keyboard.down('Shift');
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8);
  await page.mouse.up();
  if (opts.shift) await page.keyboard.up('Shift');
  await page.waitForTimeout(250);
}

// 1. Linear gradient over the top, darkened.
await page.keyboard.press('Shift+W');
await page.waitForTimeout(200);
await page.keyboard.press('m');
await dragOnPhoto([0.5, 0.02], [0.5, 0.45]);
await page.locator('input[aria-label="Exposure"]').fill('-1.5');
await page.waitForTimeout(300);
await shot('1-linear-overlay');
await page.keyboard.press('o');
await page.waitForTimeout(300);
await shot('2-linear');
results.linear = await ed(() => JSON.parse(JSON.stringify(globalThis.__editor.recipe.masks)));

// 2. Radial gradient, brightened and warmed.
await page.keyboard.press('Shift+M');
await dragOnPhoto([0.62, 0.68], [0.8, 0.85]);
await page.locator('input[aria-label="Exposure"]').fill('1.2');
await page.locator('input[aria-label="Temp"]').fill('60');
await page.waitForTimeout(300);
await shot('3-radial');

// 3. Move the radial pin and resize it with a handle.
const pin = await ed(() => {
  const e = globalThis.__editor;
  const m = e.selectedMask;
  const c = m.components[0];
  return e.maskToView([c.cx, c.cy]);
});
const [px, py] = at(pin[0], pin[1]);
await page.mouse.move(px, py);
await page.mouse.down();
await page.mouse.move(px - 60, py - 40, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(250);
results.afterMove = await ed(() => {
  const c = globalThis.__editor.selectedMask.components[0];
  return { cx: c.cx, cy: c.cy, rx: c.rx, ry: c.ry };
});

// 4. Intersect the first mask with a luminance range (bright tones only).
await page.locator('.mask-row .name').first().click();
await page.locator('select[aria-label="Intersect mask with"]').selectOption('luminance');
await page.locator('input[aria-label="Range from"]').fill('55');
await page.waitForTimeout(300);
await page.keyboard.press('o');
await page.waitForTimeout(300);
await shot('4-intersect-overlay');
await page.keyboard.press('o');

// 5. Undo/redo of the last step, history labels, before view.
results.history = await ed(() => globalThis.__editor.historySteps.slice(-6).map((s) => s.label));
await page.keyboard.press('Control+z');
await page.waitForTimeout(150);
results.afterUndo = await ed(() => globalThis.__editor.recipe.masks.map((m) => m.components.map((c) => c.kind + ':' + c.mode)));
await page.keyboard.press('Control+Shift+z');
await page.waitForTimeout(150);
results.afterRedo = await ed(() => globalThis.__editor.recipe.masks.map((m) => m.components.map((c) => c.kind + ':' + c.mode)));
await page.keyboard.press('Shift+W');
await page.waitForTimeout(300);
await shot('5-result');

// 6. Zoomed in: handles must follow.
await page.keyboard.press('Shift+W');
await page.keyboard.press('z');
await page.waitForTimeout(800);
await shot('6-zoom-handles');
await page.keyboard.press('z');
await page.keyboard.press('Shift+W');

// 7. Auto settings: apply Auto, then change Brightness while Auto is the last step.
await page.getByRole('button', { name: 'Auto', exact: true }).click();
await page.waitForTimeout(200);
const ev1 = await ed(() => globalThis.__editor.recipe.basic.exposure);
await page.getByRole('button', { name: 'Auto settings' }).click();
await page.locator('input[aria-label="Brightness"]').fill('0.5');
await page.waitForTimeout(200);
const ev2 = await ed(() => globalThis.__editor.recipe.basic.exposure);
await shot('7-auto-settings');
results.auto = { ev1, ev2, steps: await ed(() => globalThis.__editor.historySteps.slice(-2).map((s) => s.label)) };
await page.locator('input[aria-label="Brightness"]').fill('0');

results.errors = errors;
console.log(JSON.stringify(results, null, 1));
await browser.close();
