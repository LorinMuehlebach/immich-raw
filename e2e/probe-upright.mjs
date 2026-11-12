// Guided Upright: drawing guides on the photo (Shift+T), the photo straightening so that they
// are vertical, adjusting and removing guides, guides that ask too much, Constrain Crop, and
// undo. Nothing is saved.
// Usage: node e2e/probe-upright.mjs <out-dir> [filename-part]   (default: nikon)
//   IMMICH_URL, INSECURE=1 as in smoke.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { API_BASE, PAGE_BASE, browserArgs, expectedConsoleError, loginOnPageOrigin } from './insecure.mjs';

const [outDir, namePart = 'nikon'] = process.argv.slice(2);
if (!outDir) {
  console.error('Usage: node e2e/probe-upright.mjs <out-dir> [filename-part]');
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
  const raw = found.assets?.items?.find((a) => /\.(arw|nef|cr3|raf|dng)$/i.test(a.originalFileName) && !a.isTrashed);
  if (!raw) throw new Error('seed the instance first: node e2e/seed.mjs <samples>');

  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && !expectedConsoleError(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${PAGE_BASE}/immich-raw/?asset=${raw.id}&debug`);
  await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => globalThis.__editor.resetAll());
  const settle = (ms = 600) => page.waitForTimeout(ms);
  await settle();

  const canvas = page.locator('.frame:not(.hidden) > canvas').first();
  const at = async (fx, fy) => {
    const box = await canvas.boundingBox();
    return [box.x + box.width * fx, box.y + box.height * fy];
  };
  const drag = async (from, to) => {
    const [x0, y0] = await at(...from);
    const [x1, y1] = await at(...to);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 8 });
    await page.mouse.up();
    await settle();
  };
  /** The guides as drawn on screen: degrees off vertical (or off horizontal, whichever is closer). */
  const onScreen = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('svg.upright .guide line.main')].map((l) => {
        const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((k) => Number(l.getAttribute(k)));
        const a = Math.abs((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI) % 180;
        return Math.round(Math.min(Math.abs(a - 90), a, 180 - a) * 1000) / 1000;
      }),
    );
  const guides = () => page.evaluate(() => globalThis.__editor.recipe.transform.upright?.guides ?? []);

  await page.keyboard.press('Shift+T');
  await settle();
  const st = await page.evaluate(() => ({ tool: globalThis.__editor.tool, whole: globalThis.__editor.wholeView }));
  check('Shift+T opens Guided Upright on the whole photo', st.tool === 'upright' && st.whole && (await page.locator('svg.upright').count()) === 1, st);

  // Two verticals that converge downwards, as from a camera looking down.
  await drag([0.25, 0.15], [0.3, 0.85]);
  let g = await guides();
  check('one guide: stored, and the photo turns until it is vertical', g.length === 1 && (await onScreen())[0] < 0.3, { guides: g.length, off: await onScreen() });
  await drag([0.78, 0.15], [0.72, 0.85]);
  g = await guides();
  const off2 = await onScreen();
  check('two converging guides: both vertical now', g.length === 2 && off2.every((d) => d < 0.3), { off: off2 });
  const focal = await page.evaluate(() => globalThis.__editor.recipe.transform.upright?.focal35);
  check('a focal length is stored with them', focal >= 8 && focal <= 800, { focal });
  await page.screenshot({ path: join(outDir, '1-two-guides.png') });

  // Drag the lower end of the first guide: still vertical after the new solve.
  const ends = page.locator('svg.upright .guide circle.end');
  const box = await ends.nth(1).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 25, box.y + box.height / 2 - 10, { steps: 5 });
  await page.mouse.up();
  await settle();
  const moved = await guides();
  check('dragging an end moves the guide, and it is vertical again', moved[0][2] !== g[0][2] && (await onScreen()).every((d) => d < 0.3), { off: await onScreen() });

  // A horizontal guide too.
  await drag([0.35, 0.5], [0.65, 0.53]);
  check('a third, horizontal guide', (await guides()).length === 3 && (await onScreen()).every((d) => d < 0.3), { off: await onScreen() });

  // Select the horizontal one and delete it.
  const lines = page.locator('svg.upright .guide line.hit');
  const lb = await lines.nth(2).boundingBox();
  await page.mouse.click(lb.x + lb.width / 2, lb.y + lb.height / 2);
  await page.keyboard.press('Delete');
  await settle();
  check('Delete removes the selected guide', (await guides()).length === 2, { guides: (await guides()).length });

  // Guides that ask too much do nothing, and say so.
  await page.evaluate(() => globalThis.__editor.clearUprightGuides());
  await drag([0.1, 0.9], [0.45, 0.1]);
  await drag([0.9, 0.9], [0.55, 0.1]);
  const failed = await page.evaluate(() => globalThis.__editor.uprightFailed);
  check('guides that would turn the photo too far: no effect, and a warning', failed && (await page.locator('.badge', { hasText: 'too far' }).count()) === 1, { failed });
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await settle();
  check('undo goes back through the guides', (await guides()).length === 2, { guides: (await guides()).length });

  // Done: back in the edit view; Constrain Crop keeps the crop inside the straightened photo.
  await page.keyboard.press('Enter');
  await settle();
  check('Enter leaves Guided Upright', (await page.evaluate(() => globalThis.__editor.tool)) === 'edit');
  await page.evaluate(() => globalThis.__editor.setConstrainCrop(true));
  await settle();
  const crop = await page.evaluate(() => ({ ...globalThis.__editor.recipe.crop }));
  check('Constrain Crop crops to the straightened photo', crop.w < 0.99 && crop.h < 0.99, crop);
  await page.screenshot({ path: join(outDir, '2-constrained.png') });

  await page.evaluate(() => globalThis.__editor.resetAll());
  check('no console errors', errors.length === 0, { errors: errors.slice(0, 5) });
} finally {
  await browser.close();
  writeFileSync(join(outDir, 'probe-upright.json'), JSON.stringify(results, null, 2));
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
