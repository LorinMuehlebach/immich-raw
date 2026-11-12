// Checks AI Upscale on one seeded RAW: the preview patch, the size and time check, a 2x download
// of a cropped edit, Cancel, and Save to Immich (stacked with the RAW, front photo unchanged,
// tagged as made from the RAW). Removes what it uploaded. Needs internet: the model downloads on
// first use. The RAW's saved edit is not touched (the crop is never saved).
// Usage: node e2e/probe-upscale.mjs <out-dir> [file name part, default nikon-z7]
// IMMICH_URL=http://localhost:5180 runs it against the dev server. INSECURE=1 checks the plain-HTTP
// path (no WebGPU, one CPU thread: whole photos refused, a small crop allowed; see insecure.mjs).
// HEADED=1 shows the browser.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { API_BASE, INSECURE, PAGE_BASE, browserArgs, expectedConsoleError, loginOnPageOrigin } from './insecure.mjs';

const LOGIN = { email: 'admin@example.com', password: 'raw-editor-e2e' };
/** STYLE=natural checks RealPLKSR; CROP sets the side of the centre crop that is upscaled (0..1). */
const STYLE = process.env.STYLE ?? 'sharp';
const [out, part = 'nikon-z7'] = process.argv.slice(2);
if (!out) throw new Error('Usage: node e2e/probe-upscale.mjs <out-dir> [file name part]');
mkdirSync(out, { recursive: true });
const ctx = await chromium.launchPersistentContext(join(out, INSECURE ? 'profile-insecure' : 'profile'), {
  channel: 'msedge',
  headless: !process.env.HEADED,
  args: ['--enable-gpu', '--use-angle=d3d11', '--enable-unsafe-webgpu', ...browserArgs],
  viewport: { width: 1600, height: 1000 },
  acceptDownloads: true,
});
// The model download was agreed to (the dialog itself is covered by probe-ai-masks.mjs).
await ctx.addInitScript(() => localStorage.setItem('raw-editor.aiDownloads', 'yes'));
await ctx.request.post(`${API_BASE}/api/auth/login`, { data: LOGIN });
if (INSECURE) await loginOnPageOrigin(ctx, LOGIN);
const api = async (method, path, data) => {
  const r = await ctx.request.fetch(`${API_BASE}/api${path}`, { method, data });
  return r.status() === 204 ? null : r.json().catch(() => null);
};
const results = { checks: [] };
const check = (name, ok, detail) => {
  results.checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
};

const found = await api('POST', '/search/metadata', { originalFileName: part, size: 20 });
const raw = found?.assets?.items?.find((a) => a.originalFileName.toLowerCase().includes(part) && !a.originalFileName.includes('.edit.'));
if (!raw) throw new Error(`No seeded RAW matching "${part}"`);
const before = await api('GET', `/assets/${raw.id}`);
results.raw = { name: raw.originalFileName, stack: before.stack ?? null };

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !expectedConsoleError(m.text()) && errors.push(m.text()));
page.on('worker', (w) => w.on('console', (m) => m.type() === 'error' && errors.push(`[worker] ${m.text()}`)));
const ed = (fn, arg) => page.evaluate(fn, arg);
const shot = (name) => page.screenshot({ path: join(out, `${name}${INSECURE ? '-insecure' : ''}.png`) });
const waitFor = (fn, timeout) => page.waitForFunction(fn, null, { timeout, polling: 250 });

await page.goto(`${PAGE_BASE}/immich-raw/?asset=${raw.id}&debug`);
await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
await page.waitForTimeout(500);
results.env = await ed(() => ({ secure: isSecureContext, webgpu: 'gpu' in navigator, isolated: crossOriginIsolated }));
results.backend = await ed(() => globalThis.__editor.upscale.loadBackend());
check('backend known', results.backend && typeof results.backend.gpu === 'boolean', results.backend);
if (INSECURE) check('plain HTTP: CPU, one thread', !results.env.secure && !results.backend.gpu && results.backend.threads === 1, { ...results.env, ...results.backend });
check('panel shown', await page.locator('section', { hasText: 'AI Upscale' }).isVisible());

// 1. The preview patch.
let t = Date.now();
await ed((style) => {
  globalThis.__editor.upscale.set({ style, scale: 2, format: 'jpeg' });
  globalThis.__editor.setTool('upscale');
}, STYLE);
await waitFor(() => globalThis.__editor.upscale.preview || globalThis.__editor.upscale.previewError, 600000);
const preview = await ed(() => {
  const u = globalThis.__editor.upscale;
  return { error: u.previewError, before: u.preview && [u.preview.before.width, u.preview.before.height], after: u.preview && [u.preview.after.width, u.preview.after.height] };
});
check('preview made', !preview.error && preview.after?.[0] === 2 * preview.before?.[0], { ...preview, seconds: (Date.now() - t) / 1000 });
await page.waitForTimeout(300);
await shot('1-preview');
// Moving the patch makes a new preview.
await ed(() => (globalThis.__editor.upscale.patch = [0.3, 0.4]));
t = Date.now();
await waitFor(() => !globalThis.__editor.upscale.previewStatus && globalThis.__editor.upscale.preview, 300000);
await page.waitForTimeout(1500);
await waitFor(() => !globalThis.__editor.upscale.previewStatus, 300000);
check('preview follows the patch', !(await ed(() => globalThis.__editor.upscale.previewError)), { seconds: (Date.now() - t) / 1000, measured: await ed(() => globalThis.__editor.upscale.measured) });
await shot('2-preview-moved');

// 2. The whole photo: size and time.
results.full = await ed(() => globalThis.__editor.upscaleCheck());
console.log('whole photo 2x:', JSON.stringify(results.full));
if (!results.backend.gpu) check('whole photo refused without a GPU', /Full photos need WebGPU/.test(results.full?.blocked ?? ''), results.full?.blocked);

// 3. Part of the photo (a quarter; less without a GPU), 2x, downloaded.
const side = Number(process.env.CROP) || (results.backend.gpu ? 0.5 : 0.12);
await ed((s) => {
  const e = globalThis.__editor;
  e.setTool('edit');
  Object.assign(e.recipe.crop, { cx: 0.5, cy: 0.5, w: s, h: s });
  e.requestRender();
}, side);
await page.waitForTimeout(800);
results.crop = await ed(() => globalThis.__editor.upscaleCheck());
check('cropped 2x allowed', results.crop && !results.crop.blocked, results.crop);
t = Date.now();
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 1200000 }), ed(() => globalThis.__editor.upscalePhoto('download'))]);
const file = join(out, dl.suggestedFilename());
await dl.saveAs(file);
const bytes = new Uint8Array(await (await import('node:fs/promises')).readFile(file));
const size = jpegSize(bytes);
check('download is 2x the crop', size && size.width === results.crop.width && size.height === results.crop.height, {
  name: dl.suggestedFilename(),
  ...size,
  mb: +(bytes.length / 1e6).toFixed(1),
  seconds: (Date.now() - t) / 1000,
  notice: await ed(() => globalThis.__editor.notice),
});

// 4. Cancel during the model run.
const cancelled = await ed(async () => {
  const e = globalThis.__editor;
  const run = e.upscalePhoto('download');
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      if (e.saving?.label.includes('Upscaling') && e.saving.cancel) {
        clearInterval(iv);
        e.saving.cancel();
        resolve();
      }
    }, 50);
  });
  return { ok: await run, notice: e.notice, error: e.error, saving: !!e.saving };
});
check('cancel stops it', cancelled.ok === false && cancelled.notice === 'AI Upscale cancelled.' && !cancelled.saving, cancelled);

// 5. Save to Immich.
t = Date.now();
const saved = await ed(async () => {
  const e = globalThis.__editor;
  return { ok: await e.upscalePhoto('immich'), notice: e.notice, error: e.error };
});
check('saved to Immich', saved.ok, { ...saved, seconds: (Date.now() - t) / 1000 });
const base = raw.originalFileName.replace(/\.[^.]+$/, '');
const copies = (await api('POST', '/search/metadata', { originalFileName: `${base}.upscaled-2x.edit.jpg`, size: 10 }))?.assets?.items ?? [];
const copy = copies.find((a) => a.originalFileName === `${base}.upscaled-2x.edit.jpg`);
check('copy uploaded with its name', !!copy, copies.map((a) => a.originalFileName));
if (copy) {
  const [rawNow, copyNow, tag] = await Promise.all([api('GET', `/assets/${raw.id}`), api('GET', `/assets/${copy.id}`), api('GET', `/assets/${copy.id}/metadata/raw-editor.render`)]);
  check('copy is in the RAW\'s stack', !!rawNow.stack && copyNow.stack?.id === rawNow.stack.id, { raw: rawNow.stack, copy: copyNow.stack });
  check('front photo unchanged', rawNow.stack?.primaryAssetId === (before.stack?.primaryAssetId ?? raw.id), { before: before.stack?.primaryAssetId ?? raw.id, now: rawNow.stack?.primaryAssetId });
  check('tagged as made from the RAW', tag?.value?.sourceAssetId === raw.id && tag?.value?.upscale?.scale === 2 && tag?.value?.upscale?.style === STYLE, tag?.value);
  check('date copied', copyNow.exifInfo?.dateTimeOriginal?.slice(0, 16) === before.exifInfo?.dateTimeOriginal?.slice(0, 16), [copyNow.exifInfo?.dateTimeOriginal, before.exifInfo?.dateTimeOriginal]);
  // Clean up: the copy, and a stack this test made.
  await api('DELETE', '/assets', { ids: [copy.id], force: true });
  const after = await api('GET', `/assets/${raw.id}`);
  if (!before.stack && after.stack) await api('DELETE', `/stacks/${after.stack.id}`);
  const restored = await api('GET', `/assets/${raw.id}`);
  // Immich gives a re-made stack a new id; what matters is who is in it and in front.
  const same = (a, b) => (!a && !b) || (!!a && !!b && a.primaryAssetId === b.primaryAssetId && a.assetCount === b.assetCount);
  check('stack as before after cleanup', same(restored.stack, before.stack), { before: before.stack ?? null, now: restored.stack ?? null });
}

results.errors = errors;
check('no page errors', errors.length === 0, errors.slice(0, 5));
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
await ctx.close();
process.exit(results.checks.every((c) => c.ok) ? 0 : 1);

/** Width and height from a JPEG's SOF marker. */
function jpegSize(b) {
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    i += 2 + len;
  }
  return null;
}
