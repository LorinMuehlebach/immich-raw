// Debug tool: straightens + crops via the editor API and screenshots crop and edit mode.
// Usage: node e2e/probe-crop.mjs <raw-asset-id> <out-dir>
import { chromium } from 'playwright-core';
import { join } from 'node:path';
const BASE = 'http://127.0.0.1:8088';
const [id, out] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-gpu', '--use-angle=d3d11'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'admin@example.com', password: 'raw-editor-e2e' } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`${BASE}/immich-raw/?asset=${id}&debug`);
await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
await page.keyboard.press('r');
await page.evaluate(() => globalThis.__editor.setAspect('1:1'));
await page.locator('input[aria-label="Angle"]').fill('8');
await page.waitForTimeout(600);
await page.screenshot({ path: join(out, 'crop-mode.png') });
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.screenshot({ path: join(out, 'edit-mode.png') });
console.log(await page.evaluate(() => JSON.stringify(globalThis.__editor.recipe.crop)));
await browser.close();
