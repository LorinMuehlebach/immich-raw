// End-to-end smoke test against the test Immich (e2e/docker-compose.immich.yml, seeded).
// Opens a RAW from Immich's viewer via the "Edit RAW" button, edits, saves, exports, reopens, re-saves.
// Usage: node e2e/smoke.mjs <out-dir> [filename-part]   (default: sony)
//   INSECURE=1  open the pages from a plain-HTTP origin that isn't a secure context (insecure.mjs)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { API_BASE, INSECURE, PAGE_BASE, browserArgs, expectedConsoleError, loginOnPageOrigin } from './insecure.mjs';

const [outDir, namePart = 'sony'] = process.argv.slice(2);
if (!outDir) {
  console.error('Usage: node e2e/smoke.mjs <out-dir> [filename-part]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const LOGIN = { email: 'admin@example.com', password: 'raw-editor-e2e' };
const results = [];
const check = (name, ok, details = {}) => {
  results.push({ name, ok, details });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(details)}`);
};

/** Pixel size from a JPEG's SOF marker, or null. */
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? 'msedge',
  headless: process.env.HEADED ? false : true,
  args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', ...browserArgs],
});
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const login = await context.request.post(`${API_BASE}/api/auth/login`, { data: LOGIN });
  check('login', login.ok());
  if (INSECURE) {
    const secure = await loginOnPageOrigin(context, LOGIN);
    check('pages are not a secure context', secure === false, { origin: PAGE_BASE, isSecureContext: secure });
  }
  const api = async (method, path, data) => {
    const r = await context.request.fetch(`${API_BASE}/api${path}`, { method, data });
    return { status: r.status(), body: r.status() === 204 ? null : await r.json().catch(() => null) };
  };

  // The test server's "new version available" popup would cover the viewer: turn the check off.
  const config = await api('GET', '/system-config');
  if (config.body?.newVersionCheck?.enabled) {
    await api('PUT', '/system-config', { ...config.body, newVersionCheck: { ...config.body.newVersionCheck, enabled: false } });
  }

  const found = await api('POST', '/search/metadata', { originalFileName: namePart, size: 10 });
  const raw = found.body?.assets?.items?.find((a) => /\.(arw|nef|cr3|raf|dng)$/i.test(a.originalFileName));
  check('find seeded RAW', !!raw, { file: raw?.originalFileName });
  if (!raw) throw new Error('seed the instance first: node e2e/seed.mjs <samples>');

  // Clean slate: remove earlier renders, the stack and the stored recipe.
  const before = await api('GET', `/assets/${raw.id}`);
  if (before.body?.stack?.id) {
    const stack = await api('GET', `/stacks/${before.body.stack.id}`);
    const others = (stack.body?.assets ?? []).map((a) => a.id).filter((id) => id !== raw.id);
    await api('DELETE', `/stacks/${before.body.stack.id}`);
    if (others.length) await api('DELETE', '/assets', { ids: others, force: true });
  }
  await api('DELETE', `/assets/${raw.id}/metadata/raw-editor.recipe`);

  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !expectedConsoleError(m.text())) errors.push(m.text());
    if (process.env.VERBOSE) console.log(`[page] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  // 1. Immich viewer -> Edit RAW
  await page.goto(`${PAGE_BASE}/photos/${raw.id}`);
  const button = page.locator('[data-raw-editor-button]');
  await button.waitFor({ timeout: 45000 });
  // Close any popup Immich shows on first load (it remembers a version notice it already fetched).
  await page.waitForTimeout(800);
  if (await page.locator('[data-dialog-overlay][data-state="open"]').count()) await page.keyboard.press('Escape');
  await button.click();
  await page.waitForURL(/\/immich-raw\/\?asset=/, { timeout: 15000 });
  const t0 = Date.now();
  await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
  check('editor opens and renders', true, { seconds: (Date.now() - t0) / 1000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(outDir, '1-opened.png') });

  // 2. Edit
  await page.locator('input[aria-label="Exposure"]').fill('0.5');
  await page.locator('input[aria-label="Shadows"]').fill('40');
  await page.locator('input[aria-label="Highlights"]').fill('-50');
  await page.locator('input[aria-label="Vibrance"]').fill('25');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outDir, '2-edited.png') });
  const dirty = await page.locator('.sub', { hasText: 'unsaved changes' }).count();
  check('edits mark the photo unsaved', dirty > 0);

  // 3. Crop tool opens and closes
  await page.keyboard.press('r');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outDir, '3-crop.png') });
  await page.keyboard.press('Enter');

  // 4. Save
  const tSave = Date.now();
  await page.getByRole('button', { name: /^Save/ }).click();
  await page.locator('.toast', { hasText: 'Saved to Immich' }).waitFor({ timeout: 240000 });
  check('save completes', true, { seconds: (Date.now() - tSave) / 1000 });
  const meta1 = await api('GET', `/assets/${raw.id}/metadata/raw-editor.recipe`);
  const render1 = meta1.body?.value?.render?.assetId;
  const rawInfo = await api('GET', `/assets/${raw.id}`);
  check('recipe stored on the RAW with render id', !!render1 && meta1.body?.value?.basic?.exposure === 0.5, { render1 });
  check('render is stack primary', rawInfo.body?.stack?.primaryAssetId === render1, { stack: rawInfo.body?.stack });
  const renderInfo = await api('GET', `/assets/${render1}`);
  check('render has date and camera EXIF', !!renderInfo.body?.exifInfo?.make && !!renderInfo.body?.fileCreatedAt, {
    make: renderInfo.body?.exifInfo?.make,
    size: `${renderInfo.body?.exifInfo?.exifImageWidth}x${renderInfo.body?.exifInfo?.exifImageHeight}`,
    created: renderInfo.body?.fileCreatedAt,
  });
  const thumb = await context.request.get(`${API_BASE}/api/assets/${render1}/thumbnail?size=preview`);
  if (thumb.ok()) writeFileSync(join(outDir, '4-render-preview.jpg'), await thumb.body());
  // A fresh browser has the default export settings: Save uploads the Medium preset.
  const renderFile = await context.request.get(`${API_BASE}/api/assets/${render1}/original`);
  const renderSize = renderFile.ok() ? jpegSize(await renderFile.body()) : null;
  check('render is the Medium preset (long edge at most 3840 px)', !!renderSize && Math.max(renderSize.width, renderSize.height) <= 3840, { renderSize });

  // 4b. Export Low: downloads a 2048 px JPEG
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 240000 }),
    page.getByRole('button', { name: 'Low', exact: true }).click(),
  ]);
  const exportPath = join(outDir, download.suggestedFilename());
  await download.saveAs(exportPath);
  const exportSize = jpegSize(readFileSync(exportPath));
  const expectedName = raw.originalFileName.replace(/\.[^.]+$/, '.jpg');
  check('export Low downloads a 2048 px JPEG', download.suggestedFilename() === expectedName && !!exportSize && Math.max(exportSize.width, exportSize.height) === 2048, {
    file: download.suggestedFilename(),
    exportSize,
  });

  // 5. Reopen: settings restored
  await page.goto(`${PAGE_BASE}/immich-raw/?asset=${raw.id}&return=${encodeURIComponent(`/photos/${raw.id}`)}`);
  await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
  const exposureText = await page.locator('.row', { has: page.locator('input[aria-label="Exposure"]') }).locator('.value').textContent();
  check('reopen restores settings', exposureText?.trim() === '+0.50', { exposureText });

  // 6. Re-save replaces the previous render
  await page.locator('input[aria-label="Contrast"]').fill('20');
  await page.getByRole('button', { name: /^Save/ }).click();
  await page.locator('.toast', { hasText: 'Saved to Immich' }).waitFor({ timeout: 240000 });
  const meta2 = await api('GET', `/assets/${raw.id}/metadata/raw-editor.recipe`);
  const render2 = meta2.body?.value?.render?.assetId;
  const old = await api('GET', `/assets/${render1}`);
  const rawInfo2 = await api('GET', `/assets/${raw.id}`);
  check('re-save: new render on top, old one in trash', render2 && render2 !== render1 && old.body?.isTrashed === true && rawInfo2.body?.stack?.primaryAssetId === render2, {
    render2,
    oldTrashed: old.body?.isTrashed,
  });
  await page.screenshot({ path: join(outDir, '5-resaved.png') });
  check('no console errors', errors.length === 0, { errors: errors.slice(0, 5) });
} catch (e) {
  check('fatal', false, { error: String(e?.stack ?? e).slice(0, 800) });
} finally {
  await browser.close();
  writeFileSync(join(outDir, 'smoke.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
}
