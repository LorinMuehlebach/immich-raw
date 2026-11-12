// Colour-space exports against the test Immich (seeded): the sRGB export must not change when
// wide-gamut and 16-bit output exist, and the other spaces must show the same picture once a
// colour-managed browser decodes them.
//
//   node e2e/probe-colour.mjs <out-dir> --baseline   with a build from before (writes baseline-srgb8.png)
//   node e2e/probe-colour.mjs <out-dir>              with the new build: compares against it
//
// Exports PNGs of one RAW at 1200 px with the editor's default settings plus a little vibrance
// and saturation (nothing is saved), and decodes them in the page into an sRGB canvas.
// Usage: node e2e/probe-colour.mjs <out-dir> [--baseline] [filename-part] (default DSCF7869)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { API_BASE, INSECURE, PAGE_BASE, browserArgs, loginOnPageOrigin } from './insecure.mjs';

const args = process.argv.slice(2);
const baseline = args.includes('--baseline');
const [outDir, namePart = 'DSCF7869'] = args.filter((a) => a !== '--baseline');
if (!outDir) {
  console.error('Usage: node e2e/probe-colour.mjs <out-dir> [--baseline] [filename-part]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const BASELINE = join(outDir, 'baseline-srgb8.png');
const LOGIN = { email: 'admin@example.com', password: 'raw-editor-e2e' };
const results = [];
const check = (name, ok, details = {}) => {
  results.push({ name, ok, details });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(details)}`);
};

const watermark = { enabled: false, kind: 'text', text: '', position: 'bottom-right', size: 3, opacity: 70, color: 'white', imageId: null, imageSize: 15 };
const preset = (format, color) => ({
  format,
  color,
  size: { mode: 'longEdge', value: 1200, unit: 'px' },
  ppi: 72,
  quality: { jpeg: 92 },
  lossless: false,
  sharpen: { for: 'none', amount: 'standard' },
  watermark,
  metadata: 'copyright',
  naming: '{name}-{preset}',
});
const settings = (low, medium, high) => ({ presets: { low, medium, high }, immichPreset: 'medium', copyright: '' });
const ROUND1 = settings(preset('png', { space: 'srgb', bits: 8 }), preset('png', { space: 'display-p3', bits: 8 }), preset('png', { space: 'srgb', bits: 16 }));
const ROUND2 = settings(preset('png', { space: 'adobe-rgb', bits: 8 }), preset('png', { space: 'prophoto', bits: 16 }), preset('tiff', { space: 'prophoto', bits: 16 }));

function pngChunks(buf) {
  const chunks = [];
  for (let p = 8; p + 12 <= buf.length; ) {
    const len = buf.readUInt32BE(p);
    chunks.push({ type: buf.toString('latin1', p + 4, p + 8), data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
  }
  return chunks;
}

/** What the page shows when a step fails (set once the page is open). */
let failed = async () => ({});

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? 'msedge',
  headless: process.env.HEADED ? false : true,
  args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', ...browserArgs],
});
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const login = await context.request.post(`${API_BASE}/api/auth/login`, { data: LOGIN });
  check('login', login.ok());
  if (INSECURE) await loginOnPageOrigin(context, LOGIN);
  const found = await (await context.request.post(`${API_BASE}/api/search/metadata`, { data: { originalFileName: namePart, size: 10 } })).json();
  const raw = found.assets?.items?.find((a) => /\.(arw|nef|cr2|cr3|raf|rw2|orf|dng)$/i.test(a.originalFileName));
  check('find the RAW', !!raw, { file: raw?.originalFileName });
  if (!raw) throw new Error('seed the instance first: node e2e/seed.mjs <samples>');
  // The default settings, the same for every run: forget any saved edit (nothing is saved here).
  await context.request.delete(`${API_BASE}/api/assets/${raw.id}/metadata/raw-editor.recipe`);

  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));
  page.on('crash', () => errors.push('page crashed'));
  failed = async () => {
    await page.screenshot({ path: join(outDir, 'failed.png') }).catch(() => {});
    const notice = await page.locator('.toast, .error').allTextContents().catch(() => []);
    return { errors: errors.slice(-6), notice };
  };
  const open = async (s) => {
    await page.goto(`${PAGE_BASE}/immich-raw/?asset=${raw.id}`);
    await page.evaluate((v) => localStorage.setItem('raw-editor.export', JSON.stringify(v)), s);
    await page.reload();
    await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
    await page.locator('input[aria-label="Vibrance"]').fill('40');
    await page.locator('input[aria-label="Saturation"]').first().fill('20');
    await page.waitForTimeout(500);
  };
  const exportAs = async (name) => {
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.getByRole('button', { name, exact: true }).click()]);
    const path = join(outDir, `${baseline ? 'base-' : ''}${d.suggestedFilename()}`);
    await d.saveAs(path);
    return readFileSync(path);
  };
  /**
   * Statistics of |a - b| (per pixel, the largest of R, G and B) over two PNGs decoded,
   * colour-managed, into an 8-bit sRGB canvas. `block` > 1 compares the averages of block x block
   * squares instead: different resampling filters (the browser's for 8 bits, Lanczos-3 for 16)
   * disagree on fine edges, colour and tone errors don't average out. `bias`: the mean signed
   * difference b - a per channel.
   */
  const compare = (a, b, block = 1) =>
    page.evaluate(
      async ([a64, b64, block]) => {
        const decode = async (b64) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
          const c = new OffscreenCanvas(bmp.width, bmp.height);
          const ctx = c.getContext('2d', { colorSpace: 'srgb' });
          ctx.drawImage(bmp, 0, 0);
          return ctx.getImageData(0, 0, bmp.width, bmp.height, { colorSpace: 'srgb' });
        };
        const averaged = (img) => {
          const w = Math.floor(img.width / block);
          const h = Math.floor(img.height / block);
          const out = new Float32Array(w * h * 3);
          for (let y = 0; y < h * block; y++) {
            for (let x = 0; x < w * block; x++) {
              const o = (Math.floor(y / block) * w + Math.floor(x / block)) * 3;
              const i = (y * img.width + x) * 4;
              for (let c = 0; c < 3; c++) out[o + c] += img.data[i + c] / (block * block);
            }
          }
          return { data: out, width: w, height: h };
        };
        const [dx, dy] = await Promise.all([decode(a64), decode(b64)]);
        if (dx.width !== dy.width || dx.height !== dy.height) return { size: [dx.width, dx.height, dy.width, dy.height] };
        const x = averaged(dx);
        const y = averaged(dy);
        const n = x.width * x.height;
        const bias = [0, 0, 0];
        for (let p = 0; p < n; p++) for (let c = 0; c < 3; c++) bias[c] += (y.data[p * 3 + c] - x.data[p * 3 + c]) / n;
        // offset: subtract the mean difference first (a uniform shift, the same for every pixel).
        const stats = (offset) => {
          let max = 0;
          let sum = 0;
          let within1 = 0;
          let within2 = 0;
          let within4 = 0;
          for (let p = 0; p < n; p++) {
            let m = 0;
            for (let c = 0; c < 3; c++) {
              const d = Math.abs(y.data[p * 3 + c] - x.data[p * 3 + c] - (offset ? bias[c] : 0));
              m = Math.max(m, d);
              sum += d;
            }
            max = Math.max(max, m);
            if (m <= 1) within1++;
            if (m <= 2) within2++;
            if (m <= 4) within4++;
          }
          const pct = (k) => Math.round((k / n) * 10000) / 100;
          return { max: r3(max), mean: r3(sum / (3 * n)), within1: pct(within1), within2: pct(within2), within4: pct(within4) };
        };
        const r3 = (v) => Math.round(v * 1000) / 1000;
        return { block, width: x.width, height: x.height, ...stats(false), bias: bias.map(r3), residual: stats(true) };
      },
      [a.toString('base64'), b.toString('base64'), block],
    );

  if (baseline) {
    await open(ROUND1);
    const png = await exportAs('Low');
    writeFileSync(BASELINE, png);
    check('baseline sRGB 8-bit PNG written', pngChunks(png)[0]?.type === 'IHDR', { file: BASELINE, bytes: png.length });
  } else {
    if (!existsSync(BASELINE)) throw new Error(`no ${BASELINE}: run with --baseline on the old build first`);
    await open(ROUND1);
    const srgb8 = await exportAs('Low');
    const same = await compare(readFileSync(BASELINE), srgb8);
    check('sRGB 8-bit export unchanged from the baseline', same.max <= 1 && same.within1 === 100, same);
    const ihdr8 = pngChunks(srgb8).find((c) => c.type === 'IHDR').data;
    check('sRGB 8-bit PNG: 8 bits and an sRGB chunk', ihdr8[8] === 8 && pngChunks(srgb8).some((c) => c.type === 'sRGB'));

    const p3 = await exportAs('Medium');
    const p3Chunks = pngChunks(p3);
    const iccp = p3Chunks.find((c) => c.type === 'iCCP');
    check('Display P3 PNG: iCCP named Display P3, no sRGB chunk', !!iccp && iccp.data.toString('latin1', 0, 10) === 'Display P3' && !p3Chunks.some((c) => c.type === 'sRGB'));
    const p3Diff = await compare(srgb8, p3);
    check('Display P3, decoded to sRGB, shows the same picture', p3Diff.within2 >= 99 && p3Diff.mean < 0.5, p3Diff);

    const srgb16 = await exportAs('High');
    const ihdr16 = pngChunks(srgb16).find((c) => c.type === 'IHDR').data;
    check('sRGB 16-bit PNG: IHDR depth 16, colour type RGB', ihdr16[8] === 16 && ihdr16[9] === 2);
    // Different resamplers: the browser's for 8 bits truncates while it halves the image (about
    // 0.4 levels darker per halving) and filters edges differently from Lanczos-3 for 16 bits.
    // So: 16 x 16 averages, a uniform offset of under 1.5 levels, the same in R, G and B, and
    // little left besides it.
    const sameShift = (b) => Math.abs(b[0] - b[1]) < 0.2 && Math.abs(b[1] - b[2]) < 0.2 && b.every((v) => Math.abs(v) < 1.5);
    const d16 = await compare(srgb8, srgb16, 16);
    check('sRGB 16-bit matches 8-bit (16 x 16 averages: a uniform resampling offset, no colour shift)', sameShift(d16.bias) && d16.residual.within2 >= 99, d16);

    await open(ROUND2);
    const adobe = await exportAs('Low');
    const adobeDiff = await compare(srgb8, adobe);
    check('Adobe RGB, decoded to sRGB, shows the same picture', adobeDiff.within2 >= 99 && adobeDiff.mean < 0.5, adobeDiff);
    const prophoto = await exportAs('Medium');
    const proDiff = await compare(srgb8, prophoto, 16);
    check('ProPhoto 16-bit, decoded to sRGB, shows the same picture (16 x 16 averages, as above)', sameShift(proDiff.bias) && proDiff.residual.within2 >= 99, proDiff);
    const tiff = await exportAs('High');
    const tags = (() => {
      const ifd = tiff.readUInt32LE(4);
      const out = {};
      for (let i = 0, n = tiff.readUInt16LE(ifd); i < n; i++) {
        const e = ifd + 2 + i * 12;
        out[tiff.readUInt16LE(e)] = { type: tiff.readUInt16LE(e + 2), count: tiff.readUInt32LE(e + 4), at: tiff.readUInt32LE(e + 8) };
      }
      return out;
    })();
    const bps = tags[258] ? [0, 1, 2].map((k) => tiff.readUInt16LE(tags[258].at + k * 2)) : [];
    const icc = tags[34675] ? tiff.subarray(tags[34675].at, tags[34675].at + tags[34675].count) : null;
    check('ProPhoto 16-bit TIFF: 16 bits a sample and a ProPhoto ICC profile', bps.join() === '16,16,16' && !!icc && icc.toString('latin1', 36, 40) === 'acsp' && icc.includes(Buffer.from('ProPhoto RGB')), { bps, icc: icc?.length });
  }
} catch (e) {
  check('fatal', false, { error: String(e?.message ?? e).slice(0, 300), page: await failed() });
} finally {
  await browser.close();
  writeFileSync(join(outDir, baseline ? 'probe-colour-baseline.json' : 'probe-colour.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
}
