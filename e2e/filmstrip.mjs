// The filmstrip: switching photos with the keys shows the next photo's look at once and keeps the
// page, and the keys work while a photo is still opening. Unsaved changes stay as a draft: no
// question on the way out, a mark in the filmstrip, back with its undo history (also after a
// reload), gone with Discard. Stars, pick, reject and clear land in Immich; the reject filter
// hides a rejected photo; three selected photos all get stars, and Sync settings puts Exposure on
// them; Compare shows another photo. What it sets is put back; nothing is saved (except SAVE=1).
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
  // Its thumbnails (the photos as edited) have loaded.
  const thumbs = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('.filmstrip .cell img')];
    return { all: imgs.length, loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length };
  });
  results.thumbs = thumbs;
  console.log(`thumbnails: ${thumbs.loaded} of ${thumbs.all} loaded`);
  if (thumbs.loaded < Math.min(5, thumbs.all)) fail('the filmstrip thumbnails did not load');
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
  const draftMarks = () => page.locator('.filmstrip .fact.draft').count();
  // Typed into the field, then out of it (the keys don't move the photo while typing).
  const setExposure = async (v) => {
    await page.locator('input[aria-label="Exposure"]').fill(v);
    await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur());
  };
  await page.waitForTimeout(800);
  const marksBefore = await draftMarks();
  await setExposure('0.7');
  await page.waitForTimeout(300);
  if (!(await unsaved())) fail('the edit did not mark the photo unsaved');
  // → right away: the draft is written on the way out, nothing asks.
  await page.keyboard.press('ArrowRight');
  const left = await page.waitForURL((u) => new URL(u).searchParams.get('asset') !== second, { timeout: 5000 }).then(() => true, () => false);
  if (!left) fail('→ with unsaved changes did not move on (a dialog?)');
  await shown();
  await page.waitForFunction((n) => document.querySelectorAll('.filmstrip .fact.draft').length > n, marksBefore, { timeout: 5000 }).catch(() => {});
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

  const api = async (method, path, data) => {
    const res = await context.request.fetch(`${base}/api${path}`, { method, data });
    return res.ok() && res.headers()['content-type']?.includes('json') ? res.json() : null;
  };
  const info = (id) => api('GET', `/assets/${id}`);
  const settle = () => page.waitForTimeout(1500);

  // ------------------------------------------------ stars, pick, reject, clear (on the photo in Immich)
  const photo = assetInUrl();
  const flagsText = () => page.locator('.sub .flags').textContent().catch(() => '').then((t) => t?.trim() ?? '');
  await page.keyboard.press('3');
  await settle();
  const rated = (await info(photo))?.exifInfo?.rating;
  const ratedText = await flagsText();
  await page.keyboard.press('p');
  await settle();
  const picked = (await info(photo))?.isFavorite;
  await page.keyboard.press('x');
  await settle();
  const afterX = await info(photo);
  const rejectedTag = afterX?.tags?.some((t) => /\/Rejected$/.test(t.value));
  const rejectMark = await page.locator('.filmstrip .cell.current.rejected').count();
  // The reject filter hides the photo once it isn't the open one.
  await page.keyboard.press('ArrowRight');
  await page.waitForURL((u) => new URL(u).searchParams.get('asset') !== photo, { timeout: 5000 });
  await shown();
  const countText = () => page.locator('.filmstrip .count').textContent().then((t) => t?.trim());
  const countBefore = await countText();
  await page.locator('.filters .chip', { hasText: '✕' }).click();
  await page.waitForTimeout(300);
  const filtered = await countText();
  await page.locator('.filters .chip', { hasText: 'clear' }).click();
  await page.keyboard.press('ArrowLeft');
  await page.waitForURL((u) => new URL(u).searchParams.get('asset') === photo, { timeout: 5000 });
  await shown();
  await page.keyboard.press('u');
  await page.keyboard.press('0');
  await settle();
  const cleared = await info(photo);
  results.flags = {
    rated,
    ratedText,
    picked,
    rejected: { tag: rejectedTag, favourite: afterX?.isFavorite, mark: rejectMark > 0 },
    filter: { before: countBefore, filtered },
    cleared: { rating: cleared?.exifInfo?.rating ?? null, favourite: cleared?.isFavorite, tag: cleared?.tags?.some((t) => /\/Rejected$/.test(t.value)) },
  };
  console.log(`flags: ${JSON.stringify(results.flags)}`);
  if (rated !== 3 || !ratedText.includes('★★★')) fail('3 did not give the photo 3 stars');
  if (picked !== true) fail('P did not pick the photo');
  if (!rejectedTag || afterX?.isFavorite !== false) fail('X did not reject the photo');
  if (countBefore === filtered) fail('hiding rejected photos changed nothing');
  if (cleared?.isFavorite !== false || results.flags.cleared.tag || results.flags.cleared.rating) fail('U and 0 did not clear the flags');

  // ------------------------------------------------ select several, stars on all, Sync settings
  const cells = page.locator('.filmstrip .cell');
  const at = await page.locator('.filmstrip .cell').evaluateAll((els) => els.findIndex((e) => e.classList.contains('current')));
  const others = [at + 1, at + 2].filter((i) => i >= 0);
  for (const i of others) await cells.nth(i).click({ modifiers: ['Control'] });
  const selectedText = (await page.locator('.filmstrip .sel').textContent())?.trim();
  const selectedIds = await page.evaluate(() => [...document.querySelectorAll('.filmstrip .cell.selected img')].map((i) => i.getAttribute('alt')));
  await page.keyboard.press('2');
  await settle();
  const names = await Promise.all(raws.map(async (a) => [a.originalFileName, a.id]));
  const idOf = Object.fromEntries(names);
  const starsOnAll = (await Promise.all(selectedIds.map((n) => info(idOf[n])))).every((a) => a?.exifInfo?.rating === 2);
  await page.keyboard.press('0');
  await settle();
  // Sync the open photo's Exposure onto the others.
  await setExposure('0.3');
  await page.waitForTimeout(300);
  await page.locator('.filmstrip .headbtn', { hasText: 'Sync settings' }).click();
  const syncButton = page.getByRole('button', { name: 'Sync', exact: true });
  if (!(await syncButton.waitFor({ timeout: 5000 }).then(() => true, () => false))) {
    await page.screenshot({ path: join(outDir, 'sync-failed.png') });
    fail('Sync settings… opened no dialog');
  }
  await syncButton.click();
  await page.waitForTimeout(1000);
  const syncedMarks = await page.locator('.filmstrip .slot:has(.cell.selected) .fact.draft').count();
  await page.keyboard.press('Escape');
  const selectionGone = (await page.locator('.filmstrip .sel').count()) === 0;
  // Open the next one: the synced Exposure is there, as a draft.
  await page.keyboard.press('ArrowRight');
  await page.waitForURL((u) => new URL(u).searchParams.get('asset') !== photo, { timeout: 5000 });
  await shown();
  await page.waitForTimeout(500);
  const syncedExposure = await exposure();
  results.select = { selectedText, starsOnAll, syncedMarks, selectionGone, syncedExposure };
  console.log(`selection: ${JSON.stringify(results.select)}`);
  if (!selectedText?.startsWith('3 selected')) fail('Ctrl-click did not select three photos');
  if (!starsOnAll) fail('2 did not give every selected photo 2 stars');
  if (syncedExposure !== '+0.30') fail('Sync settings did not put the Exposure on the next photo');
  if (!selectionGone) fail('Esc did not select none');
  // Clean up: the drafts of this photo, the next one and the one we synced from.
  await page.locator('.sub button.discard').click();
  await page.keyboard.press('ArrowRight');
  await shown();
  if (await page.locator('.sub button.discard').count()) await page.locator('.sub button.discard').click();
  await page.goto(`${base}/immich-raw/?asset=${photo}`);
  await shown();
  if (await page.locator('.sub button.discard').count()) await page.locator('.sub button.discard').click();

  // ------------------------------------------------ compare
  await page.keyboard.press('c');
  const compared = await page.locator('.compare img.shown').waitFor({ timeout: 10000 }).then(() => true, () => false);
  const label1 = (await page.locator('.compare .label').textContent())?.trim();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(800);
  const label2 = (await page.locator('.compare .label').textContent())?.trim();
  await page.keyboard.press('z');
  await page.waitForTimeout(800);
  const zoomedBox = await page.locator('.compare img').evaluate((i) => i.getBoundingClientRect().width);
  await page.screenshot({ path: join(outDir, 'compare.png') });
  await page.keyboard.press('z');
  await page.keyboard.press('c');
  const closed = (await page.locator('.compare').count()) === 0;
  results.compare = { compared, label1, label2, zoomedBox, closed };
  console.log(`compare: ${JSON.stringify(results.compare)}`);
  if (!compared) fail('C did not show another photo');
  if (!closed) fail('C did not close Compare');

  // ------------------------------------------------ SAVE=1: Save N drafts (renders and saves to Immich, then removes it again)
  if (process.env.SAVE && raws.length >= 7) {
    const targets = [raws[4], raws[5]];
    const recipeOf = async (id) => (await api('GET', `/assets/${id}/metadata`))?.find((i) => i.key === 'raw-editor.recipe')?.value ?? null;
    const before = await Promise.all(targets.map((a) => recipeOf(a.id)));
    if (before.some(Boolean)) fail('the photos for SAVE=1 have a saved edit already');
    for (const a of targets) {
      await page.goto(`${base}/immich-raw/?asset=${a.id}`);
      await shown();
      await setExposure('0.4');
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
