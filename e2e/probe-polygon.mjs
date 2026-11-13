// Polygon and lasso masks: drawing them on the photo (clicks, closing on the first corner,
// Enter, Backspace, double-click; a dragged lasso), the mask changing only the inside, editing
// corners afterwards, the shortcut and undo. Nothing is saved.
// Usage: node e2e/probe-polygon.mjs <out-dir> [filename-part]   (default: nikon)
//   IMMICH_URL, INSECURE=1 as in smoke.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { API_BASE, PAGE_BASE, browserArgs, expectedConsoleError, loginOnPageOrigin } from './insecure.mjs';

const [outDir, namePart = 'nikon'] = process.argv.slice(2);
if (!outDir) {
  console.error('Usage: node e2e/probe-polygon.mjs <out-dir> [filename-part]');
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
  const settle = (ms = 500) => page.waitForTimeout(ms);
  await settle(800);

  const canvas = page.locator('.frame:not(.hidden) > canvas').first();
  const box = await canvas.boundingBox();
  /** Page position of (fx, fy) of the canvas. */
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const click = async (fx, fy, opts) => {
    const [x, y] = at(fx, fy);
    await page.mouse.click(x, y, opts);
    await page.waitForTimeout(80);
  };
  const state = () =>
    page.evaluate(() => {
      const e = globalThis.__editor;
      return {
        draft: e.maskDraft ? { kind: e.maskDraft.kind, corners: (e.maskDraft.points?.length ?? 0) / 2 } : null,
        masks: e.recipe.masks.map((m) => ({ name: m.name, parts: m.components.map((c) => ({ kind: c.kind, corners: (c.points?.length ?? 0) / 2, freehand: !!c.freehand, id: c.id })) })),
      };
    });
  /** Display brightness (0..255, mean of RGB) at (fx, fy) of the canvas. */
  const bright = (fx, fy) => page.evaluate(([x, y]) => globalThis.__editor.renderer.sampleDisplay(x, y, 3), [fx, fy]).then((c) => (c ? ((c[0] + c[1] + c[2]) / 3) * 255 : NaN));

  // ---- polygon by clicks, closed on the first corner (Shift+K arms it)
  await page.keyboard.press('Shift+K');
  let s = await state();
  check('Shift+K arms the polygon', s.draft?.kind === 'polygon', s.draft);
  const square = [[0.3, 0.3], [0.55, 0.3], [0.55, 0.6], [0.3, 0.6]];
  for (const [x, y] of square) await click(x, y);
  s = await state();
  check('each click adds a corner', s.draft?.corners === 4, s.draft);
  await page.mouse.move(...at(0.3 + 0.003, 0.3 + 0.004));
  await settle(100);
  check('near the first corner, it is shown as the place to close', (await page.locator('.corner-dot.snap').count()) === 1);
  await page.screenshot({ path: join(outDir, '1-drawing.png') });
  await click(0.3 + 0.003, 0.3 + 0.004);
  s = await state();
  check('clicking the first corner closes it into a new mask', !s.draft && s.masks.length === 1 && s.masks[0].parts[0]?.kind === 'polygon' && s.masks[0].parts[0].corners === 4, s);

  // The mask changes the inside only.
  await page.evaluate(() => globalThis.__editor.setMaskOverlay(false));
  await settle();
  const before = { in: await bright(0.42, 0.45), out: await bright(0.7, 0.45) };
  const exposure = page.locator('input[aria-label="Exposure"]').first();
  await exposure.fill('2');
  await exposure.press('Enter');
  await settle(800);
  const after = { in: await bright(0.42, 0.45), out: await bright(0.7, 0.45) };
  check('mask exposure brightens inside the polygon', after.in > before.in + 20, { before, after });
  check('and leaves the outside alone', Math.abs(after.out - before.out) < 3, { before, after });
  await page.screenshot({ path: join(outDir, '2-polygon-mask.png') });

  // ---- editing corners
  await page.evaluate(() => globalThis.__editor.setMaskOverlay(true));
  const partId = (await state()).masks[0].parts[0].id;
  const corners = () => page.evaluate((id) => globalThis.__editor.recipe.masks.flatMap((m) => m.components).find((c) => c.id === id)?.points ?? [], partId);
  const p0 = await corners();
  const handles = page.locator('rect.handle.corner');
  check('a selected polygon shows a handle per corner', (await handles.count()) === 4, { handles: await handles.count() });
  const [hx, hy] = at(0.55, 0.6);
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx + 40, hy + 25, { steps: 5 });
  await page.mouse.up();
  await settle();
  const p1 = await corners();
  check('dragging a corner moves only that corner', p1[4] > p0[4] && p1[5] > p0[5] && p1[0] === p0[0] && p1[3] === p0[3], { before: p0, after: p1 });
  // Drag the middle of the top edge: a fifth corner.
  const [ex, ey] = at(0.425, 0.3);
  await page.mouse.move(ex, ey);
  await page.mouse.down();
  await page.mouse.move(ex, ey - 30, { steps: 5 });
  await page.mouse.up();
  await settle();
  const p2 = await corners();
  check('dragging an edge adds a corner there', p2.length === 10 && p2[3] < p0[1], { corners: p2.length / 2 });
  // Alt+click that corner removes it again.
  await page.keyboard.down('Alt');
  await page.mouse.click(ex, ey - 30);
  await page.keyboard.up('Alt');
  await settle();
  check('Alt+click removes a corner', (await corners()).length === 8, { corners: (await corners()).length / 2 });

  // ---- Backspace, Enter, double-click (subtracting from the mask, from the panel's menu)
  await page.locator('select[aria-label="Subtract from mask"]').selectOption('polygon');
  for (const [x, y] of [[0.35, 0.35], [0.45, 0.35], [0.45, 0.45], [0.4, 0.5]]) await click(x, y);
  await page.keyboard.press('Backspace');
  s = await state();
  check('Backspace takes back the last corner', s.draft?.corners === 3, s.draft);
  await page.keyboard.press('Enter');
  s = await state();
  const sub = s.masks[0].parts[1];
  check('Enter closes it, here as a part subtracted from the mask', !s.draft && sub?.kind === 'polygon' && sub.corners === 3, s.masks[0]);
  await page.locator('select[aria-label="Add to mask"]').selectOption('polygon');
  for (const [x, y] of [[0.6, 0.65], [0.7, 0.65]]) await click(x, y);
  const [dx, dy] = at(0.65, 0.75);
  await page.mouse.dblclick(dx, dy);
  await settle(200);
  s = await state();
  check('a double-click closes it too', !s.draft && s.masks[0].parts.length === 3 && s.masks[0].parts[2].corners === 3, s.masks[0]);
  check("and doesn't zoom to 100 % (the photo's own double-click)", !(await page.evaluate(() => globalThis.__editor.zoom.on)));

  // ---- lasso
  await page.getByRole('button', { name: 'Lasso', exact: true }).click();
  const [cx, cy] = at(0.75, 0.3);
  await page.mouse.move(cx + 60, cy);
  await page.mouse.down();
  for (let i = 1; i <= 120; i++) {
    const a = (i / 120) * 2 * Math.PI;
    await page.mouse.move(cx + 60 * Math.cos(a), cy + 45 * Math.sin(a));
  }
  const dragged = await page.evaluate(() => document.querySelector('.draft polygon')?.getAttribute('points')?.split(' ').length ?? 0);
  await page.mouse.up();
  await settle();
  s = await state();
  const lasso = s.masks[1]?.parts[0];
  check('a dragged lasso becomes a new freehand mask, simplified', lasso?.kind === 'polygon' && lasso.freehand && lasso.corners >= 12 && lasso.corners < dragged, { ...lasso, dragged });
  check('the lasso has no corner handles', (await page.locator('rect.handle.corner').count()) === 0);
  const partNames = await page.locator('ul.parts button.part').allTextContents();
  check('it is called Lasso in the parts list', partNames.some((t) => t.trim() === 'Lasso'), { partNames: partNames.map((t) => t.trim()) });
  await page.screenshot({ path: join(outDir, '3-lasso.png') });

  // ---- undo
  await page.keyboard.press('Control+z');
  await settle();
  s = await state();
  check('undo takes the lasso mask away again', s.masks.length === 1, { masks: s.masks.length });

  await page.evaluate(() => globalThis.__editor.resetAll());
  check('no console errors', errors.length === 0, { errors: errors.slice(0, 5) });
} finally {
  await browser.close();
  writeFileSync(join(outDir, 'probe-polygon.json'), JSON.stringify(results, null, 2));
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
