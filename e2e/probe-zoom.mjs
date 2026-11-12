// Ctrl + mouse wheel zoom in the editor: zooms around the cursor, keeps the photo point under
// it in place, doesn't zoom the browser page, goes back to fit when zoomed out.
// Usage: node e2e/probe-zoom.mjs <out-dir> [filename-part]   (default: sony)
//   INSECURE=1 as in smoke.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { API_BASE, PAGE_BASE, browserArgs, expectedConsoleError, loginOnPageOrigin } from './insecure.mjs';

const [outDir, namePart = 'sony'] = process.argv.slice(2);
if (!outDir) {
  console.error('Usage: node e2e/probe-zoom.mjs <out-dir> [filename-part]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const LOGIN = { email: 'admin@example.com', password: 'raw-editor-e2e' };
const results = [];
const check = (name, ok, details = {}) => {
  results.push({ name, ok, details });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(details)}`);
};

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? 'msedge',
  headless: process.env.HEADED ? false : true,
  args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', ...browserArgs],
});
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await context.request.post(`${API_BASE}/api/auth/login`, { data: LOGIN });
  await loginOnPageOrigin(context, LOGIN);
  const found = await (await context.request.post(`${API_BASE}/api/search/metadata`, { data: { originalFileName: namePart, size: 10 } })).json();
  const raw = found.assets?.items?.find((a) => /\.(arw|nef|cr3|raf|dng)$/i.test(a.originalFileName));
  if (!raw) throw new Error('seed the instance first: node e2e/seed.mjs <samples>');

  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && !expectedConsoleError(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${PAGE_BASE}/immich-raw/?asset=${raw.id}&debug`);
  await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
  // Whether the page saw the wheel events as handled (so the browser doesn't zoom the page).
  await page.evaluate(() => addEventListener('wheel', (e) => (globalThis.__wheelPrevented = e.defaultPrevented)));
  const state = () =>
    page.evaluate(() => {
      const e = globalThis.__editor;
      return { on: e.zoom.on, scale: e.zoom.scale, full: !!e.fullImage, dpr: devicePixelRatio, prevented: globalThis.__wheelPrevented ?? null };
    });
  /** The frame point under page position (px, py), via the last rendered view. */
  const frameAt = (px, py) =>
    page.evaluate(([px, py]) => {
      const r = document.querySelector('.frame canvas').getBoundingClientRect();
      return globalThis.__editor.renderer.previewToFrame((px - r.left) / r.width, (py - r.top) / r.height);
    }, [px, py]);
  const settle = () => page.waitForTimeout(400);
  const wheel = async (notches) => {
    await page.keyboard.down('Control');
    for (let i = 0; i < Math.abs(notches); i++) {
      await page.mouse.wheel(0, notches < 0 ? -100 : 100);
      await page.waitForTimeout(60);
    }
    await page.keyboard.up('Control');
    await settle();
  };

  // The cursor, a bit off the centre of the photo.
  const box = await page.locator('.frame canvas').boundingBox();
  const px = Math.round(box.x + box.width * 0.42);
  const py = Math.round(box.y + box.height * 0.45);
  await page.mouse.move(px, py);
  const p0 = await frameAt(px, py);
  const s0 = await state();
  await page.screenshot({ path: join(outDir, '1-fit.png') });

  await wheel(-1);
  const s1 = await state();
  const p1 = await frameAt(px, py);
  check('one notch zooms in from fit', s1.on && s1.scale > 0, { scale: s1.scale });
  check('page itself not zoomed', s1.prevented === true && s1.dpr === s0.dpr, { prevented: s1.prevented, dpr: s1.dpr });
  const near = (a, b, tol) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;
  // Still shorter than the view: the photo stays centred vertically, so only x is anchored.
  check('point under the cursor stays (preview source, x)', Math.abs(p0[0] - p1[0]) < 0.003, { before: p0, after: p1 });

  await wheel(-3);
  const s2 = await state();
  const p2 = await frameAt(px, py);
  check('three more notches: twice the scale', Math.abs(s2.scale / s1.scale - 2) < 0.01, { scale: s2.scale });
  check('point under the cursor stays (half-size source)', near(p1, p2, 0.002), { before: p1, after: p2 });
  await page.screenshot({ path: join(outDir, '2-zoomed.png') });

  // Past 50 % before the full decode is there: the editor says it shows the half-size image,
  // and takes the message away once the full decode has finished.
  await wheel(-4);
  const early = await page.evaluate(() => ({ full: !!globalThis.__editor.fullImage, notice: globalThis.__editor.notice }));
  await page.waitForFunction(() => !!globalThis.__editor.fullImage, null, { timeout: 120000 });
  await settle();
  const later = await page.evaluate(() => globalThis.__editor.notice);
  check('half-size notice shown, then gone after the full decode', (early.full || /half-size/.test(early.notice ?? '')) && later === null, { earlyFull: early.full, earlyNotice: early.notice, later });
  await wheel(4);
  await wheel(-8);
  const s3 = await state();
  const p3 = await frameAt(px, py);
  check('zoomed past 100 % on the full decode', s3.scale > 1 && s3.full, { scale: s3.scale });
  check('point under the cursor stays (full source)', near(p2, p3, 0.001), { before: p2, after: p3 });
  await page.screenshot({ path: join(outDir, '3-past-100.png') });

  await wheel(-12);
  const s4 = await state();
  check('stops at 800 %', Math.abs(s4.scale - 8) < 1e-9, { scale: s4.scale });
  await page.screenshot({ path: join(outDir, '4-800.png') });

  // Panning still works at this zoom.
  await page.mouse.move(px, py);
  await page.mouse.down();
  await page.mouse.move(px + 120, py + 60, { steps: 5 });
  await page.mouse.up();
  await settle();
  const p5 = await frameAt(px + 120, py + 60);
  check('drag pans the zoomed photo', near(p5, p3, 0.0005), { under: p5, was: p3 });

  await wheel(30);
  const s6 = await state();
  check('zooming out goes back to fit', !s6.on, s6);
  await page.screenshot({ path: join(outDir, '5-back-to-fit.png') });

  // Plain wheel (no Ctrl) leaves the zoom alone.
  await page.mouse.wheel(0, -300);
  await settle();
  check('wheel without Ctrl does not zoom', !(await state()).on);
  check('no console errors', errors.length === 0, { errors: errors.slice(0, 5) });
} catch (e) {
  check('fatal', false, { error: String(e?.stack ?? e).slice(0, 800) });
} finally {
  await browser.close();
  writeFileSync(join(outDir, 'zoom.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
}
