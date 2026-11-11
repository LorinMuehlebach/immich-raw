// Opens a RAW that has a Lightroom sidecar, applies the offer and prints the result.
// Usage: node e2e/probe-sidecar.mjs <raw-asset-id> <out-dir>
import { join } from 'node:path';
import { chromium } from 'playwright-core';
const BASE = 'http://127.0.0.1:8088';
const [id, out] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-gpu', '--use-angle=d3d11'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'admin@example.com', password: 'raw-editor-e2e' } });
const page = await ctx.newPage();
await page.goto(`${BASE}/immich-raw/?asset=${id}&debug`);
await page.locator('.banner').waitFor({ timeout: 120000 });
await page.waitForTimeout(500);
await page.screenshot({ path: join(out, 'sidecar-offer.png') });
console.log('offer', JSON.stringify(await page.evaluate(() => globalThis.__editor.sidecarOffer)));
await page.locator('.banner').getByRole('button', { name: 'Apply' }).click();
await page.waitForTimeout(600);
await page.screenshot({ path: join(out, 'sidecar-applied.png') });
console.log(JSON.stringify(await page.evaluate(() => { const r = globalThis.__editor.recipe; return { wb: r.wb, basic: r.basic, curve: r.toneCurve.point.master, history: globalThis.__editor.historySteps.map((s) => s.label) }; })));
await browser.close();
