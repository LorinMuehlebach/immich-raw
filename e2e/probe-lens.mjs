// Checks Lens Corrections on each seeded RAW: profile found, CA measured, before/after shots.
// Usage: node e2e/probe-lens.mjs <out-dir> <asset-id>...
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
const [out, ...ids] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-gpu', '--use-angle=d3d11'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'admin@example.com', password: 'raw-editor-e2e' } });
const results = [];
for (const id of ids) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${BASE}/immich-raw/?asset=${id}&debug`);
  await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
  await page.waitForFunction(() => !globalThis.__editor.lensInfo.searching, null, { timeout: 30000 });
  await page.evaluate(() => globalThis.__editor.resetAll());
  await page.waitForTimeout(500);
  const name = await page.evaluate(() => globalThis.__editor.asset.originalFileName);
  const canvas = page.locator('.frame canvas');
  await page.evaluate(() => {
    const e = globalThis.__editor;
    e.setLensFlag('profile', false);
    e.setLensFlag('removeCA', false);
  });
  await page.waitForTimeout(400);
  await canvas.screenshot({ path: join(out, `${name}-1-off.png`) });
  await page.evaluate(() => {
    const e = globalThis.__editor;
    e.setLensFlag('profile', true);
    e.setLensFlag('removeCA', true);
  });
  await page.waitForTimeout(400);
  await canvas.screenshot({ path: join(out, `${name}-2-on.png`) });
  // Wait for the full decode so CA is measured at full resolution, then zoom into a corner.
  await page.waitForFunction(() => globalThis.__editor.fullStatus === 'ready', null, { timeout: 180000 });
  await page.waitForTimeout(300);
  const info = await page.evaluate(() => {
    const e = globalThis.__editor;
    const m = e.renderer.lensFor(JSON.parse(JSON.stringify(e.recipe)));
    return { ...JSON.parse(JSON.stringify(e.lensInfo)), candidates: e.lensInfo.candidates.length, zoom: m.zoom, geo: !!m.geo, ca: !!m.ca, vig: !!m.vig };
  });
  const box = await canvas.boundingBox();
  for (const [label, on] of [['ca-off', false], ['ca-on', true]]) {
    await page.evaluate((v) => globalThis.__editor.setLensFlag('removeCA', v), on);
    await page.evaluate(() => globalThis.__editor.setZoom(false));
    await page.waitForTimeout(200);
    await page.evaluate(([x, y]) => globalThis.__editor.toggleZoom(x, y), (process.env.POS ?? "0.06,0.08").split(",").map(Number));
    await page.waitForTimeout(900);
    // The zoomed view is centred on the point (unless it is clamped at the image edge).
    const z = await canvas.boundingBox();
    await page.screenshot({ path: join(out, `${name}-3-zoom-${label}.png`), clip: { x: z.x + z.width / 2 - 240, y: z.y + z.height / 2 - 160, width: 480, height: 320 } });
  }
  await page.evaluate(() => globalThis.__editor.setZoom(false));
  results.push({ name, ...info, errors });
  await page.close();
}
console.log(JSON.stringify(results, null, 1));
await browser.close();
