// Editing photos that aren't RAWs: uploads a JPEG, a PNG and a TIFF made here to the test Immich
// and checks that
// - each opens with the warning (once per browser; every time for the TIFF, which the browser
//   can't read, so the editor works on Immich's JPEG of it) and the "not a RAW" tag;
// - at the starting settings the editor renders them unchanged (bright saturated colours too);
// - Convert to DNG isn't offered;
// - Save stacks the edit on top of the JPEG, and the edit opens again.
// Deletes what it uploaded. Usage: node e2e/probe-non-raw.mjs <out-dir>
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
const outDir = process.argv[2] ?? 'probe-non-raw-out';
mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, details) => {
  results.push({ name, ok: !!ok, ...(details ? { details } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${details ? ` ${JSON.stringify(details)}` : ''}`);
};

const W = 1200;
const H = 800;
/** Flat patches of the test image: [name, x, y, w, h, rgb]. */
const PATCHES = [
  ['red', 60, 60, 160, 160, [250, 30, 30]],
  ['blue', 280, 60, 160, 160, [30, 60, 250]],
  ['yellow', 500, 60, 160, 160, [255, 230, 0]],
  ['white', 720, 60, 160, 160, [255, 255, 255]],
  ['grey', 940, 60, 160, 160, [118, 118, 118]],
];

/** The test image as RGBA: smooth colour gradients and the flat patches. */
function testImage() {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      px[i] = Math.round((255 * x) / (W - 1));
      px[i + 1] = Math.round((255 * y) / (H - 1));
      px[i + 2] = Math.round(200 * (1 - x / (W - 1)) + 30);
      px[i + 3] = 255;
    }
  }
  for (const [, x0, y0, w, h, rgb] of PATCHES) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px.set([...rgb, 255], (y * W + x) * 4);
  }
  return px;
}

/** A baseline 8-bit RGB TIFF, uncompressed (browsers other than Safari can't show these). */
function tiff(rgba) {
  const n = W * H * 3;
  const tags = [
    [256, 3, 1, W], // ImageWidth
    [257, 3, 1, H], // ImageLength
    [258, 3, 3, 0], // BitsPerSample -> offset
    [259, 3, 1, 1], // Compression: none
    [262, 3, 1, 2], // RGB
    [273, 4, 1, 0], // StripOffsets -> data
    [277, 3, 1, 3], // SamplesPerPixel
    [278, 3, 1, H], // RowsPerStrip
    [279, 4, 1, n], // StripByteCounts
  ];
  const ifd = 8;
  const ifdSize = 2 + tags.length * 12 + 4;
  const bps = ifd + ifdSize;
  const data = bps + 6;
  const buf = Buffer.alloc(data + n);
  buf.write('II', 0, 'latin1');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifd, 4);
  buf.writeUInt16LE(tags.length, ifd);
  tags.forEach(([tag, type, count, value], k) => {
    const o = ifd + 2 + k * 12;
    buf.writeUInt16LE(tag, o);
    buf.writeUInt16LE(type, o + 2);
    buf.writeUInt32LE(count, o + 4);
    const v = tag === 258 ? bps : tag === 273 ? data : value;
    if (type === 3 && count === 1) buf.writeUInt16LE(v, o + 8);
    else buf.writeUInt32LE(v, o + 8);
  });
  for (let k = 0; k < 3; k++) buf.writeUInt16LE(8, bps + 2 * k);
  for (let i = 0, o = data; i < W * H; i++) {
    buf[o++] = rgba[i * 4];
    buf[o++] = rgba[i * 4 + 1];
    buf[o++] = rgba[i * 4 + 2];
  }
  return buf;
}

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-gpu', '--use-angle=d3d11'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'admin@example.com', password: 'raw-editor-e2e' } });
const api = async (method, path, data) => {
  const res = await ctx.request.fetch(`${BASE}/api${path}`, { method, data });
  return { status: res.status(), body: await res.json().catch(() => null) };
};
const run = Date.now().toString(36);
const uploaded = [];
async function upload(name, bytes, mimeType) {
  const res = await ctx.request.post(`${BASE}/api/assets`, {
    headers: { 'x-immich-checksum': createHash('sha1').update(bytes).digest('base64') },
    multipart: {
      assetData: { name, mimeType, buffer: bytes },
      fileCreatedAt: '2001-01-01T12:00:00.000Z',
      fileModifiedAt: '2001-01-01T12:00:00.000Z',
      filename: name,
    },
  });
  const { id } = await res.json();
  uploaded.push(id);
  return id;
}

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

async function open(id) {
  await page.goto(`${BASE}/immich-raw/?asset=${id}&debug`);
  await page.waitForFunction(() => ['ready', 'error'].includes(globalThis.__editor?.status), null, { timeout: 120000 });
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    const e = globalThis.__editor;
    return {
      status: e.status,
      error: e.error,
      isRaw: e.isRaw,
      note: e.notRawNote,
      size: e.camera && [e.camera.fullWidth, e.camera.fullHeight],
      recipe: { profile: e.recipe.profile, sharpen: e.recipe.detail.sharpenAmount, nrColor: e.recipe.detail.nrColor, lens: e.recipe.lens, exposure: e.recipe.basic.exposure },
    };
  });
}

/** The editor's full-size render at the current settings against the browser's decode of `bytes` (both 8-bit sRGB). */
async function compareToOriginal(base64, mime) {
  return page.evaluate(
    async ({ base64, mime, patches }) => {
      const e = globalThis.__editor;
      const full = await e.session.full();
      const rendered = await e.renderer.exportImage(JSON.parse(JSON.stringify(e.recipe)), full);
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const orig = g.getImageData(0, 0, bmp.width, bmp.height);
      if (orig.width !== rendered.width || orig.height !== rendered.height) return { sizeMismatch: [orig.width, orig.height, rendered.width, rendered.height] };
      let sum = 0;
      let max = 0;
      const a = orig.data;
      const b = rendered.data;
      for (let i = 0; i < a.length; i += 4) {
        for (let k = 0; k < 3; k++) {
          const d = Math.abs(a[i + k] - b[i + k]);
          sum += d;
          if (d > max) max = d;
        }
      }
      const avg = (d, x0, y0, w, h) => {
        const s = [0, 0, 0];
        for (let y = y0 + 10; y < y0 + h - 10; y++) for (let x = x0 + 10; x < x0 + w - 10; x++) for (let k = 0; k < 3; k++) s[k] += d[(y * orig.width + x) * 4 + k];
        const n = (w - 20) * (h - 20);
        return s.map((v) => Math.round((v / n) * 10) / 10);
      };
      const patchDiff = Object.fromEntries(patches.map(([name, x, y, w, h]) => [name, { original: avg(a, x, y, w, h), rendered: avg(b, x, y, w, h) }]));
      return { meanAbs: sum / ((a.length / 4) * 3), max, patches: patchDiff };
    },
    { base64, mime, patches: PATCHES },
  );
}

try {
  // The test images, encoded by the browser.
  await page.goto(`${BASE}/immich-raw/`);
  const encoded = await page.evaluate(
    async ({ w, h, px }) => {
      const c = new OffscreenCanvas(w, h);
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);
      const b64 = async (blob) => {
        const u = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
        return btoa(s);
      };
      return { jpeg: await b64(await c.convertToBlob({ type: 'image/jpeg', quality: 0.95 })), png: await b64(await c.convertToBlob({ type: 'image/png' })) };
    },
    { w: W, h: H, px: Array.from(testImage()) },
  );
  const jpegId = await upload(`probe-${run}.jpg`, Buffer.from(encoded.jpeg, 'base64'), 'image/jpeg');
  const pngId = await upload(`probe-${run}.png`, Buffer.from(encoded.png, 'base64'), 'image/png');
  const tiffId = await upload(`probe-${run}.tif`, tiff(testImage()), 'image/tiff');
  // Immich makes its previews in the background (the TIFF needs its JPEG).
  await page.waitForTimeout(8000);

  // 1. JPEG: opens with the warning and the tag, starts as it is.
  const j = await open(jpegId);
  check('JPEG opens', j.status === 'ready' && !j.error, { status: j.status, error: j.error });
  check('JPEG is not a RAW, warning shown the first time', !j.isRaw && j.note?.title === 'Not a RAW file.', { isRaw: j.isRaw, note: j.note });
  check('banner on screen', (await page.locator('.banner.not-raw-note').count()) === 1);
  const tag = await page.locator('.sub .not-raw').textContent().catch(() => null);
  check('title tag says JPEG, not a RAW', tag?.includes('JPEG, not a RAW'), { tag });
  check('starts with no profile curve, sharpening, NR or lens profile', j.recipe.profile === 'linear' && j.recipe.sharpen === 0 && j.recipe.nrColor === 0 && !j.recipe.lens.profile && !j.recipe.lens.removeCA, j.recipe);
  const profileLabel = await page.locator('select option[value="linear"]').first().textContent();
  check('profile reads None (as shot)', profileLabel === 'None (as shot)', { profileLabel });
  check('no Convert to DNG panel', (await page.locator('button.convert').count()) === 0);
  await page.screenshot({ path: join(outDir, '1-jpeg-opened.png') });

  const jd = await compareToOriginal(encoded.jpeg, 'image/jpeg');
  check('JPEG renders unchanged at the starting settings', jd.meanAbs < 0.75 && jd.max <= 4, { meanAbs: jd.meanAbs?.toFixed(3), max: jd.max, sizeMismatch: jd.sizeMismatch });
  const off = Object.entries(jd.patches ?? {}).filter(([, p]) => p.original.some((v, k) => Math.abs(v - p.rendered[k]) > 1.5));
  check('bright saturated colours stay saturated (no highlight reconstruction)', jd.patches && off.length === 0, jd.patches);

  // 2. The warning once per browser.
  await page.locator('.banner.not-raw-note button').click();
  const again = await open(jpegId);
  check('second open: no banner, the tag stays', !again.note && (await page.locator('.banner.not-raw-note').count()) === 0 && (await page.locator('.sub .not-raw').count()) === 1, { note: again.note });

  // 3. PNG.
  const p = await open(pngId);
  check('PNG opens as not a RAW', p.status === 'ready' && !p.isRaw, { status: p.status, error: p.error });
  const pd = await compareToOriginal(encoded.png, 'image/png');
  check('PNG renders unchanged at the starting settings', pd.meanAbs < 0.75 && pd.max <= 4, { meanAbs: pd.meanAbs?.toFixed(3), max: pd.max });

  // 4. TIFF: the browser can't read it, so Immich's JPEG of it, with the warning every time.
  const t = await open(tiffId);
  check('TIFF opens from Immich\'s JPEG', t.status === 'ready' && !t.isRaw, { status: t.status, error: t.error, size: t.size });
  check('TIFF warns that it is Immich\'s JPEG, though the warning was seen', t.note?.title === 'Not the original file.' && /can't read TIFF/.test(t.note.text), { note: t.note });
  await page.screenshot({ path: join(outDir, '2-tiff-opened.png') });

  // 5. Save an edit of the JPEG.
  await open(jpegId);
  await page.locator('input[aria-label="Exposure"]').fill('1');
  await page.waitForTimeout(500);
  await page.locator('header.top button.primary').click();
  const toast = page.locator('.toast', { hasText: 'Saved to Immich' });
  await toast.waitFor({ timeout: 120000 });
  const toastText = (await toast.textContent())?.replace(/\s+/g, ' ').trim();
  check('save says it is stacked on top of the original', toastText?.includes('stacked on top of the original'), { toastText });
  const meta = await api('GET', `/assets/${jpegId}/metadata/raw-editor.recipe`);
  const renderId = meta.body?.value?.render?.assetId;
  if (renderId) uploaded.push(renderId);
  const jpegInfo = await api('GET', `/assets/${jpegId}`);
  check('the edit is stored on the JPEG, its render in front of the stack', !!renderId && meta.body?.value?.basic?.exposure === 1 && jpegInfo.body?.stack?.primaryAssetId === renderId, {
    renderId,
    stack: jpegInfo.body?.stack,
  });
  const renderMeta = await api('GET', `/assets/${renderId}/metadata/raw-editor.render`);
  const renderInfo = await api('GET', `/assets/${renderId}`);
  check('the render points back to the JPEG', renderMeta.body?.value?.sourceAssetId === jpegId, { value: renderMeta.body?.value, name: renderInfo.body?.originalFileName });
  check('the render keeps the size', renderInfo.body?.exifInfo?.exifImageWidth === W || renderInfo.body?.width === W, { width: renderInfo.body?.width ?? renderInfo.body?.exifInfo?.exifImageWidth });
  check('decoder recorded as the browser', meta.body?.value?.decoder?.name === 'browser', { decoder: meta.body?.value?.decoder });

  // 6. Opening it again brings the edit back.
  const re = await open(jpegId);
  check('reopening shows the saved edit', re.status === 'ready' && re.recipe.exposure === 1, { exposure: re.recipe.exposure });
  await page.screenshot({ path: join(outDir, '3-jpeg-saved.png') });
} catch (e) {
  check('probe ran', false, { error: String(e?.stack ?? e) });
} finally {
  if (uploaded.length) await api('DELETE', '/assets', { ids: uploaded, force: true });
  await browser.close();
}
check('no page errors', errors.length === 0, { errors: errors.slice(0, 5) });
writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
