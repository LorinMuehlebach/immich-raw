// The filmstrip: switching photos with the keys shows the next photo's look at once and keeps the
// page, and the keys work while a photo is still opening. Unsaved changes stay as a draft: no
// question on the way out, a mark in the filmstrip, back with its undo history (also after a
// reload), gone with Discard. Nothing is saved to Immich.
// Usage: node e2e/filmstrip.mjs <out-dir> [file name part]   (default: DSCF, a series with neighbours)
//   IMMICH_URL=http://127.0.0.1:5183   an editor dev server instead of the test Immich's own build
//   NO_PREFETCH=1                      no decoding of the neighbours ahead (less memory)
//   SAVE=1                             also "Save N drafts" on two photos (saved to Immich, then removed again)
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
  // NO_PREFETCH=1: the editor doesn't decode the neighbours ahead (it thinks the device has 2 GB),
  // for a PC short of memory. The looks are still got ready.
  if (process.env.NO_PREFETCH) await context.addInitScript(() => Object.defineProperty(navigator, 'deviceMemory', { get: () => 2 }));
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

  // ------------------------------------------------ unsaved changes stay as a draft
  const exposure = () => page.locator('.row', { has: page.locator('input[aria-label="Exposure"]') }).locator('.value').textContent().then((t) => t?.trim());
  const unsaved = () => page.locator('.sub', { hasText: 'unsaved changes' }).count().then((n) => n > 0);
  const draftMarks = () => page.locator('.filmstrip .draft').count();
  await page.waitForTimeout(800);
  const marksBefore = await draftMarks();
  await page.locator('input[aria-label="Exposure"]').fill('0.7');
  await page.waitForTimeout(300);
  if (!(await unsaved())) fail('the edit did not mark the photo unsaved');
  // → right away: the draft is written on the way out, nothing asks.
  await page.keyboard.press('ArrowRight');
  const left = await page.waitForURL((u) => new URL(u).searchParams.get('asset') !== second, { timeout: 5000 }).then(() => true, () => false);
  if (!left) fail('→ with unsaved changes did not move on (a dialog?)');
  await shown();
  await page.waitForFunction((n) => document.querySelectorAll('.filmstrip .draft').length > n, marksBefore, { timeout: 5000 }).catch(() => {});
  const marked = (await draftMarks()) > marksBefore;
  await page.keyboard.press('ArrowLeft');
  await page.waitForURL((u) => new URL(u).searchParams.get('asset') === second, { timeout: 5000 });
  await shown();
  await page.waitForTimeout(500);
  const restored = (await exposure()) === '+0.70' && (await unsaved());
  // The undo history of this photo is still there: one step back is the saved state.
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  const undone = await exposure();
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(300);
  const redone = await exposure();
  results.draft = { marked, restored, undone, redone };
  console.log(`draft: marked in the strip ${marked}, restored ${restored}, undo → ${undone}, redo → ${redone}`);
  if (!marked) fail('the photo left with unsaved changes has no draft mark');
  if (!restored) fail('going back did not restore the draft');
  if (undone !== '0.00' || redone !== '+0.70') fail('the undo history did not survive the switch');

  // A reload opens the draft too, with the saved state one undo step back.
  await page.waitForTimeout(2500);
  await page.reload();
  await shown();
  await page.waitForTimeout(500);
  const reloaded = (await exposure()) === '+0.70' && (await unsaved());
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  const reloadUndo = await exposure();
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(300);
  results.reload = { reloaded, reloadUndo };
  console.log(`reload: draft opened ${reloaded}, undo → ${reloadUndo}`);
  if (!reloaded) fail('the draft did not survive a reload');
  if (reloadUndo !== '0.00') fail('after a reload, undo did not go back to the saved state');

  // Discard: back to the saved state, and the draft is gone.
  await page.locator('.sub button.discard').click();
  await page.waitForTimeout(800);
  const discarded = (await exposure()) === '0.00' && !(await unsaved());
  await page.reload();
  await shown();
  await page.waitForTimeout(500);
  const stillGone = (await exposure()) === '0.00' && !(await unsaved());
  results.discard = { discarded, stillGone };
  console.log(`discard: back to saved ${discarded}, gone after reload ${stillGone}`);
  if (!discarded || !stillGone) fail('Discard did not drop the draft');

  // ------------------------------------------------ SAVE=1: Save N drafts (renders and saves to Immich, then removes it again)
  if (process.env.SAVE && raws.length >= 7) {
    const api = async (method, path, data) => {
      const res = await context.request.fetch(`${base}/api${path}`, { method, data });
      return res.ok() && res.headers()['content-type']?.includes('json') ? res.json() : null;
    };
    const targets = [raws[4], raws[5]];
    const recipeOf = async (id) => (await api('GET', `/assets/${id}/metadata`))?.find((i) => i.key === 'raw-editor.recipe')?.value ?? null;
    const before = await Promise.all(targets.map((a) => recipeOf(a.id)));
    if (before.some(Boolean)) fail('the photos for SAVE=1 have a saved edit already');
    for (const a of targets) {
      await page.goto(`${base}/immich-raw/?asset=${a.id}`);
      await shown();
      await page.locator('input[aria-label="Exposure"]').fill('0.4');
      await page.waitForTimeout(2600);
    }
    await page.goto(`${base}/immich-raw/?asset=${raws[6].id}`);
    await shown();
    const button = page.locator('.filmstrip .headbtn', { hasText: /Save \d+ drafts?/ });
    const label = (await button.textContent())?.trim();
    const t0 = Date.now();
    await button.click();
    await page.locator('.toast', { hasText: 'saved to Immich' }).waitFor({ timeout: 600000 });
    const notice = (await page.locator('.toast span').textContent())?.trim();
    const after = await Promise.all(targets.map((a) => recipeOf(a.id)));
    const saved = after.every((r) => r?.basic?.exposure === 0.4 && r?.render?.assetId);
    const marksLeft = await draftMarks();
    results.saveDrafts = { label, notice, seconds: Math.round((Date.now() - t0) / 1000), saved, marksLeft };
    console.log(`Save drafts: "${label}" → "${notice}" in ${results.saveDrafts.seconds} s, stored ${saved}, draft marks left ${marksLeft}`);
    // Put the photos back: their JPEGs and settings go.
    const renders = after.map((r) => r?.render?.assetId).filter(Boolean);
    if (renders.length) await api('DELETE', '/assets', { ids: renders, force: true });
    for (const a of targets) for (const key of ['raw-editor.recipe', 'raw-editor.history']) await api('DELETE', `/assets/${a.id}/metadata/${key}`);
    if (!saved) fail('Save drafts did not store the edits in Immich');
  }
  console.log('ok');
} finally {
  writeFileSync(join(outDir, 'filmstrip.json'), JSON.stringify(results, null, 2));
  await browser.close();
}
