// Takes the README screenshots on the test Immich, using a seeded sample photo: the button in
// Immich, the editor, a mask, the DNG dialog and the saved result back in Immich.
// Usage: node e2e/screenshots.mjs [out-dir] [filename-part]   (default: docs/images fuji-xt5)
// Resets that photo first (e2e/reset.mjs) and leaves it edited and saved.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
const [out = 'docs/images', part = 'fuji-xt5'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
execFileSync('node', ['e2e/reset.mjs', part], { stdio: 'inherit' });

const browser = await chromium.launch({ channel: 'msedge', headless: !process.env.HEADED, args: ['--enable-gpu', '--use-angle=d3d11'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' });
await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'admin@example.com', password: 'raw-editor-e2e' } });
const found = await (await ctx.request.post(`${BASE}/api/search/metadata`, { data: { originalFileName: part, size: 20 } })).json();
const raw = found.assets.items.find((a) => /\.(arw|nef|cr3|raf|dng)$/i.test(a.originalFileName));
if (!raw) throw new Error(`no seeded RAW matching "${part}": run node e2e/seed.mjs <samples> first`);

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = async (name) => {
  // No hover or focus tooltips in the picture.
  await page.mouse.move(800, 990);
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, `${name}.jpg`), type: 'jpeg', quality: 85 });
  console.log(`wrote ${join(out, `${name}.jpg`)}`);
};
const setSlider = async (label, value) => {
  const input = page.locator(`input[aria-label="${label}"]`).first();
  await input.fill(String(value));
  await input.press('Enter');
};
const blur = () => page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));

// 1. Immich's viewer with the Edit RAW button (outlined for the screenshot).
await page.goto(`${BASE}/photos/${raw.id}`);
const button = page.locator('[data-raw-editor-button]').first();
await button.waitFor({ timeout: 30000 });
await page.waitForTimeout(2500);
await page.addStyleTag({ content: '[data-raw-editor-button]{outline:4px solid #ff3b30 !important;outline-offset:4px;border-radius:9999px}' });
await shot('1-immich-button');

// 2. The editor, opened through the button: Auto tone plus a few sliders.
await button.click();
await page.waitForURL(/\/immich-raw\/\?asset=/, { timeout: 30000 });
await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
await page.waitForTimeout(1500);
await page.getByRole('button', { name: 'Auto', exact: true }).click();
await setSlider('Vibrance', 25);
await setSlider('Clarity', 15);
await setSlider('Dehaze', 10);
await blur();
await page.waitForTimeout(1500);
await shot('2-editor');

// 3. A linear gradient over the sky, darker and cooler, with the mask overlay shown.
const box = await page.locator('.frame:not(.hidden) canvas').boundingBox();
const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
await page.keyboard.press('Shift+W');
await page.waitForTimeout(300);
await page.keyboard.press('m');
const [x0, y0] = at(0.5, 0.05);
const [x1, y1] = at(0.5, 0.42);
await page.mouse.move(x0, y0);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10);
await page.mouse.up();
await setSlider('Exposure', -0.6);
await setSlider('Temp', -12);
await blur();
await page.waitForTimeout(1000);
await shot('3-masks');
await page.keyboard.press('o');
await page.keyboard.press('Shift+W');
await page.waitForTimeout(500);

// 4. Save to Immich, then build a lossy DNG (cancelled afterwards: the RAW stays).
await page.keyboard.press('Control+s');
await page.locator('.sub', { hasText: /· saved/ }).waitFor({ timeout: 300000 });
await page.getByRole('button', { name: 'DNG…' }).click();
await page.locator('input[name="dng-mode"]').first().check();
await page.getByRole('button', { name: 'Create DNG' }).click();
await page.getByRole('button', { name: 'Replace original' }).waitFor({ timeout: 600000 });
await page.waitForTimeout(500);
await shot('4-dng');
await page.getByRole('button', { name: 'Cancel' }).click();

// 5. Back in Immich: the edited JPEG, stacked on top of the RAW.
await page.locator('button.back').click();
await page.waitForURL((u) => !u.pathname.startsWith('/immich-raw/'), { timeout: 60000 });
await page.waitForTimeout(4000);
await shot('5-immich-result');

if (errors.length) console.log('page errors:', errors);
await browser.close();
