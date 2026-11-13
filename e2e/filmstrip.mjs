// The filmstrip: switching photos with the keys shows the next photo's look at once and keeps the
// page, and the keys work while a photo is still opening. Nothing is saved.
// Usage: node e2e/filmstrip.mjs <out-dir> [file name part]   (default: DSCF, a series with neighbours)
//   IMMICH_URL=http://127.0.0.1:5183   an editor dev server instead of the test Immich's own build
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const [outDir, part = 'DSCF'] = process.argv.slice(2);
if (!outDir) {
  console.error('Usage: node e2e/filmstrip.mjs <out-dir> [file name part]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const base = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
const LOGIN = { email: 'admin@example.com', password: 'raw-editor-e2e' };
const results = {};
const fail = (msg) => {
  results.error = msg;
  throw new Error(msg);
};

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? 'msedge',
  headless: !process.env.HEADED,
  args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
});
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const login = await context.request.post(`${base}/api/auth/login`, { data: LOGIN });
  if (!login.ok()) fail(`login failed: HTTP ${login.status()}`);
  const r = await context.request.post(`${base}/api/search/metadata`, { data: { originalFileName: part, size: 50 } });
  const raws = ((await r.json()).assets?.items ?? []).filter((a) => /\.(arw|nef|cr3|cr2|raf|dng|orf|rw2)$/i.test(a.originalFileName));
  raws.sort((a, b) => a.originalFileName.localeCompare(b.originalFileName));
  if (raws.length < 3) fail(`need 3 RAWs matching "${part}", found ${raws.length}`);
  const first = raws[0];

  const page = await context.newPage();
  const assetInUrl = () => new URL(page.url()).searchParams.get('asset');
  const shown = () => page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
  await page.goto(`${base}/immich-raw/?asset=${first.id}`);
  await shown();
  // A page loaded again would lose this.
  await page.evaluate(() => (window.__samePage = true));
  console.log(`opened ${first.originalFileName}`);

  // ------------------------------------------------ → shows the next photo's look at once
  // The filmstrip gets the looks of the photos around this one ready in the background.
  await page.waitForTimeout(2500);
  const before = assetInUrl();
  const t0 = Date.now();
  await page.keyboard.press('ArrowRight');
  await page.waitForURL((u) => new URL(u).searchParams.get('asset') !== before, { timeout: 10000 });
  const look = await page
    .waitForFunction(() => !!document.querySelector('.center-msg img.preview.sized') || !!document.querySelector('.frame:not(.hidden) canvas'), null, {
      timeout: 10000,
      polling: 'raf',
    })
    .then(() => Date.now() - t0);
  const lookWasPreview = await page.evaluate(() => !!document.querySelector('.center-msg img.preview.sized'));
  await shown();
  const ready = Date.now() - t0;
  results.next = { lookMs: look, lookWasPreview, readyMs: ready };
  console.log(`→: look after ${look} ms (${lookWasPreview ? 'stand-in' : 'already the photo'}), editable after ${ready} ms`);
  if (!(await page.evaluate(() => window.__samePage === true))) fail('→ loaded the page again');
  if (look > 1000) fail(`the look took ${look} ms`);

  // ------------------------------------------------ the keys work while a photo opens
  const second = assetInUrl();
  await page.keyboard.press('ArrowRight');
  await page.waitForURL((u) => new URL(u).searchParams.get('asset') !== second, { timeout: 10000 });
  const third = assetInUrl();
  // Right away, while the third photo is still opening.
  const opening = await page.evaluate(() => !document.querySelector('.frame:not(.hidden) canvas'));
  await page.keyboard.press('ArrowLeft');
  const back = await page
    .waitForURL((u) => new URL(u).searchParams.get('asset') === second, { timeout: 10000 })
    .then(() => true, () => false);
  results.whileOpening = { pressedWhileOpening: opening, wentBack: back };
  console.log(`← while the next photo was ${opening ? 'still opening' : 'already shown'}: ${back ? 'went back' : 'did nothing'}`);
  if (!back) fail('← did nothing while a photo was opening');
  if (third === second) fail('→ stayed on the same photo');
  await shown();
  await page.screenshot({ path: join(outDir, 'filmstrip.png') });
  console.log('ok');
} finally {
  writeFileSync(join(outDir, 'filmstrip.json'), JSON.stringify(results, null, 2));
  await browser.close();
}
