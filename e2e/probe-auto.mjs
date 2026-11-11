// Checks the Auto tone button on each seeded RAW. Usage: node e2e/probe-auto.mjs <out-dir> <asset-id>...
import { join } from 'node:path';
import { chromium } from 'playwright-core';
const BASE = 'http://127.0.0.1:8088';
const [out, ...ids] = process.argv.slice(2);
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
  await page.waitForTimeout(600);
  const name = await page.evaluate(() => globalThis.__editor.asset.originalFileName);
  // Start from defaults so Auto's effect is visible on its own.
  await page.evaluate(() => globalThis.__editor.resetAll());
  await page.waitForTimeout(400);
  await page.locator('.frame canvas').screenshot({ path: join(out, `${name}-1-default.png`) });
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  await page.waitForTimeout(500);
  const basic = await page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__editor.recipe.basic)));
  await page.locator('.frame canvas').screenshot({ path: join(out, `${name}-2-auto.png`) });
  // Shift+double-click Exposure after nudging it: only Exposure goes back to the auto value.
  await page.evaluate(() => globalThis.__editor.recipe.basic.exposure = 1.5);
  await page.locator('.row .label', { hasText: /^Exposure$/ }).dblclick({ modifiers: ['Shift'] });
  await page.waitForTimeout(200);
  const single = await page.evaluate(() => globalThis.__editor.recipe.basic.exposure);
  // Ctrl+U after an undo re-applies Auto.
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.locator('.frame canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+u');
  await page.waitForTimeout(200);
  const viaKey = await page.evaluate(() => globalThis.__editor.recipe.basic.exposure);
  const hist = await page.evaluate(() => globalThis.__editor.historySteps.slice(-4).map((s) => s.label));
  results.push({ name, auto: { exposure: basic.exposure, contrast: basic.contrast, highlights: basic.highlights, shadows: basic.shadows, whites: basic.whites, blacks: basic.blacks }, single, viaKey, hist, errors });
  await page.close();
}
console.log(JSON.stringify(results, null, 1));
await browser.close();
