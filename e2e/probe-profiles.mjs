// Profiles: renders seeded RAWs with each profile, checks the tone-only profiles render exactly
// as a baseline build did, compares the Fujifilm Provia look with the camera's own JPEG, and
// writes contact sheets of every profile. Renders in memory only; nothing is saved to Immich.
//
// Usage: node e2e/probe-profiles.mjs <out-dir> <asset-id>[,<asset-id>...]
//   WRITE_BASELINE=<file>  store the tone-only profiles' pixels as the baseline (any build)
//   BASELINE=<file>        compare against a stored baseline
//   FUJI=<asset-id> RAF=<path to that .RAF>   Provia vs the RAF's embedded JPEG, over an exposure sweep
//   SHEETS=1               contact sheets of every profile (and Vivid / Classic Chrome at 0, 100, 200 %)
// IMMICH_URL points at the editor (default http://127.0.0.1:8088, or a dev server such as
// http://localhost:5173).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
const [out, idList] = process.argv.slice(2);
if (!out || !idList) throw new Error('Usage: node e2e/probe-profiles.mjs <out-dir> <asset-id>[,...]');
const ids = idList.split(',');
mkdirSync(out, { recursive: true });

const TONE_ONLY = ['color', 'neutral', 'linear', 'monochrome'];
const SMALL = 1024;

const browser = await chromium.launch({ channel: 'msedge', headless: !process.env.HEADED, args: ['--enable-gpu', '--use-angle=d3d11'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'admin@example.com', password: 'raw-editor-e2e' } });
const page = await ctx.newPage();
// Moving on from a photo with (in-memory) changes asks before leaving.
page.on('dialog', (d) => d.accept());
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || /WebGL|INVALID_OPERATION|GL_INVALID/i.test(t)) problems.push(t);
});
const ed = (fn, arg) => page.evaluate(fn, arg);

async function open(id) {
  await page.goto(`${BASE}/immich-raw/?asset=${id}&debug`);
  await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 180000 });
  await page.waitForFunction(() => !globalThis.__editor.lensInfo.searching, null, { timeout: 60000 });
  return ed(() => globalThis.__editor.asset.originalFileName);
}

// The recipe: the photo's reset state with these changes (in memory; no history needed).
const recipeWith = (changes) =>
  ed((c) => {
    const e = globalThis.__editor;
    e.resetAll();
    const r = JSON.parse(JSON.stringify(e.recipe));
    for (const [path, value] of Object.entries(c)) {
      const keys = path.split('.');
      let cur = r;
      for (const k of keys.slice(0, -1)) cur = cur[k];
      cur[keys.at(-1)] = value;
    }
    return r;
  }, changes);

/** Renders `recipe` small; returns its size, a SHA-256 of the pixels and the pixels (base64). */
const renderSmall = (recipe) =>
  ed(
    async ([r, side]) => {
      const { image } = globalThis.__editor.renderer.renderSmall(r, side);
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', image.data))].map((b) => b.toString(16).padStart(2, '0')).join('');
      let bin = '';
      for (let i = 0; i < image.data.length; i += 0x8000) bin += String.fromCharCode(...image.data.subarray(i, i + 0x8000));
      return { width: image.width, height: image.height, hash, rgba: btoa(bin) };
    },
    [recipe, SMALL],
  );

/** Full (half-size decode) export of `recipe`: hash only. */
const exportHash = (recipe) =>
  ed(async (r) => {
    const e = globalThis.__editor;
    const image = await e.renderer.exportImage(r, e.session.half);
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', image.data))].map((b) => b.toString(16).padStart(2, '0')).join('');
  }, recipe);

const report = {};

// ---- Tone-only profiles: same pixels as the baseline build.
if (process.env.WRITE_BASELINE || process.env.BASELINE) {
  const baseline = process.env.BASELINE ? JSON.parse(readFileSync(process.env.BASELINE, 'utf8')) : null;
  const store = {};
  for (const id of ids) {
    const name = await open(id);
    for (const profile of TONE_ONLY) {
      const recipe = await recipeWith({ profile });
      const small = await renderSmall(recipe);
      const full = await exportHash(recipe);
      const key = `${name}:${profile}`;
      const file = join(out, `${name}-${profile}.rgba`);
      writeFileSync(file, Buffer.from(small.rgba, 'base64'));
      store[key] = { small: small.hash, full, size: [small.width, small.height], file };
      if (baseline) {
        const b = baseline[key];
        const same = b && b.small === small.hash && b.full === full;
        let diff = null;
        if (b && !same) {
          const x = readFileSync(b.file);
          const y = Buffer.from(small.rgba, 'base64');
          let max = 0;
          let n = 0;
          for (let i = 0; i < Math.min(x.length, y.length); i++) {
            const d = Math.abs(x[i] - y[i]);
            if (d) n++;
            if (d > max) max = d;
          }
          diff = { maxChannelDiff: max, differingBytes: n, of: x.length, fullSame: b.full === full };
        }
        (report.regression ??= {})[key] = same ? 'identical' : diff ?? 'missing in baseline';
      }
    }
  }
  if (process.env.WRITE_BASELINE) writeFileSync(process.env.WRITE_BASELINE, JSON.stringify(store, null, 1));
}

// ---- Fujifilm: Provia vs the camera's JPEG.
if (process.env.FUJI && process.env.RAF) {
  const raf = readFileSync(process.env.RAF);
  const at = raf.readUInt32BE(84);
  const len = raf.readUInt32BE(88);
  const jpeg = raf.subarray(at, at + len).toString('base64');
  await open(process.env.FUJI);
  // Downloads the film looks (the probe agrees on the user's behalf).
  await ed(() => globalThis.__editor.acceptFujiOffer());
  await page.waitForFunction(() => !!globalThis.__editor.renderer.profileFor({ ...globalThis.__editor.recipe, profile: 'fuji-provia' }).look, null, { timeout: 120000 });
  const sweep = [];
  for (let ev = -0.6; ev <= 1.001; ev += 0.1) sweep.push(Math.round(ev * 10) / 10);
  const fuji = await ed(
    async ([jpegB64, evs]) => {
      const e = globalThis.__editor;
      // OKLab of linear sRGB.
      const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      const lab = (r, g, b) => {
        const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
        const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
        const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
        return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
      };
      const W = 96;
      const H = 64;
      const shrink = (src) => {
        const c = new OffscreenCanvas(W, H);
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(src, 0, 0, W, H);
        const d = g.getImageData(0, 0, W, H).data;
        const px = [];
        for (let i = 0; i < d.length; i += 4) px.push(lab(lin(d[i] / 255), lin(d[i + 1] / 255), lin(d[i + 2] / 255)));
        return px;
      };
      const bytes = Uint8Array.from(atob(jpegB64), (ch) => ch.charCodeAt(0));
      const cam = shrink(await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { imageOrientation: 'from-image' }));
      const toCanvas = (img) => {
        const c = new OffscreenCanvas(img.width, img.height);
        c.getContext('2d').putImageData(img, 0, 0);
        return c;
      };
      const compare = (px) => {
        let de = 0;
        const bands = [0, 0, 0, 0, 0];
        const counts = [0, 0, 0, 0, 0];
        let midDl = 0;
        let mid = 0;
        for (let i = 0; i < px.length; i++) {
          const [L, a, b] = px[i];
          const [L0, a0, b0] = cam[i];
          de += Math.hypot(L - L0, a - a0, b - b0);
          const q = Math.min(4, Math.floor(L0 * 5));
          bands[q] += L - L0;
          counts[q]++;
          if (L0 > 0.3 && L0 < 0.7) {
            midDl += L - L0;
            mid++;
          }
        }
        return { meanDE: +(de / px.length).toFixed(4), midDL: +(midDl / Math.max(1, mid)).toFixed(4), dLbyBand: bands.map((v, i) => +(v / Math.max(1, counts[i])).toFixed(4)) };
      };
      e.resetAll();
      const base = JSON.parse(JSON.stringify(e.recipe));
      const render = (profile, exposure) => compare(shrink(toCanvas(e.renderer.renderSmall({ ...base, profile, basic: { ...base.basic, exposure } }, 1024).image)));
      const rows = evs.map((ev) => ({ ev, ...render('fuji-provia', ev) }));
      return { color: render('color', 0), provia: render('fuji-provia', 0), sweep: rows, best: rows.reduce((a, b) => (Math.abs(b.midDL) < Math.abs(a.midDL) ? b : a)) };
    },
    [jpeg, sweep],
  );
  report.fuji = fuji;
  // A side-by-side picture: camera JPEG | Provia | Color.
  const png = await ed(async (jpegB64) => {
    const e = globalThis.__editor;
    e.resetAll();
    const base = JSON.parse(JSON.stringify(e.recipe));
    const a = e.renderer.renderSmall({ ...base, profile: 'fuji-provia' }, 800).image;
    const b = e.renderer.renderSmall({ ...base, profile: 'color' }, 800).image;
    const bytes = Uint8Array.from(atob(jpegB64), (ch) => ch.charCodeAt(0));
    const cam = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { imageOrientation: 'from-image' });
    const c = new OffscreenCanvas(a.width * 3, a.height + 24);
    const g = c.getContext('2d');
    g.fillStyle = '#222';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(cam, 0, 24, a.width, a.height);
    g.putImageData(a, a.width, 24);
    g.putImageData(b, a.width * 2, 24);
    g.fillStyle = '#eee';
    g.font = '16px sans-serif';
    ['Camera JPEG (Provia)', 'fuji-provia', 'color'].forEach((t, i) => g.fillText(t, i * a.width + 8, 18));
    const blob = await c.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }, jpeg);
  writeFileSync(join(out, 'fuji-provia-vs-camera.png'), Buffer.from(png, 'base64'));
}

// ---- Contact sheets.
if (process.env.SHEETS) {
  for (const id of ids) {
    const name = await open(id);
    await ed(() => globalThis.__editor.acceptFujiOffer());
    const png = await ed(async () => {
      const e = globalThis.__editor;
      e.resetAll();
      const base = JSON.parse(JSON.stringify(e.recipe));
      const cells = [
        ...['color', 'vivid', 'portrait', 'landscape', 'neutral', 'monochrome', 'linear'].map((p) => [p, 100]),
        ...['fuji-provia', 'fuji-velvia', 'fuji-astia', 'fuji-classic-chrome', 'fuji-reala-ace', 'fuji-pro-neg-hi', 'fuji-pro-neg-std', 'fuji-classic-neg', 'fuji-nostalgic-neg', 'fuji-eterna', 'fuji-bleach-bypass'].map((p) => [p, 100]),
        ['vivid', 0],
        ['vivid', 200],
        ['fuji-classic-chrome', 0],
        ['fuji-classic-chrome', 200],
      ];
      const imgs = cells.map(([profile, profileAmount]) => e.renderer.renderSmall({ ...base, profile, profileAmount }, 420).image);
      const w = imgs[0].width;
      const h = imgs[0].height;
      const cols = 6;
      const rows = Math.ceil(imgs.length / cols);
      const c = new OffscreenCanvas(cols * w, rows * (h + 20));
      const g = c.getContext('2d');
      g.fillStyle = '#222';
      g.fillRect(0, 0, c.width, c.height);
      g.font = '13px sans-serif';
      imgs.forEach((img, i) => {
        const x = (i % cols) * w;
        const y = Math.floor(i / cols) * (h + 20);
        g.putImageData(img, x, y + 20);
        g.fillStyle = '#eee';
        g.fillText(`${cells[i][0]} ${cells[i][1]} %`, x + 6, y + 15);
      });
      const blob = await c.convertToBlob({ type: 'image/png' });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(bin);
    });
    writeFileSync(join(out, `${name}-profiles.png`), Buffer.from(png, 'base64'));
  }
}

report.problems = problems;
console.log(JSON.stringify(report, null, 1));
await browser.close();
if (problems.length) process.exitCode = 1;
