// End-to-end test of the export options and the album export against the test Immich
// (e2e/docker-compose.immich.yml, seeded). The presets are set to PNG, TIFF and a print-sized
// JPEG; each is exported once, then a two-photo album is exported as a ZIP (the folder picker
// can't be driven by a script, so it is hidden and the editor falls back to a ZIP). Then the
// presets switch to WebP, AVIF and JPEG XL, and each of those is exported once, and a logo
// watermark is picked in the settings and exported.
// Usage: node e2e/export.mjs <out-dir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { API_BASE, INSECURE, PAGE_BASE, browserArgs, expectedConsoleError, loginOnPageOrigin } from './insecure.mjs';

const [outDir] = process.argv.slice(2);
if (!outDir) {
  console.error('Usage: node e2e/export.mjs <out-dir>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const LOGIN = { email: 'admin@example.com', password: 'raw-editor-e2e' };
const ALBUM = 'immich-raw export test';
const RAW = /\.(arw|nef|cr2|cr3|raf|rw2|orf|dng)$/i;
const results = [];
const check = (name, ok, details = {}) => {
  results.push({ name, ok, details });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(details)}`);
};

const watermark = { enabled: false, text: '© {year} {owner}', position: 'bottom-right', size: 3, opacity: 70, color: 'white' };
const SETTINGS = {
  presets: {
    low: {
      format: 'png',
      size: { mode: 'width', value: 1000, unit: 'px' },
      ppi: 150,
      quality: 80,
      sharpen: { for: 'screen', amount: 'standard' },
      watermark: { ...watermark, enabled: true, size: 5 },
      metadata: 'all',
      naming: '{name}-{preset}',
    },
    medium: {
      format: 'tiff',
      size: { mode: 'megapixels', value: 2, unit: 'px' },
      ppi: 300,
      quality: 90,
      sharpen: { for: 'matte', amount: 'high' },
      watermark,
      metadata: 'copyright',
      naming: '{date}_{name}',
    },
    high: {
      format: 'jpeg',
      size: { mode: 'longEdge', value: 10, unit: 'cm' },
      ppi: 254,
      quality: 85,
      sharpen: { for: 'glossy', amount: 'low' },
      watermark,
      metadata: 'noLocation',
      naming: '{album}-{seq}',
    },
  },
  immichPreset: 'medium',
  copyright: '© {year} {owner} e2e',
};

/** The same presets as WebP, AVIF and JPEG XL. */
const CODEC_SETTINGS = {
  ...SETTINGS,
  presets: {
    low: { ...SETTINGS.presets.low, format: 'webp', color: { space: 'display-p3', bits: 8 }, quality: { webp: 80 }, watermark },
    medium: { ...SETTINGS.presets.medium, format: 'avif', color: { space: 'display-p3', bits: 8 }, size: { mode: 'longEdge', value: 1200, unit: 'px' }, quality: { avif: 60 }, metadata: 'all', naming: '{name}-{preset}' },
    high: { ...SETTINGS.presets.high, format: 'jxl', size: { mode: 'longEdge', value: 1000, unit: 'px' }, quality: { jxl: 85 }, metadata: 'all', naming: '{name}-{preset}' },
  },
};

// --- file readers ----------------------------------------------------------------------

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

function pngChunks(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((b, i) => buf[i] === b)) return null;
  const chunks = [];
  for (let p = 8; p + 12 <= buf.length; ) {
    const len = buf.readUInt32BE(p);
    chunks.push({ type: buf.toString('latin1', p + 4, p + 8), data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
  }
  return chunks;
}

/** IFD0 of a little-endian TIFF: tag -> first value (SHORT or LONG). */
function tiffTags(buf) {
  if (buf.toString('latin1', 0, 4) !== 'II*\0') return null;
  const ifd = buf.readUInt32LE(4);
  const tags = {};
  for (let i = 0, n = buf.readUInt16LE(ifd); i < n; i++) {
    const e = ifd + 2 + i * 12;
    const type = buf.readUInt16LE(e + 2);
    tags[buf.readUInt16LE(e)] = type === 3 ? buf.readUInt16LE(e + 8) : buf.readUInt32LE(e + 8);
  }
  return tags;
}

/** Entries of a stored ZIP: [{ name, data }]. */
function zipEntries(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.push({ name, data: buf.subarray(start, start + size) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** WebP chunks: [{ type, data }], or null. */
function riffChunks(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunks = [];
  for (let p = 12; p + 8 <= buf.length; ) {
    const size = buf.readUInt32LE(p + 4);
    chunks.push({ type: buf.toString('latin1', p, p + 4), data: buf.subarray(p + 8, p + 8 + size) });
    p += 8 + size + (size & 1);
  }
  return chunks;
}

/** ISO BMFF boxes between start and end: [{ type, start, end }] (payload offsets). */
function bmffBoxes(buf, start = 0, end = buf.length) {
  const boxes = [];
  for (let p = start; p + 8 <= end; ) {
    const size = buf.readUInt32BE(p) || end - p;
    boxes.push({ type: buf.toString('latin1', p + 4, p + 8), start: p + 8, end: p + size });
    p += size;
  }
  return boxes;
}

/** CICP of each nclx colr box of an AVIF: [[primaries, transfer, matrix]]. */
function avifNclx(buf) {
  const out = [];
  const meta = bmffBoxes(buf).find((b) => b.type === 'meta');
  const iprp = meta && bmffBoxes(buf, meta.start + 4, meta.end).find((b) => b.type === 'iprp');
  const ipco = iprp && bmffBoxes(buf, iprp.start, iprp.end).find((b) => b.type === 'ipco');
  for (const c of ipco ? bmffBoxes(buf, ipco.start, ipco.end) : []) {
    if (c.type === 'colr' && buf.toString('latin1', c.start, c.start + 4) === 'nclx') out.push([buf.readUInt16BE(c.start + 4), buf.readUInt16BE(c.start + 6), buf.readUInt16BE(c.start + 8)]);
  }
  return out;
}

const longEdge = (s) => (s ? Math.max(s.width, s.height) : 0);

// --- test ------------------------------------------------------------------------------

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? 'msedge',
  headless: process.env.HEADED ? false : true,
  args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', ...browserArgs],
});
let albumId = null;
let renderId = null;
const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
const api = async (method, path, data) => {
  const r = await context.request.fetch(`${API_BASE}/api${path}`, { method, data });
  return { status: r.status(), body: r.status() === 204 ? null : await r.json().catch(() => null) };
};
try {
  const login = await context.request.post(`${API_BASE}/api/auth/login`, { data: LOGIN });
  check('login', login.ok());
  if (INSECURE) await loginOnPageOrigin(context, LOGIN);

  const found = await api('POST', '/search/metadata', { size: 200, type: 'IMAGE' });
  const raws = (found.body?.assets?.items ?? []).filter((a) => RAW.test(a.originalFileName)).slice(0, 2);
  check('two seeded RAWs', raws.length === 2, { files: raws.map((r) => r.originalFileName) });
  if (raws.length < 2) throw new Error('seed the instance first: node e2e/seed.mjs <samples>');

  for (const a of (await api('GET', '/albums')).body ?? []) if (a.albumName === ALBUM) await api('DELETE', `/albums/${a.id}`);
  const album = await api('POST', '/albums', { albumName: ALBUM, assetIds: raws.map((r) => r.id) });
  albumId = album.body?.id;
  check('album created', !!albumId);

  // Once per tab, so a test can change the settings and reload.
  await context.addInitScript((settings) => {
    if (!sessionStorage.getItem('e2e.seeded')) {
      localStorage.setItem('raw-editor.export', JSON.stringify(settings));
      sessionStorage.setItem('e2e.seeded', '1');
    }
    delete window.showDirectoryPicker;
    window.showDirectoryPicker = undefined;
  }, SETTINGS);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && !expectedConsoleError(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  const raw = raws[0];
  const base = raw.originalFileName.replace(/\.[^.]+$/, '');
  await page.goto(`${PAGE_BASE}/immich-raw/?asset=${raw.id}&ctx=album:${albumId}`);
  await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });

  const download = async (button) => {
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), button.click()]);
    const path = join(outDir, d.suggestedFilename());
    await d.saveAs(path);
    return { name: d.suggestedFilename(), buf: readFileSync(path) };
  };

  // Low: PNG, 1000 px wide, watermark, all metadata
  const low = await download(page.getByRole('button', { name: 'Low', exact: true }));
  const chunks = pngChunks(low.buf);
  const ihdr = chunks?.find((c) => c.type === 'IHDR')?.data;
  const phys = chunks?.find((c) => c.type === 'pHYs')?.data;
  const xmp = chunks?.find((c) => c.type === 'iTXt')?.data.toString('utf8') ?? '';
  check('Low: PNG, 1000 px wide, 150 ppi, EXIF and XMP', low.name === `${base}-low.png` && ihdr?.readUInt32BE(0) === 1000 && phys?.readUInt32BE(0) === 5906 && !!chunks?.some((c) => c.type === 'eXIf') && xmp.includes('e2e'), {
    name: low.name,
    width: ihdr?.readUInt32BE(0),
    chunks: [...new Set(chunks?.map((c) => c.type))],
  });

  // Medium: TIFF, ~2 megapixels, Deflate
  const medium = await download(page.getByRole('button', { name: 'Medium', exact: true }));
  const tags = tiffTags(medium.buf);
  const mp = tags ? (tags[256] * tags[257]) / 1e6 : 0;
  check('Medium: TIFF, 2 MP, Deflate, date in the name', /^\d{4}-\d{2}-\d{2}_/.test(medium.name) && medium.name.endsWith(`${base}.tif`) && mp > 1.9 && mp <= 2.01 && tags[259] === 8, {
    name: medium.name,
    size: tags && `${tags[256]}x${tags[257]}`,
    compression: tags?.[259],
  });

  // High: JPEG, 10 cm at 254 ppi = 1000 px long edge
  const high = await download(page.getByRole('button', { name: 'High', exact: true }));
  check('High: JPEG, 10 cm at 254 ppi, album name', high.name === `${ALBUM}-001.jpg` && longEdge(jpegSize(high.buf)) === 1000, { name: high.name, size: jpegSize(high.buf) });

  // Album export: both RAWs as High into a ZIP, two at once
  await page.getByRole('button', { name: 'Export album…' }).click();
  await page.locator('.dialog select[aria-label="Preset"]').selectOption('high');
  await page.locator('select[aria-label="Photos at once"]').selectOption('2');
  await page.locator('.dialog .summary', { hasText: '2 photos' }).waitFor({ timeout: 60000 });
  // Count the photos shown in progress at the same time.
  await page.evaluate(() => {
    window.__peak = 0;
    new MutationObserver(() => (window.__peak = Math.max(window.__peak, document.querySelectorAll('.dialog .photos li').length))).observe(document.body, { childList: true, subtree: true });
  });
  const t0 = Date.now();
  const zip = await download(page.getByRole('button', { name: 'Export as ZIP' }));
  const entries = zipEntries(zip.buf) ?? [];
  const sizes = entries.map((e) => longEdge(jpegSize(e.data)));
  const names = entries.map((e) => e.name).sort();
  const peak = await page.evaluate(() => window.__peak);
  check('album export: ZIP with both photos, two at once', zip.name === `${ALBUM}.zip` && entries.length === 2 && sizes.every((s) => s === 1000) && names[0] === `${ALBUM}-001.jpg` && names[1] === `${ALBUM}-002.jpg` && peak === 2, {
    seconds: (Date.now() - t0) / 1000,
    entries: entries.map((e) => e.name),
    sizes,
    peak,
  });
  await page.locator('.dialog .result').waitFor({ timeout: 60000 });
  await page.screenshot({ path: join(outDir, 'album-export-done.png') });
  await page.getByRole('button', { name: 'Close' }).click();

  // The settings dialog opens and shows the seeded preset
  await page.getByRole('button', { name: 'Export settings' }).click();
  await page.getByRole('tab', { name: /Medium/ }).click();
  await page.screenshot({ path: join(outDir, 'settings.png') });
  const format = await page.locator('.dialog select').first().inputValue();
  check('settings dialog shows the preset', format === 'tiff', { format });
  await page.keyboard.press('Escape');

  // WebP, AVIF and JPEG XL: the same presets in the formats encoded in a worker.
  await page.evaluate((s) => localStorage.setItem('raw-editor.export', JSON.stringify(s)), CODEC_SETTINGS);
  await page.reload();
  await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
  /** Width and height as this browser decodes the file, or null when it can't. */
  const decoded = (buf, type) =>
    page.evaluate(
      async ({ b64, type }) => {
        try {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const bmp = await createImageBitmap(new Blob([bytes], { type }));
          return { width: bmp.width, height: bmp.height };
        } catch {
          return null;
        }
      },
      { b64: buf.toString('base64'), type },
    );
  const timed = async (button) => {
    const t = Date.now();
    const file = await download(button);
    return { ...file, seconds: (Date.now() - t) / 1000 };
  };

  const webp = await timed(page.getByRole('button', { name: 'Low', exact: true }));
  const riff = riffChunks(webp.buf) ?? [];
  const vp8x = riff.find((c) => c.type === 'VP8X')?.data;
  const webpXmp = riff.find((c) => c.type === 'XMP ')?.data.toString('utf8') ?? '';
  const webpSize = await decoded(webp.buf, 'image/webp');
  const webpIcc = riff.find((c) => c.type === 'ICCP')?.data;
  check('Low as Display P3 WebP: VP8X with ICC profile, EXIF and XMP, 1000 px wide, decodes', webp.name === `${base}-low.webp` && riff.map((c) => c.type).join() === 'VP8X,ICCP,VP8 ,EXIF,XMP ' && (vp8x?.[0] & 0x2c) === 0x2c && webpIcc?.toString('latin1', 36, 40) === 'acsp' && riff.find((c) => c.type === 'EXIF')?.data.toString('latin1', 0, 4) === 'II*\0' && webpXmp.includes('e2e') && webpSize?.width === 1000, {
    name: webp.name,
    chunks: riff.map((c) => c.type),
    decoded: webpSize,
    bytes: webp.buf.length,
    seconds: webp.seconds,
  });

  const avif = await timed(page.getByRole('button', { name: 'Medium', exact: true }));
  const brand = avif.buf.toString('latin1', 8, 12);
  const nclx = avifNclx(avif.buf);
  const avifSize = await decoded(avif.buf, 'image/avif');
  check('Medium as Display P3 AVIF: P3 colour description, 1200 px, decodes', avif.name === `${base}-medium.avif` && brand === 'avif' && nclx.length > 0 && nclx.every(([p, t]) => p === 12 && t === 13) && longEdge(avifSize) === 1200, {
    name: avif.name,
    brand,
    nclx,
    decoded: avifSize,
    bytes: avif.buf.length,
    seconds: avif.seconds,
  });

  const jxl = await timed(page.getByRole('button', { name: 'High', exact: true }));
  const jxlBoxes = bmffBoxes(jxl.buf).map((b) => b.type);
  const jxlc = bmffBoxes(jxl.buf).find((b) => b.type === 'jxlc');
  const jxlXmp = bmffBoxes(jxl.buf).find((b) => b.type === 'xml ');
  check('High as JPEG XL: container with Exif, XMP and the codestream', jxl.name === `${base}-high.jxl` && jxlBoxes.join() === 'JXL ,ftyp,Exif,xml ,jxlc' && jxl.buf[jxlc.start] === 0xff && jxl.buf[jxlc.start + 1] === 0x0a && jxl.buf.toString('utf8', jxlXmp.start, jxlXmp.end).includes('e2e') && jxl.buf.length > 20000, {
    name: jxl.name,
    boxes: jxlBoxes,
    bytes: jxl.buf.length,
    seconds: jxl.seconds,
  });

  // JPEG in Adobe RGB: the profile in APP2, Exif ColorSpace uncalibrated.
  await page.evaluate((s) => localStorage.setItem('raw-editor.export', JSON.stringify({ ...s, presets: { ...s.presets, high: { ...s.presets.high, format: 'jpeg', color: { space: 'adobe-rgb', bits: 8 } } } })), CODEC_SETTINGS);
  await page.reload();
  await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
  const adobe = await download(page.getByRole('button', { name: 'High', exact: true }));
  const app2 = (() => {
    for (let p = 2; p + 4 < adobe.buf.length && adobe.buf[p + 1] !== 0xda; p += 2 + adobe.buf.readUInt16BE(p + 2)) {
      if (adobe.buf[p + 1] === 0xe2 && adobe.buf.toString('latin1', p + 4, p + 15) === 'ICC_PROFILE') return adobe.buf.subarray(p + 18, p + 2 + adobe.buf.readUInt16BE(p + 2));
    }
    return null;
  })();
  check('High as Adobe RGB JPEG: ICC profile in APP2', !!app2 && app2.toString('latin1', 36, 40) === 'acsp' && app2.includes(Buffer.from('Adobe RGB (1998)')) && longEdge(jpegSize(adobe.buf)) === 1000, { name: adobe.name, icc: app2?.length });

  // Logo watermark: a red PNG picked in the settings, drawn into the bottom right of Low.
  const logoPng = Buffer.from(
    await page.evaluate(async () => {
      const c = new OffscreenCanvas(200, 100);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, 200, 100);
      const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
      return btoa(String.fromCharCode(...bytes));
    }),
    'base64',
  );
  const logoWatermark = { ...watermark, enabled: true, kind: 'image', imageSize: 20, opacity: 100, position: 'bottom-right' };
  const logoSettings = { ...SETTINGS, presets: { ...SETTINGS.presets, low: { ...SETTINGS.presets.low, watermark: logoWatermark } } };
  await page.evaluate((s) => localStorage.setItem('raw-editor.export', JSON.stringify(s)), logoSettings);
  await page.reload();
  await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
  await page.getByRole('button', { name: 'Export settings' }).click();
  await page.getByRole('tab', { name: /Low/ }).click();
  await page.locator('input[aria-label="Logo file"]').setInputFiles({ name: 'red.png', mimeType: 'image/png', buffer: logoPng });
  const picked = await page.locator('.dialog .logo-name', { hasText: '200 × 100' }).waitFor({ timeout: 15000 }).then(() => true, () => false);
  const thumbShown = await page.locator('.dialog .logo img').count();
  await page.screenshot({ path: join(outDir, 'settings-logo.png') });
  await page.keyboard.press('Escape');
  check('logo picked in the settings: name, size and thumbnail shown', picked && thumbShown === 1, { picked, thumbShown });

  const logoExport = await download(page.getByRole('button', { name: 'Low', exact: true }));
  // Where logoLayout puts a 2:1 logo at 20 % of the short edge, bottom right; and the middle.
  const samples = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const margin = Math.max(4, Math.round(Math.min(bmp.width, bmp.height) * 0.03));
    const long = 0.2 * Math.min(bmp.width, bmp.height);
    const at = (x, y) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)];
    return { width: bmp.width, logo: at(bmp.width - margin - long / 2, bmp.height - margin - long / 4), middle: at(bmp.width / 2, bmp.height / 2) };
  }, logoExport.buf.toString('base64'));
  const red = ([r, g, b]) => r > 230 && g < 30 && b < 30;
  check('Low with the logo: red where the logo goes, the photo elsewhere', logoExport.name === `${base}-low.png` && samples.width === 1000 && red(samples.logo) && !red(samples.middle), samples);

  // A preset whose logo isn't in this browser exports without it and says so.
  await page.evaluate(
    (s) => localStorage.setItem('raw-editor.export', JSON.stringify({ ...s, presets: { ...s.presets, low: { ...s.presets.low, watermark: { ...s.presets.low.watermark, imageId: 'logo-gone' } } } })),
    logoSettings,
  );
  await page.reload();
  await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
  const noLogo = await download(page.getByRole('button', { name: 'Low', exact: true }));
  const noLogoNotice = (await page.locator('.toast').first().textContent().catch(() => '')) ?? '';
  check('missing logo: exported without it, with a notice', noLogo.name === `${base}-low.png` && /watermark logo isn't in this browser/.test(noLogoNotice), { notice: noLogoNotice.trim() });

  // Immich: select the album's two photos, export them with the button in the selection bar
  const immich = await context.newPage();
  immich.on('pageerror', (e) => errors.push(String(e)));
  await immich.goto(`${PAGE_BASE}/albums/${albumId}`);
  const thumbs = immich.locator('[data-thumbnail-focus-container]');
  await thumbs.first().waitFor({ timeout: 60000 });
  await thumbs.first().hover();
  await thumbs.first().locator('[role="checkbox"]').click();
  await thumbs.nth(1).click();
  const exportButton = immich.locator('[data-raw-editor-export]');
  await exportButton.waitFor({ timeout: 10000 });
  await immich.screenshot({ path: join(outDir, 'immich-selection.png') });
  const [exportPage] = await Promise.all([context.waitForEvent('page'), exportButton.click()]);
  exportPage.on('pageerror', (e) => errors.push(String(e)));
  await exportPage.locator('.summary', { hasText: '2 photos' }).waitFor({ timeout: 60000 });
  const heading = await exportPage.locator('h2').first().textContent();
  await exportPage.locator('select[aria-label="Preset"]').selectOption('low');
  await exportPage.screenshot({ path: join(outDir, 'export-page.png') });
  const [selZip] = await Promise.all([exportPage.waitForEvent('download', { timeout: 600000 }), exportPage.getByRole('button', { name: 'Export as ZIP' }).click()]);
  const selPath = join(outDir, selZip.suggestedFilename());
  await selZip.saveAs(selPath);
  const selEntries = zipEntries(readFileSync(selPath)) ?? [];
  check('Immich selection: button opens the export page, ZIP with both photos', heading === 'Export 2 selected photos' && selEntries.length === 2 && selEntries.every((e) => e.name.endsWith('-low.png') && pngChunks(e.data)), {
    heading,
    zip: selZip.suggestedFilename(),
    entries: selEntries.map((e) => e.name),
  });
  await exportPage.close();

  // A saved edit (the editor's .edit.jpg) is rendered again from its RAW, not re-encoded: upload a
  // stand-in render linked to the first RAW and export only that.
  const date = new Date().toISOString();
  const upload = await context.request.post(`${API_BASE}/api/assets`, {
    multipart: { assetData: { name: `${base}.edit.jpg`, mimeType: 'image/jpeg', buffer: high.buf }, fileCreatedAt: date, fileModifiedAt: date },
  });
  renderId = (await upload.json().catch(() => null))?.id ?? null;
  await api('PUT', `/assets/${renderId}/metadata`, { items: [{ key: 'raw-editor.render', value: { sourceAssetId: raw.id, recipeHash: 'e2e', app: 'raw-editor' } }] });
  const handoff = { ids: [renderId], context: `album:${albumId}`, expected: 1, returnPath: '/', createdAt: Date.now() };
  await page.evaluate((h) => localStorage.setItem('immich-raw.export.e2erender', JSON.stringify(h)), handoff);
  const renderPage = await context.newPage();
  renderPage.on('pageerror', (e) => errors.push(String(e)));
  await renderPage.goto(`${PAGE_BASE}/immich-raw/?export=e2erender`);
  await renderPage.locator('.summary b').first().waitFor({ timeout: 60000 });
  await renderPage.locator('select[aria-label="Preset"]').selectOption('low');
  const renderSummary = (await renderPage.locator('.summary').textContent()) ?? '';
  const [renderZip] = await Promise.all([renderPage.waitForEvent('download', { timeout: 600000 }), renderPage.getByRole('button', { name: 'Export as ZIP' }).click()]);
  const renderPath = join(outDir, `render-${renderZip.suggestedFilename()}`);
  await renderZip.saveAs(renderPath);
  const renderEntries = zipEntries(readFileSync(renderPath)) ?? [];
  check('saved edit: rendered again from its RAW', !!renderId && /1 photo to export: 1 RAW/.test(renderSummary) && /rendered again from its RAW/.test(renderSummary) && renderEntries.length === 1 && renderEntries[0]?.name === `${base}-low.png`, {
    summary: renderSummary.replace(/\s+/g, ' ').trim(),
    entries: renderEntries.map((e) => e.name),
  });
  await renderPage.close();

  // Timeline, select all: more selected than Immich keeps on screen; the button still gets them all
  await immich.setViewportSize({ width: 1400, height: 500 });
  await immich.goto(`${PAGE_BASE}/photos`);
  await thumbs.first().waitFor({ timeout: 60000 });
  await thumbs.first().hover();
  await thumbs.first().locator('[role="checkbox"]').click();
  await immich.keyboard.press('Control+a');
  await immich.waitForTimeout(800);
  const count = Number(await immich.locator('[data-testid="control-bar"] nav .text-primary p').first().textContent());
  const onScreen = await immich.locator('[data-thumbnail-focus-container][data-selected="true"]').count();
  const [allPage] = await Promise.all([context.waitForEvent('page'), immich.locator('[data-raw-editor-export]').click()]);
  await allPage.locator('.summary b').first().waitFor({ timeout: 60000 });
  const allHeading = await allPage.locator('h2').first().textContent();
  const warned = await allPage.locator('.warn').count();
  check('select all: every selected photo reaches the export page', count > onScreen && allHeading === `Export ${count} selected photos` && warned === 0, {
    selected: count,
    onScreen,
    heading: allHeading,
    summary: await allPage.locator('.summary').textContent(),
  });
  await allPage.close();
  await immich.close();

  check('no console errors', errors.length === 0, { errors: errors.slice(0, 5) });
} catch (e) {
  check('fatal', false, { error: String(e?.stack ?? e).slice(0, 800) });
} finally {
  if (albumId) await api('DELETE', `/albums/${albumId}`).catch(() => {});
  if (renderId) await api('DELETE', '/assets', { ids: [renderId], force: true }).catch(() => {});
  await browser.close();
  writeFileSync(join(outDir, 'export.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
}
