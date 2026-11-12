// Takes the screenshots of the guides in docs/ (docs/images/<section>/<name>.jpg) on a test Immich
// with the five seeded sample RAWs: the try-it demo (deploy/demo) or the e2e test Immich.
// Usage: node e2e/screenshots.mjs [section ...]      (default: all sections)
//   sections: getting-started editing masks workflow copies export upscale dng stacking mobile
//   IMMICH_URL (default http://127.0.0.1:8088); HEADED=1 shows the browser.
// - Needs internet once, for the AI mask and upscale models and the Fujifilm looks. They stay in
//   the browser profile in e2e/out/screenshots-profile.
// - stacking needs the culler and the demo's bursts (deploy/demo with --profile culler).
// - It changes the instance: it resets fuji-xt5 (e2e/reset.mjs) and saves an edit of it, makes the
//   albums "immich-raw samples" and "immich-raw bursts" if missing, and stacks the bursts and takes
//   the stacks apart again.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { LR_PRESET } from '../packages/xmp/src/fixtures/preset.ts';

const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
const OUT = 'docs/images';
const LOGIN = { email: 'admin@example.com', password: 'raw-editor-e2e' };
// --lang: Immich takes its date format from the browser's language, not from the locale setting.
const ARGS = ['--enable-gpu', '--use-angle=d3d11', '--enable-unsafe-webgpu', '--lang=en-US'];
const HEADLESS = !process.env.HEADED;
const SECTIONS = {
  'getting-started': gettingStarted,
  editing,
  masks,
  workflow,
  copies,
  export: exporting,
  upscale,
  dng,
  stacking,
  mobile,
};
const chosen = process.argv.slice(2);
for (const s of chosen) if (!SECTIONS[s]) throw new Error(`unknown section "${s}"; the sections are: ${Object.keys(SECTIONS).join(' ')}`);

const errors = [];
/** @type {import('playwright-core').BrowserContext} */
let ctx;
/** @type {import('playwright-core').Page} */
let page;
let editorsOpened = 0;
await launch();

/**
 * (Re)starts the browser. A kept profile: the AI models, the upscale model and the film looks
 * download once. Restarting every few editor pages keeps the GPU memory from running out.
 */
async function launch() {
  if (ctx) await ctx.close();
  page = undefined;
  ctx = await chromium.launchPersistentContext('e2e/out/screenshots-profile', {
    channel: 'msedge',
    headless: HEADLESS,
    args: ARGS,
    viewport: { width: 1600, height: 1000 },
    locale: 'en-US',
    acceptDownloads: true,
  });
  await ctx.addInitScript(noFujiBanner);
  await ctx.request.post(`${BASE}/api/auth/login`, { data: LOGIN });
}

// --- sections ---------------------------------------------------------------------------------------

async function gettingStarted() {
  const raw = await find('fuji-xt5');
  execFileSync('node', ['e2e/reset.mjs', 'fuji-xt5'], { stdio: 'inherit', env: { ...process.env, IMMICH_URL: BASE } });
  // Immich's viewer with the Edit RAW button, outlined.
  await newPage();
  await page.goto(`${BASE}/photos/${raw.id}`);
  const button = page.locator('[data-raw-editor-button]').first();
  await button.waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);
  await outline('[data-raw-editor-button]');
  await shot('getting-started', 'immich-button');
  // The editor, opened through the button: Auto tone plus a few sliders.
  await button.click();
  await page.waitForURL(/\/immich-raw\/\?asset=/, { timeout: 30000 });
  await ready();
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  await setSlider('Vibrance', 25);
  await setSlider('Clarity', 15);
  await setSlider('Dehaze', 10);
  await settle(1500);
  await shot('getting-started', 'editor');
  // Saved, with the way back to Immich.
  await page.keyboard.press('Control+s');
  await page.locator('.toast', { hasText: 'Saved to Immich' }).waitFor({ timeout: 300000 });
  await shot('getting-started', 'saved');
  // One more change, then Esc asks whether to save it.
  await setSlider('Vibrance', 35);
  await blur();
  await page.keyboard.press('Escape');
  const ask = page.getByRole('alertdialog');
  await ask.waitFor({ timeout: 10000 });
  await shot('getting-started', 'unsaved', ask);
  // Back in Immich: the edited JPEG on top of the RAW's stack.
  await ask.getByRole('button', { name: 'No', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/immich-raw/'), { timeout: 60000 });
  await page.waitForTimeout(4000);
  await shot('getting-started', 'immich-result');
}

async function editing() {
  const fuji = await find('fuji-xt5');
  // A film look, downloading the looks when they aren't in the browser yet.
  await openEditor(fuji);
  const profile = page.locator('aside.side .line:has(.lbl:text-is("Profile")) select');
  await profile.selectOption('fuji-classic-chrome');
  await page.waitForTimeout(800);
  const ask = page.getByRole('alertdialog');
  if (await ask.count()) await ask.getByRole('button', { name: 'Download', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('option[value="fuji-classic-chrome"]')?.textContent?.includes('download'), null, { timeout: 180000 });
  if ((await profile.inputValue()) !== 'fuji-classic-chrome') await profile.selectOption('fuji-classic-chrome');
  await settle(1500);
  await shot('editing', 'profile');

  await openEditor(fuji);
  const curve = await openPanel('Tone Curve');
  await curve.getByRole('button', { name: 'RGB', exact: true }).click();
  await ed(() => globalThis.__editor.setCurvePoints('master', [[0, 0], [64, 46], [192, 212], [255, 255]], true));
  await settle();
  await shot('editing', 'tone-curve');

  // The colour checker shows the colour bands best.
  await openEditor(await find('nikon-z7'));
  const mixer = await openPanel('Color Mixer');
  await mixer.locator('.tabs button', { hasText: 'Saturation' }).first().click();
  await setIn(mixer, 'Orange', 40);
  await setIn(mixer, 'Blue', -40);
  await mixer.getByRole('button', { name: 'Targeted adjustment' }).click();
  await page.mouse.move(...(await at(0.615, 0.72)));
  await settle();
  await shot('editing', 'color-mixer', undefined, { keepMouse: true });
  await page.keyboard.press('Escape');

  await openEditor(fuji);
  await openPanel('Color Grading');
  await ed(() => {
    const e = globalThis.__editor;
    e.setWheel('shadows', 200, 35, true);
    e.setWheel('highlights', 40, 30, true);
  });
  await settle();
  await shot('editing', 'color-grading');

  // Detail at 100 %, on the roof window.
  await openEditor(fuji);
  await ed(() => globalThis.__editor.applyPatch({ detail: { sharpenAmount: 70, nrLuminance: 20 } }, 'Detail'));
  await openPanel('Detail');
  await page.waitForFunction(() => globalThis.__editor.fullStatus === 'ready', null, { timeout: 180000 });
  await page.mouse.dblclick(...(await at(0.678, 0.628)));
  await settle(1500);
  await shot('editing', 'detail');

  // The Leica's DNG carries its own lens correction: the dark corners go.
  await openEditor(await find('leica-q2'));
  await page.waitForFunction(() => !globalThis.__editor.lensInfo.searching, null, { timeout: 30000 });
  await ed(() => {
    const e = globalThis.__editor;
    e.setLensFlag('profile', true);
    e.setLensFlag('removeCA', true);
  });
  await openPanel('Lens Corrections');
  await settle();
  await shot('editing', 'lens');

  await openEditor(fuji);
  await ed(() => globalThis.__editor.applyPatch({ transform: { vertical: -25 } }, 'Transform'));
  await openPanel('Transform');
  await settle();
  await shot('editing', 'transform');

  await openEditor(fuji);
  await ed(() => globalThis.__editor.applyPatch({ effects: { vignetteAmount: -45, grainAmount: 35 } }, 'Effects'));
  await openPanel('Effects');
  await settle();
  await shot('editing', 'effects');

  await openEditor(fuji);
  await page.keyboard.press('r');
  await ed(() => globalThis.__editor.setAspect('1:1'));
  await page.locator('input[aria-label="Angle"]').fill('3');
  await settle();
  await shot('editing', 'crop');
  await page.keyboard.press('Enter');
}

async function masks() {
  const fuji = await find('fuji-xt5');
  await openEditor(fuji);
  await page.keyboard.press('Shift+W');
  await page.waitForTimeout(300);
  // A function: the browser restarts now and then (openEditor), and with it the page.
  const masking = () => page.locator('aside.side section', { has: page.locator('.toggle', { hasText: 'Masking' }) });
  const maskSettings = () => masking().locator('[role="group"][aria-label="Mask settings"]');

  // A linear gradient over the sky, darker and cooler; O shows the overlay again after the sliders.
  await page.keyboard.press('m');
  await drag([0.5, 0.05], [0.5, 0.42]);
  await setSlider('Exposure', -0.6);
  await setSlider('Temp', -12);
  await blur();
  await page.keyboard.press('o');
  await settle();
  await shot('masks', 'linear');

  await page.keyboard.press('Shift+M');
  await drag([0.42, 0.42], [0.56, 0.62]);
  await setSlider('Exposure', 0.5);
  await blur();
  await page.keyboard.press('o');
  await settle();
  await shot('masks', 'radial');

  // The radial mask's edge settings.
  await page.locator('.mask-row').nth(1).locator('.gear').click();
  await page.locator('.edge input[aria-label="Offset"]').fill('20');
  await page.locator('.edge input[aria-label="Feather"]').fill('60');
  await settle();
  await shot('masks', 'edges', maskSettings());

  await page.keyboard.press('k');
  await ed(() => globalThis.__editor.setBrush({ size: 40, feather: 60, flow: 100, density: 100 }));
  const path = [];
  for (let i = 0; i <= 30; i++) path.push(await at(0.36 + 0.3 * (i / 30), 0.8 - 0.06 * Math.sin((i / 30) * Math.PI)));
  await page.mouse.move(...path[0]);
  await page.mouse.down();
  for (const p of path) await page.mouse.move(...p);
  await page.mouse.up();
  await setSlider('Exposure', 0.8);
  await blur();
  await page.keyboard.press('o');
  await settle();
  await shot('masks', 'brush');

  // A colour range: a click on the red roof tiles.
  await masking().locator('.create button', { hasText: /^Color$/ }).click();
  await page.mouse.click(...(await at(0.45, 0.53)));
  await settle();
  await shot('masks', 'color-range');

  // AI masks on the Leica's river scene.
  await openEditor(await find('leica-q2'));
  await page.keyboard.press('Shift+W');
  await page.waitForTimeout(300);
  const ai = (label) => masking().locator('.create.ai button', { hasText: label });
  await ai('Sky').click();
  await aiDone();
  await shot('masks', 'ai-sky');

  await ai('Landscape').click();
  await page.locator('.picker').getByLabel('Sky', { exact: true }).uncheck();
  await page.locator('.picker').getByLabel('Water', { exact: true }).check();
  await page.locator('.picker button', { hasText: 'Create mask' }).click();
  await aiDone();
  await shot('masks', 'ai-landscape');

  await ai('Objects').click();
  await drag([0.29, 0.41], [0.76, 0.69]);
  await aiDone();
  await shot('masks', 'ai-objects');

  await ai('People').click();
  await page.locator('.picker').waitFor();
  await shot('masks', 'ai-people', maskSettings());
}

/** Virtual copies (in the workflow guide): a black-and-white copy and the menu. */
async function copies() {
  await openEditor(await find('fuji-xt5'), { reset: false });
  // A copy for the picture, deleted again afterwards.
  await ed(() => globalThis.__editor.newVirtualCopy());
  await page.waitForFunction(() => !!globalThis.__editor.copyId);
  await ed(() => globalThis.__editor.renameCopy(globalThis.__editor.copyId, 'Black & white'));
  await page.locator('aside.side .line:has(.lbl:text-is("Profile")) select').selectOption('monochrome');
  await blur();
  await settle(1200);
  await page.locator('.copies .switch').click();
  await settle(300);
  await shot('workflow', 'virtual-copies', page, { clip: { x: 0, y: 0, width: 1000, height: 460 } });
  await page.keyboard.press('Escape');
  await ed(() => globalThis.__editor.deleteCopy(globalThis.__editor.copyId));
}

async function workflow() {
  const fuji = await find('fuji-xt5');
  const samples = await sampleAlbum();
  // A clean start: no snapshots stored on the RAW (e2e/reset.mjs leaves them), no presets in the browser.
  const cleared = await ctx.request.delete(`${BASE}/api/assets/${fuji.id}/metadata/raw-editor.history`);
  if (!cleared.ok() && cleared.status() !== 404) console.log(`snapshots not cleared: ${cleared.status()}`);
  await newPage();
  await page.goto(`${BASE}/api/server/ping`);
  await page.evaluate(() => new Promise((done) => {
    const r = indexedDB.deleteDatabase('raw-editor');
    r.onsuccess = r.onerror = r.onblocked = () => done();
  }));
  await openEditor(fuji, { context: `album:${samples}` });
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  await setSlider('Vibrance', 25);
  await setSlider('Clarity', 15);
  await blur();
  await page.keyboard.press('Backslash');
  await settle();
  await shot('workflow', 'before-after');
  await page.keyboard.press('Backslash');

  await setSlider('Exposure', 1.6);
  await blur();
  await page.keyboard.press('j');
  await settle();
  await shot('workflow', 'clipping');
  await page.keyboard.press('j');

  const left = page.locator('aside.left');
  const snapshots = await openLeft('Snapshots');
  await left.getByRole('button', { name: 'New snapshot' }).click();
  await left.locator('input[aria-label="Snapshot name"]').fill('Bright');
  await left.locator('input[aria-label="Snapshot name"]').press('Enter');
  const history = await openLeft('History');
  await shot('workflow', 'history-snapshots', page, { clip: await union(snapshots, history) });

  const presets = await openLeft('Presets');
  await left.locator('input[type=file][accept*=".xmp"]').setInputFiles({ name: 'Warm Film.xmp', mimeType: 'application/octet-stream', buffer: Buffer.from(LR_PRESET) });
  await presets.locator('.result').waitFor({ timeout: 10000 });
  await shot('workflow', 'presets', presets);

  await page.locator('.copy').getByRole('button', { name: 'Copy…' }).click();
  const copy = page.getByRole('dialog');
  await copy.waitFor();
  await shot('workflow', 'copy-settings', copy);
  await copy.getByRole('button', { name: 'Cancel' }).click();

  await page.locator('.filmstrip .slot').nth(4).waitFor({ timeout: 60000 });
  await settle();
  await shot('workflow', 'filmstrip');

  const keys = page.locator('aside.side .keys');
  await keys.scrollIntoViewIfNeeded();
  await shot('workflow', 'shortcuts', keys);
}

async function exporting() {
  const fuji = await find('fuji-xt5');
  const samples = await sampleAlbum();
  await openEditor(fuji, { context: `album:${samples}`, reset: false });
  await shot('export', 'panel', await openLeft('Export'));

  await page.getByRole('button', { name: 'Export settings' }).click();
  const settings = page.getByRole('dialog');
  await settings.getByRole('tab', { name: /Medium/ }).click();
  await shot('export', 'settings', settings);
  const watermark = settings.getByLabel('Add a watermark');
  await watermark.check();
  const text = settings.locator('label.row', { hasText: 'Text' }).locator('input');
  await text.fill('© 2026 immich-raw demo');
  await text.press('Tab');
  await settings.getByText('Add a watermark').scrollIntoViewIfNeeded();
  await shot('export', 'watermark', settings);
  await watermark.uncheck(); // the export settings are kept in the browser profile
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Export album…' }).click();
  const album = page.getByRole('dialog');
  await album.locator('.summary').waitFor({ timeout: 60000 });
  await settle();
  await shot('export', 'album', album);
  await page.keyboard.press('Escape');

  // Immich: two photos of the album selected (two captures: an edit and its RAW sit side by side),
  // the export icon outlined.
  await newPage();
  await page.goto(`${BASE}/albums/${samples}`);
  const thumbs = page.locator('[data-thumbnail-focus-container]');
  await thumbs.nth(3).waitFor({ timeout: 60000 });
  await thumbs.first().hover();
  await thumbs.first().locator('[role="checkbox"]').click();
  await thumbs.nth(2).click();
  const button = page.locator('[data-raw-editor-export]');
  await button.waitFor({ timeout: 10000 });
  await page.waitForTimeout(1000);
  await outline('[data-raw-editor-export]');
  await shot('export', 'immich-selection');
  const [exportPage] = await Promise.all([ctx.waitForEvent('page'), button.click()]);
  await exportPage.locator('.summary b').first().waitFor({ timeout: 60000 });
  await exportPage.waitForTimeout(1000);
  await exportPage.screenshot({ path: imagePath('export', 'selected-page'), type: 'jpeg', quality: 85 });
  console.log(`wrote ${imagePath('export', 'selected-page')}`);
  await exportPage.close();
}

async function upscale() {
  await openEditor(await find('fuji-xt5'), { reset: false });
  await upscalePreview(0.678, 0.628);
  await shot('upscale', 'preview');
  const panel = page.locator('aside.left section', { has: page.locator('.toggle', { hasText: 'AI Upscale' }) });
  await panel.scrollIntoViewIfNeeded();
  await shot('upscale', 'panel', panel);
  await page.getByRole('button', { name: 'Hide preview' }).click();
}

async function dng() {
  await openEditor(await find('fuji-xt5'), { reset: false });
  await page.getByRole('button', { name: 'Convert to DNG…' }).click();
  await page.locator('input[name="dng-mode"]').first().check();
  await page.getByRole('button', { name: 'Create DNG' }).click();
  await page.getByRole('button', { name: 'Replace original' }).waitFor({ timeout: 600000 });
  await settle(500);
  await shot('dng', 'dialog', page.getByRole('dialog'));
  await page.getByRole('button', { name: 'Cancel' }).click(); // the RAW stays
}

async function stacking() {
  const health = await ctx.request.get(`${BASE}/immich-raw/culler/api/v1/health`).catch(() => null);
  const bursts = ((await api('POST', '/search/metadata', { originalFileName: 'burst_', size: 50 }))?.assets?.items ?? []).filter((a) => !a.isTrashed);
  if (!health?.ok() || bursts.length < 12) {
    console.log('skipped: needs the culler and the demo bursts (deploy/demo with --profile culler)');
    return;
  }
  const albumId = await albumOf('immich-raw bursts', bursts.map((a) => a.id));
  const first = bursts.find((a) => a.originalFileName === 'burst_a0.dng');
  await undoCullerRuns(); // in case an earlier run stopped half-way

  // Immich: every burst selected, the Auto-stack button outlined, then its page with a preview.
  await newPage();
  await page.goto(`${BASE}/albums/${albumId}`);
  const thumbs = page.locator('[data-thumbnail-focus-container]');
  await thumbs.nth(3).waitFor({ timeout: 60000 });
  await thumbs.first().hover();
  await thumbs.first().locator('[role="checkbox"]').click();
  await page.keyboard.press('Control+a');
  const cull = page.locator('[data-raw-editor-cull]');
  await cull.waitFor({ timeout: 15000 });
  await page.waitForTimeout(1000);
  await outline('[data-raw-editor-cull]');
  await shot('stacking', 'immich-auto-stack');
  const [cullPage] = await Promise.all([ctx.waitForEvent('page'), cull.click()]);
  await cullPage.locator('h2', { hasText: 'Auto-stack' }).waitFor({ timeout: 60000 });
  await cullPage.getByRole('button', { name: 'Preview', exact: true }).click();
  await cullPage.locator('section.result .stack-row').first().waitFor({ timeout: 180000 });
  await cullPage.waitForTimeout(2000);
  await cullPage.screenshot({ path: imagePath('stacking', 'auto-stack-page'), type: 'jpeg', quality: 85 });
  console.log(`wrote ${imagePath('stacking', 'auto-stack-page')}`);
  await cullPage.close();

  // The editor: Auto-stack… on the album, then the stacks in the filmstrip.
  await openEditor(first, { context: `album:${albumId}`, reset: false });
  await page.getByRole('button', { name: 'Auto-stack…' }).click();
  const panel = () => page.locator('.panel[role="dialog"][aria-label="Auto-stack"]'); // the page changes below
  await panel().getByRole('button', { name: 'Preview', exact: true }).click();
  await panel().locator('p', { hasText: 'from' }).waitFor({ timeout: 180000 });
  await shot('stacking', 'auto-stack-panel', panel());
  await panel().getByRole('button', { name: 'Apply', exact: true }).click();
  await page.locator('.filmstrip .badge').first().waitFor({ timeout: 180000 });
  await panel().getByRole('button', { name: 'Close' }).click(); // Esc would leave the editor
  await settle(1500);
  await shot('stacking', 'filmstrip');

  // The stack window on the shot that lost last: the measurement it lost for in red.
  await page.locator('.filmstrip .gcount').first().click();
  const win = page.locator('.window[role="dialog"]');
  await win.locator('.pos').waitFor({ timeout: 60000 });
  await page.keyboard.press('End');
  await settle(1500);
  await shot('stacking', 'stack-window');
  await page.keyboard.press('Escape');

  // Immich's viewer: Compare stack, outlined.
  await newPage();
  await page.goto(`${BASE}/photos/${first.id}`);
  const compare = page.locator('[data-raw-editor-stack]');
  await compare.waitFor({ timeout: 45000 });
  await page.waitForTimeout(1500);
  if (await page.locator('[data-dialog-overlay][data-state="open"]').count()) await page.keyboard.press('Escape');
  await outline('[data-raw-editor-stack]');
  await shot('stacking', 'immich-compare');

  // Take the stacks apart again, so that the next run starts from the same photos.
  await undoCullerRuns();
}

/** Undoes every applied culler run, newest first (the culler only allows that order). */
async function undoCullerRuns() {
  const culler = `${BASE}/immich-raw/culler/api/v1`;
  const runs = (await (await ctx.request.get(`${culler}/runs?limit=50`)).json()).runs ?? [];
  for (const run of runs.filter((r) => !r.dryRun && r.origin !== 'undo' && r.status === 'done' && !r.undoneAt)) {
    const started = await ctx.request.post(`${culler}/runs/${run.id}/undo`, { headers: { 'X-Raw-Editor': '1' } });
    const { runId } = await started.json();
    for (let i = 0; i < 300; i++) {
      const status = (await (await ctx.request.get(`${culler}/runs/${runId}`)).json()).status;
      if (status === 'done' || status === 'failed') {
        console.log(`undid culler run ${run.id}: ${status}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function mobile() {
  const fuji = await find('fuji-xt5');
  const browser = await chromium.launch({ channel: 'msedge', headless: HEADLESS, args: ARGS });
  const devices = [
    { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
    { name: 'tablet', viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 },
  ];
  for (const d of devices) {
    const context = await browser.newContext({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, isMobile: true, hasTouch: true, locale: 'en-US' });
    await context.addInitScript(noFujiBanner);
    await context.request.post(`${BASE}/api/auth/login`, { data: LOGIN });
    const p = await context.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${BASE}/immich-raw/?asset=${fuji.id}`);
    await p.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
    await p.waitForTimeout(2500);
    console.log(`${d.name}: coarse pointer ${await p.evaluate(() => matchMedia('(pointer: coarse)').matches)}`);
    await p.screenshot({ path: imagePath('mobile', d.name), type: 'jpeg', quality: 85 });
    console.log(`wrote ${imagePath('mobile', d.name)}`);
    if (d.name === 'phone') {
      await p.locator('nav.tabs[aria-label="Panels"] button', { hasText: 'Masks' }).tap();
      await p.waitForTimeout(1000);
      await p.screenshot({ path: imagePath('mobile', 'phone-masks'), type: 'jpeg', quality: 85 });
      console.log(`wrote ${imagePath('mobile', 'phone-masks')}`);
    }
    await context.close();
  }
  await browser.close();
}

// --- helpers -----------------------------------------------------------------------------------------

/** Answers the Fujifilm looks banner with "not now", unless a section has downloaded them. */
function noFujiBanner() {
  try {
    if (!localStorage.getItem('raw-editor.fujiLooks')) localStorage.setItem('raw-editor.fujiLooks', 'never');
  } catch {}
}

async function api(method, path, data) {
  const r = await ctx.request.fetch(`${BASE}/api${path}`, { method, data });
  return r.status() === 204 ? null : r.json().catch(() => null);
}

/** The seeded RAW whose file name contains `part`. */
async function find(part) {
  const found = await api('POST', '/search/metadata', { originalFileName: part, size: 50 });
  const raw = (found?.assets?.items ?? []).find((a) => /\.(arw|nef|cr3|raf|dng)$/i.test(a.originalFileName) && !a.isTrashed);
  if (!raw) throw new Error(`no seeded RAW matching "${part}": use the demo (deploy/demo) or node e2e/seed.mjs <samples>`);
  return raw;
}

/** The album `name` with `ids` in it, made if missing; returns its id. */
async function albumOf(name, ids) {
  const existing = ((await api('GET', '/albums')) ?? []).find((a) => a.albumName === name);
  if (existing) {
    await api('PUT', `/albums/${existing.id}/assets`, { ids });
    return existing.id;
  }
  return (await api('POST', '/albums', { albumName: name, assetIds: ids })).id;
}

async function sampleAlbum() {
  const ids = [];
  for (const part of ['canon-r5', 'fuji-xt5', 'leica-q2', 'nikon-z7', 'sony-a7rv']) ids.push((await find(part)).id);
  return albumOf('immich-raw samples', ids);
}

async function newPage() {
  if (page && !page.isClosed()) await page.close(); // no unsaved-changes prompt: runBeforeUnload is off
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  return page;
}

async function ready() {
  await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
  await page.waitForTimeout(1500);
}

/** Opens the editor on a fresh page; by default starts from the default settings. */
async function openEditor(asset, { context, reset = true } = {}) {
  if (++editorsOpened % 4 === 0) await launch();
  await newPage();
  await page.goto(`${BASE}/immich-raw/?asset=${asset.id}${context ? `&ctx=${context}` : ''}&debug`);
  await ready();
  if (reset) {
    await ed(() => globalThis.__editor.resetAll());
    await settle();
  }
}

const ed = (fn, arg) => page.evaluate(fn, arg);
const settle = (ms = 800) => page.waitForTimeout(ms);
const blur = () => page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
const outline = (selector) => page.addStyleTag({ content: `${selector}{outline:4px solid #ff3b30 !important;outline-offset:4px;border-radius:9999px}` });

function imagePath(section, name) {
  const path = join(OUT, section, `${name}.jpg`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

/** Screenshot of the page, or of `target` (a locator); no hover or focus tooltips in it. */
async function shot(section, name, target, { keepMouse = false, clip } = {}) {
  if (!keepMouse) await page.mouse.move(800, 2);
  await blur();
  await page.waitForTimeout(300);
  for (const failed of ['graphics context was lost', 'failed']) {
    if (await page.locator('.toast', { hasText: failed }).count()) throw new Error(`${section}/${name}: ${await page.locator('.toast').first().textContent()}`);
  }
  const path = imagePath(section, name);
  await (target ?? page).screenshot({ path, type: 'jpeg', quality: 85, ...(clip ? { clip } : {}) });
  console.log(`wrote ${path}`);
}

/** The rectangle around several elements, for a screenshot of just those. */
async function union(...locators) {
  const boxes = await Promise.all(locators.map((l) => l.boundingBox()));
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
}

async function setSlider(label, value) {
  const input = page.locator(`input[aria-label="${label}"]`).first();
  await input.fill(String(value));
  await input.press('Enter');
}

async function setIn(scope, label, value) {
  const input = scope.locator(`input[aria-label="${label}"]`).first();
  await input.fill(String(value));
  await input.press('Enter');
}

/** Screen position of (fx, fy) of the photo. */
async function at(fx, fy) {
  const box = await page.locator('.frame:not(.hidden) > canvas').first().boundingBox();
  return [box.x + box.width * fx, box.y + box.height * fy];
}

async function drag(from, to) {
  const [x0, y0] = await at(...from);
  const [x1, y1] = await at(...to);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10);
  await page.mouse.up();
  await page.waitForTimeout(300);
}

const toggleName = (name) => new RegExp(`^\\W*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

/** Opens one right-hand panel and closes the others; returns the panel. */
async function openPanel(name) {
  const side = page.locator('aside.side');
  for (const t of await side.locator('button.toggle[aria-expanded="true"]').all()) {
    if (!toggleName(name).test(((await t.textContent()) ?? '').trim())) await t.click();
  }
  const toggle = side.locator('button.toggle', { hasText: toggleName(name) });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  // `has` takes a locator relative to the section, so it starts from the page.
  const section = side.locator('section', { has: page.locator('button.toggle', { hasText: toggleName(name) }) });
  await section.scrollIntoViewIfNeeded();
  await settle(400);
  return section;
}

/** Opens a section of the left column; returns it. */
async function openLeft(name) {
  const left = page.locator('aside.left');
  const toggle = left.locator('button.toggle', { hasText: toggleName(name) });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const section = left.locator('section', { has: page.locator('button.toggle', { hasText: toggleName(name) }) });
  await section.scrollIntoViewIfNeeded();
  await settle(400);
  return section;
}

/** Waits until the selected mask's AI part is done; agrees to the model download. */
async function aiDone(timeout = 600000) {
  const t0 = Date.now();
  for (;;) {
    const ask = page.locator('[role=alertdialog]', { hasText: 'Download the AI models' });
    if (await ask.isVisible().catch(() => false)) await ask.getByRole('button', { name: 'Download', exact: true }).click();
    const status = await ed(() => {
      const e = globalThis.__editor;
      const s = e.ai.status[e.maskSel.comp];
      return s ? { state: s.state, message: s.message } : null;
    });
    if (status?.state === 'failed') throw new Error(`AI mask failed: ${status.message}`);
    if (status && status.state !== 'working') break;
    if (Date.now() - t0 > timeout) throw new Error('AI mask timed out');
    await page.waitForTimeout(500);
  }
  await settle(1000);
}

/**
 * Opens AI Upscale's preview (agreeing to the model download) and drags its square to (fx, fy)
 * of the photo; waits until the loupe shows the result.
 */
async function upscalePreview(fx, fy) {
  await page.getByRole('button', { name: 'Preview a detail' }).click();
  const square = page.locator('.overlay .square');
  await square.waitFor({ timeout: 30000 });
  const s = await square.boundingBox();
  const [tx, ty] = await at(fx, fy);
  const [sx, sy] = [s.x + s.width / 2, s.y + s.height / 2];
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(sx + ((tx - sx) * i) / 10, sy + ((ty - sy) * i) / 10);
  await page.mouse.up();
  await page.waitForTimeout(1000);
  // The model download is asked for once the full-resolution photo is decoded.
  const consent = page.getByRole('alertdialog');
  await page.locator('.loupe .tag.r').or(consent).first().waitFor({ timeout: 180000 });
  if (await consent.isVisible()) await consent.getByRole('button', { name: 'Download' }).click();
  await page.locator('.loupe .tag.r').waitFor({ timeout: 180000 });
  await page.locator('.loupe .msg').waitFor({ state: 'detached', timeout: 180000 });
  await page.waitForTimeout(500);
}

// --- run (last, so that the helpers above are defined) -------------------------------------------

for (const name of chosen.length ? chosen : Object.keys(SECTIONS)) {
  console.log(`\n== ${name}`);
  try {
    await SECTIONS[name]();
  } catch (e) {
    // What the page showed when it failed, for finding out why.
    mkdirSync('e2e/out', { recursive: true });
    await page?.screenshot({ path: `e2e/out/screenshots-failed-${name}.png` }).catch(() => {});
    throw e;
  }
}
if (errors.length) console.log('\npage errors:', errors);
await ctx.close();
