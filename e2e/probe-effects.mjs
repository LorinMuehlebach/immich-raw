// Checks the Detail panel's noise reduction and sharpening views and the Effects panel
// (post-crop vignetting, grain) on one seeded RAW: fitted and 1:1 screenshots, render
// times, and that the 1:1 view matches the tiled full-resolution export pixel for pixel.
// Usage: node e2e/probe-effects.mjs <out-dir> <asset-id>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
const [out, id] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: !process.env.HEADED, args: ['--enable-gpu', '--use-angle=d3d11'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'admin@example.com', password: 'raw-editor-e2e' } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const ed = (fn, arg) => page.evaluate(fn, arg);
const results = {};

await page.goto(`${BASE}/immich-raw/?asset=${id}&debug`);
await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
await page.waitForFunction(() => !globalThis.__editor.lensInfo.searching, null, { timeout: 30000 });
await ed(() => globalThis.__editor.resetAll());
const name = await ed(() => globalThis.__editor.asset.originalFileName);
results.name = name;
results.iso = await ed(() => globalThis.__editor.asset.exifInfo?.iso ?? null);
const canvas = page.locator('.frame canvas');
const shot = async (label) => {
  await page.waitForTimeout(350);
  await canvas.screenshot({ path: join(out, `${name}-${label}.png`) });
};
// Sets recipe values by dotted path (one history step) and re-renders.
const set = (values) =>
  ed((v) => {
    const e = globalThis.__editor;
    const patch = {};
    for (const [path, value] of Object.entries(v)) {
      const keys = path.split('.');
      let cur = patch;
      for (const k of keys.slice(0, -1)) cur = cur[k] ??= {};
      cur[keys.at(-1)] = value;
    }
    e.applyPatch(patch, 'probe');
  }, values);
const resetEffects = () =>
  set({ 'effects.vignetteAmount': 0, 'effects.grainAmount': 0, 'effects.vignetteStyle': 'highlight', 'effects.vignetteRoundness': 0, 'effects.vignetteFeather': 50, 'effects.vignetteMidpoint': 50, 'effects.vignetteHighlights': 0 });

// Fitted render time (GPU work forced to finish by a 1-pixel read).
const timeFit = () =>
  ed(() => {
    const e = globalThis.__editor;
    const r = e.renderer;
    const gl = r.gl;
    const recipe = JSON.parse(JSON.stringify(e.recipe));
    const px = new Uint8Array(4);
    const times = [];
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      r.render(recipe, { mode: 'edit', present: false });
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return { ms: Math.round(times[2] * 10) / 10, size: [r.proxyWidth, r.proxyHeight] };
  });

// ---- Fitted view: vignette styles, grain.
await shot('fit-0-base');
results.fitMsDefault = await timeFit();
await set({ 'effects.vignetteAmount': -70 });
await shot('fit-1-vig-highlight');
await set({ 'effects.vignetteStyle': 'color', 'effects.vignetteHighlights': 80 });
await shot('fit-2-vig-color-hl80');
await set({ 'effects.vignetteStyle': 'paint', 'effects.vignetteHighlights': 0 });
await shot('fit-3-vig-paint');
await set({ 'effects.vignetteStyle': 'highlight', 'effects.vignetteAmount': 60 });
await shot('fit-4-vig-lighten');
await set({ 'effects.vignetteAmount': -80, 'effects.vignetteRoundness': 100, 'effects.vignetteFeather': 15 });
await shot('fit-5-vig-circle-hard');
await set({ 'effects.vignetteRoundness': -100, 'effects.vignetteFeather': 30, 'effects.vignetteMidpoint': 20 });
await shot('fit-6-vig-rect-mid20');
await resetEffects();
await set({ 'effects.grainAmount': 60 });
await shot('fit-7-grain60');
results.fitMsGrain = await timeFit();
await resetEffects();
await set({ 'detail.nrLuminance': 60 });
results.fitMsNr = await timeFit();
await set({ 'detail.nrLuminance': 0 });

// ---- 1:1 view: grain, noise reduction, sharpening views.
await page.waitForFunction(() => globalThis.__editor.fullStatus === 'ready', null, { timeout: 240000 });
results.sizes = await ed(() => ({ full: [globalThis.__editor.fullImage.width, globalThis.__editor.fullImage.height], camera: [globalThis.__editor.camera.fullWidth, globalThis.__editor.camera.fullHeight] }));
const [zx, zy] = (process.env.POS ?? '0.5,0.5').split(',').map(Number);
const zoomShot = async (label) => {
  await page.waitForTimeout(500);
  const z = await canvas.boundingBox();
  await page.screenshot({ path: join(out, `${name}-${label}.png`), clip: { x: z.x + z.width / 2 - 300, y: z.y + z.height / 2 - 200, width: 600, height: 400 } });
};
await ed(([x, y]) => globalThis.__editor.toggleZoom(x, y), [zx, zy]);
await set({ 'effects.grainAmount': 50 });
await zoomShot('z1-grain50');
await set({ 'effects.grainSize': 80, 'effects.grainRoughness': 100 });
await zoomShot('z2-grain-size80-rough100');
await resetEffects();
await set({ 'effects.grainSize': 25, 'effects.grainRoughness': 50 });
// Bring the noise up so noise reduction has something to do.
await set({ 'basic.exposure': 1.5, 'basic.shadows': 60, 'detail.nrColor': 0 });
await zoomShot('z3-nr-off');
await set({ 'detail.nrColor': 25 });
await zoomShot('z4-nr-color25');
await set({ 'detail.nrLuminance': 50 });
await zoomShot('z5-nr-lum50');
await set({ 'detail.nrLuminance': 100, 'detail.nrLuminanceDetail': 20 });
await zoomShot('z6-nr-lum100-detail20');
await set({ 'detail.nrLuminance': 50, 'detail.nrLuminanceDetail': 90, 'detail.nrLuminanceContrast': 80 });
await zoomShot('z7-nr-lum50-detail90-contrast80');
await set({ 'detail.nrColor': 100, 'detail.nrColorSmoothness': 100, 'detail.nrLuminance': 0 });
await zoomShot('z8-nr-color100-smooth100');
results.zoomMsNr = await ed(() => {
  const e = globalThis.__editor;
  const r = e.renderer;
  const gl = r.gl;
  const recipe = JSON.parse(JSON.stringify(e.recipe));
  const view = { cx: e.zoom.cx, cy: e.zoom.cy, scale: 1, width: r.canvas.width, height: r.canvas.height };
  const px = new Uint8Array(4);
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    r.renderZoom(recipe, e.fullImage, view, {});
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { ms: Math.round(times[2] * 10) / 10, view: [view.width, view.height] };
});
await set({ 'basic.exposure': 0, 'basic.shadows': 0, 'detail.nrColor': 25, 'detail.nrColorSmoothness': 50, 'detail.nrLuminanceDetail': 50, 'detail.nrLuminanceContrast': 0 });
for (const view of ['sharpenAmount', 'sharpenRadius', 'sharpenDetail', 'sharpenMask']) {
  await ed((v) => globalThis.__editor.setMaskView(v), view);
  await zoomShot(`z9-alt-${view}`);
}
await ed(() => globalThis.__editor.setMaskView('none'));
await ed(() => globalThis.__editor.setZoom(false));

// ---- 1:1 view vs tiled export, across the first tile boundary.
await set({
  'crop.w': 0.6,
  'crop.h': 0.6,
  'crop.aspect': 'free',
  'effects.vignetteAmount': -50,
  'effects.grainAmount': 50,
  'detail.nrLuminance': 40,
});
await page.waitForTimeout(400);
results.match = await page.evaluate(async () => {
  const e = globalThis.__editor;
  const r = e.renderer;
  const recipe = JSON.parse(JSON.stringify(e.recipe));
  const t0 = performance.now();
  const img = await r.exportImage(recipe, e.fullImage);
  const exportMs = Math.round(performance.now() - t0);
  const W = img.width;
  const H = img.height;
  const ex = img.data;
  // Export seams: a step at the tile boundary would stand out against neighbouring columns.
  const colStep = (x) => {
    let s = 0;
    for (let y = 0; y < H; y++) for (let c = 0; c < 3; c++) s += Math.abs(ex[(y * W + x) * 4 + c] - ex[(y * W + x - 1) * 4 + c]);
    return s / (H * 3);
  };
  const seam = W > 2048 ? { at2048: colStep(2048), at2047: colStep(2047), at2049: colStep(2049), at1500: colStep(1500) } : null;
  // 1:1 view centred on the tile boundary.
  e.zoom = { on: true, cx: Math.min(2048, W - 10) / W, cy: 0.5, scale: 1 };
  e.renderNow ? e.renderNow() : e.requestRender();
  await new Promise((res) => setTimeout(res, 600));
  const T = r.t['zoom.fin'];
  const gl = r.gl;
  const buf = new Uint8Array(T.width * T.height * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, T.fb);
  gl.readPixels(0, 0, T.width, T.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const z = e.zoom;
  const ox = Math.round(z.cx * W - T.width / 2);
  const oy = Math.round(z.cy * H - T.height / 2);
  // Away from the view's edges, where the zoom view has no apron for noise reduction.
  const m = 140;
  let sum = 0, max = 0, n = 0, big = 0;
  for (let y = m; y < T.height - m; y++) {
    for (let x = m; x < T.width - m; x++) {
      const X = ox + x, Y = oy + y;
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(buf[(y * T.width + x) * 4 + c] - ex[(Y * W + X) * 4 + c]);
        sum += d;
        max = Math.max(max, d);
        if (d > 3) big++;
        n++;
      }
    }
  }
  return { W, H, exportMs, view: [T.width, T.height, ox, oy], meanDiff: sum / n, maxDiff: max, over3: big / n, seam };
});
await ed(() => globalThis.__editor.setZoom(false));
await ed(() => globalThis.__editor.resetAll());
results.errors = errors;
console.log(JSON.stringify(results, null, 1));
await browser.close();
