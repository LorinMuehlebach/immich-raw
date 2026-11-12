// Checks the AI masks on one seeded RAW: Sky, Subject, Landscape, an object (box), People;
// then exports a JPEG with them. Needs internet: the models download on first use.
// Usage: node e2e/probe-ai-masks.mjs <out-dir> <asset-id>
// (a CC0 sample with sky and water works best, e.g. leica-q2.DNG from fetch-samples.mjs)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
const [out, id] = process.argv.slice(2);
if (!out || !id) throw new Error('Usage: node e2e/probe-ai-masks.mjs <out-dir> <asset-id>');
mkdirSync(out, { recursive: true });
// A browser profile in the output folder keeps the downloaded models between runs.
const ctx = await chromium.launchPersistentContext(join(out, 'profile'), {
  channel: 'msedge',
  headless: !process.env.HEADED,
  args: ['--enable-gpu', '--use-angle=d3d11', '--enable-unsafe-webgpu'],
  viewport: { width: 1600, height: 1000 },
  acceptDownloads: true,
});
const browser = { close: () => ctx.close() };
await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'admin@example.com', password: 'raw-editor-e2e' } });
const page = await ctx.newPage();
const errors = [];
const logs = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => (m.type() === 'error' ? errors.push(m.text()) : logs.push(m.text())));
page.on('worker', (w) => w.on('console', (m) => {
  logs.push(`[worker] ${m.text()}`);
  if (m.type() === 'warning' || m.type() === 'error' || m.text().startsWith('AI masks')) console.log(`[worker] ${m.text()}`);
}));
const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) });
const ed = (fn, arg) => page.evaluate(fn, arg);
const results = { timings: {} };

await page.goto(`${BASE}/immich-raw/?asset=${id}&debug`);
await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
await page.waitForTimeout(500);
await ed(() => globalThis.__editor.resetAll());
results.env = await ed(() => ({ webgpu: 'gpu' in navigator, isolated: globalThis.crossOriginIsolated }));
const box = await page.locator('.frame canvas').boundingBox();
const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];

await page.keyboard.press('Shift+W');
await page.waitForTimeout(200);
const aiButton = (label) => page.locator('.create.ai button', { hasText: label });

/** Waits until the selected mask's AI part is done; answers the download question. */
async function waitDone(label, timeout = 600000) {
  const t0 = Date.now();
  let told = 0;
  for (;;) {
    if (Date.now() - told > 10000) {
      told = Date.now();
      const p = await ed(() => JSON.parse(JSON.stringify(globalThis.__editor.ai.progress)));
      console.log(`${label}: ${Math.round((Date.now() - t0) / 1000)} s`, JSON.stringify(p));
    }
    if (await page.locator('[role=alertdialog] h2', { hasText: 'Download the AI models' }).isVisible().catch(() => false)) {
      await page.locator('[role=alertdialog] button', { hasText: 'Download' }).click();
    }
    const st = await ed(() => {
      const e = globalThis.__editor;
      const s = e.ai.status[e.maskSel.comp];
      return s ? JSON.parse(JSON.stringify(s)) : null;
    });
    if (st && st.state !== 'working') {
      results.timings[label] = Math.round((Date.now() - t0) / 100) / 10;
      return st;
    }
    if (Date.now() - t0 > timeout) {
      await shot(`timeout-${label}`);
      return { state: 'timeout' };
    }
    await page.waitForTimeout(500);
  }
}

async function exposure(v) {
  await page.locator('input[aria-label="Exposure"]').fill(String(v));
  await page.waitForTimeout(400);
}

// 1. Sky, darkened.
await aiButton('Sky').click();
results.sky = await waitDone('sky');
await exposure(-1.2);
await shot('1-sky-overlay');
await page.keyboard.press('o');
await page.waitForTimeout(300);
await shot('2-sky');
await page.keyboard.press('o');

// 2. Subject, brightened.
await aiButton('Subject').click();
results.subject = await waitDone('subject');
await exposure(0.8);
await shot('3-subject-overlay');

// 3. Landscape: water and vegetation.
await aiButton('Landscape').click();
await page.locator('.picker').getByLabel('Sky', { exact: true }).uncheck();
await page.locator('.picker').getByLabel('Water', { exact: true }).check();
await page.locator('.picker').getByLabel('Vegetation', { exact: true }).check();
await page.locator('.picker button', { hasText: 'Create mask' }).click();
results.landscape = await waitDone('landscape');
await exposure(0.5);
await shot('4-landscape-overlay');

// 4. An object: a box around the middle of the photo.
await aiButton('Objects').click();
const [x0, y0] = at(0.3, 0.38);
const [x1, y1] = at(0.76, 0.7);
await page.mouse.move(x0, y0);
await page.mouse.down();
for (let i = 1; i <= 8; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8);
await page.mouse.up();
results.object = await waitDone('object');
await exposure(0.6);
await shot('5-object-overlay');

// 5. People: everyone.
await aiButton('People').click();
await page.locator('.picker button', { hasText: 'Create mask' }).click();
results.people = await waitDone('people');
results.peopleFound = await ed(() => JSON.parse(JSON.stringify(globalThis.__editor.ai.people)));
await shot('6-people');

// 6. With people in the photo: face parts and hair of the first person found.
if (results.peopleFound?.length) {
  await aiButton('People').click();
  await page.locator('.picker label.person input').first().check();
  await page.locator('.picker').getByLabel('Entire Person', { exact: true }).uncheck();
  for (const part of ['Face Skin', 'Lips', 'Teeth', 'Iris and Pupil', 'Eyebrows', 'Hair']) {
    await page.locator('.picker').getByLabel(part, { exact: true }).check();
  }
  await page.locator('.picker button', { hasText: 'Create mask' }).click();
  results.personParts = await waitDone('person-parts');
  await exposure(0.4);
  await shot('6b-person-parts-overlay');
}

results.masks = await ed(() => JSON.parse(JSON.stringify(globalThis.__editor.recipe.masks)).map((m) => ({ name: m.name, parts: m.components.map((c) => c.target ?? c.kind) })));
results.status = await ed(() => JSON.parse(JSON.stringify(globalThis.__editor.ai.status)));

// 7. The result, and an export (which waits for every AI map) where the editor has one.
await page.keyboard.press('Shift+W');
await page.waitForTimeout(300);
await shot('7-result');
if (await ed(() => typeof globalThis.__editor.exportPhoto === 'function')) {
  const download = page.waitForEvent('download', { timeout: 600000 });
  const t0 = Date.now();
  results.exported = await ed(() => globalThis.__editor.exportPhoto('low'));
  const file = await download.catch(() => null);
  if (file) await file.saveAs(join(out, `export-${file.suggestedFilename()}`));
  results.timings.export = Math.round((Date.now() - t0) / 100) / 10;
}

results.errors = errors;
results.logs = logs.filter((l) => /AI|onnx|ort|webgpu|mediapipe/i.test(l)).slice(0, 40);
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ env: results.env, timings: results.timings, status: results.status, peopleFound: results.peopleFound?.length, masks: results.masks, errors }, null, 2));
await browser.close();
