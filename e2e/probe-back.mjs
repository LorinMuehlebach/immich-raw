// Saving and going back to Immich when the editor was opened from the render (top of the
// stack): Immich must open the new render and show its preview.
// Usage: node e2e/probe-back.mjs <raw-asset-id> <out.png>
import { chromium } from 'playwright-core';

const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
const [rawId, shot] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-gpu', '--use-angle=d3d11'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'admin@example.com', password: 'raw-editor-e2e' } });
const page = await ctx.newPage();
const meta = await (await ctx.request.get(`${BASE}/api/assets/${rawId}/metadata`)).json();
const oldRender = meta.find((m) => m.key === 'raw-editor.recipe')?.value?.render?.assetId;
if (!oldRender) throw new Error('the RAW has no saved render; save it once first');
await page.goto(`${BASE}/immich-raw/?asset=${rawId}&debug&return=${encodeURIComponent(`/photos/${oldRender}`)}`);
await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
const before = await page.evaluate(() => globalThis.__editor.recipe.basic.contrast);
await page.evaluate((v) => globalThis.__editor.setParam({ path: 'basic.contrast', label: 'Contrast', min: -100, max: 100, default: 0, step: 1, decimals: 0 }, v, true), before === 31 ? 17 : 31);
// Save in place first: the editor's own address must then name the new render.
await page.evaluate(() => globalThis.__editor.save());
const savedRender = await page.evaluate(() => globalThis.__editor.recipe.render.assetId);
const editorReturn = new URL(page.url()).searchParams.get('return');
await page.evaluate((v) => globalThis.__editor.setParam({ path: 'basic.contrast', label: 'Contrast', min: -100, max: 100, default: 0, step: 1, decimals: 0 }, v, true), before === 31 ? 22 : 31);
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Yes' }).click();
const t0 = Date.now();
await page.waitForURL((u) => u.pathname.startsWith('/photos/'), { timeout: 300000 });
const landed = new URL(page.url()).pathname.split('/').pop();
const newMeta = await (await ctx.request.get(`${BASE}/api/assets/${rawId}/metadata`)).json();
const newRender = newMeta.find((m) => m.key === 'raw-editor.recipe')?.value?.render?.assetId;
// The viewer shows the asset's preview image once it has loaded.
await page.waitForFunction((id) => [...document.images].some((i) => i.src.includes(id) && i.complete && i.naturalWidth > 0), newRender, { timeout: 30000 }).catch(() => {});
const shown = await page.evaluate((id) => [...document.images].some((i) => i.src.includes(id) && i.naturalWidth > 0), newRender);
await page.screenshot({ path: shot });
console.log(JSON.stringify({ editorReturnAfterSave: editorReturn === `/photos/${savedRender}` ? 'new render' : editorReturn, oldRender, newRender, landedOnNew: landed === newRender, seconds: Math.round((Date.now() - t0) / 1000), newImageShown: shown }, null, 1));
await browser.close();
