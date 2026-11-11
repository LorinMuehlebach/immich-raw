// Convert to DNG end to end. Builds the DNG for each asset and reports size and check.
// Usage: node e2e/probe-dng.mjs <lossless|lossy> <asset-id | copy:<raw file>>...
//   copy:<file> uploads a copy of the file (one extra byte, so Immich sees a new asset) and
//   uses that; with REPLACE=1 such copies are then replaced by their DNG for real.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';

const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
const [mode, ...targets] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-gpu', '--use-angle=d3d11'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'admin@example.com', password: 'raw-editor-e2e' } });

async function uploadCopy(path) {
  const bytes = Buffer.concat([readFileSync(path), Buffer.from([0])]);
  const name = basename(path).replace(/(\.[^.]+)$/, '-copy$1');
  const res = await ctx.request.post(`${BASE}/api/assets`, {
    headers: { 'x-immich-checksum': createHash('sha1').update(bytes).digest('base64') },
    multipart: {
      assetData: { name, mimeType: 'application/octet-stream', buffer: bytes },
      fileCreatedAt: new Date('2024-05-01T10:00:00Z').toISOString(),
      fileModifiedAt: new Date('2024-05-01T10:00:00Z').toISOString(),
      filename: name,
    },
  });
  const body = await res.json();
  if (!body.id) throw new Error(`upload failed: ${JSON.stringify(body)}`);
  // Give Immich a moment to read the metadata.
  await new Promise((r) => setTimeout(r, 4000));
  // Things the DNG must take over: album, tag, rating, description, favourite.
  const album = await (await ctx.request.post(`${BASE}/api/albums`, { data: { albumName: `dng-probe-${Date.now()}`, assetIds: [body.id] } })).json();
  await ctx.request.post(`${BASE}/api/tags`, { data: { name: 'dng-probe' } });
  const tag = (await (await ctx.request.get(`${BASE}/api/tags`)).json()).find((t) => t.name === 'dng-probe');
  await ctx.request.put(`${BASE}/api/tags/${tag.id}/assets`, { data: { ids: [body.id] } });
  await ctx.request.put(`${BASE}/api/assets/${body.id}`, { data: { rating: 4, description: 'Converted by the probe', isFavorite: true } });
  extras[body.id] = { albumId: album.id, tagId: tag.id };
  return body.id;
}

const results = [];
const extras = {};
for (const target of targets) {
  const isCopy = target.startsWith('copy:');
  const id = isCopy ? await uploadCopy(target.slice(5)) : target;
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${BASE}/immich-raw/?asset=${id}&debug`);
  await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
  if (isCopy && process.env.EDIT === '1') {
    // Edit and save first, so there is a render stacked on top and a recipe to carry over.
    const saved = await page.evaluate(async () => {
      const e = globalThis.__editor;
      e.setParam({ path: 'basic.exposure', label: 'Exposure', min: -5, max: 5, default: 0, step: 0.01, decimals: 2 }, 0.7, true);
      return e.save();
    });
    if (!saved) throw new Error('save failed: ' + (await page.evaluate(() => globalThis.__editor.error)));
  }
  const renderId = await page.evaluate(() => globalThis.__editor.recipe.render?.assetId ?? null);
  const t0 = Date.now();
  await page.evaluate((mode) => {
    const e = globalThis.__editor;
    e.openDngDialog();
    e.setDngOptions({ mode });
    void e.createDng();
  }, mode);
  await page.waitForFunction(() => ['ready', 'error'].includes(globalThis.__editor.dngDialog?.phase), null, { timeout: 600000, polling: 500 });
  const built = await page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__editor.dngDialog)));
  const r = { id, name: await page.evaluate(() => globalThis.__editor.asset.originalFileName), seconds: Math.round((Date.now() - t0) / 1000), ...built };
  if (isCopy && process.env.REPLACE === '1' && built.phase === 'ready' && built.verification?.ok) {
    await page.screenshot({ path: `${process.env.SHOT_DIR ?? '.'}/dng-dialog.png` }).catch(() => {});
    await page.evaluate(() => globalThis.__editor.setDngOptions({ deleteMode: 'permanent' }));
    await page.evaluate(() => void globalThis.__editor.replaceWithDng());
    await page.waitForURL((u) => !u.toString().includes(id), { timeout: 300000 });
    // The editor reopens on the DNG (without ?debug): open it again with it.
    await page.goto(`${page.url()}&debug`);
    await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
    const now = await page.evaluate(() => ({ id: globalThis.__editor.asset.id, name: globalThis.__editor.asset.originalFileName, status: globalThis.__editor.status, error: globalThis.__editor.error }));
    const info = await (await ctx.request.get(`${BASE}/api/assets/${now.id}`)).json();
    const meta = await (await ctx.request.get(`${BASE}/api/assets/${now.id}/metadata`)).json();
    const old = await ctx.request.get(`${BASE}/api/assets/${id}`);
    await new Promise((res) => setTimeout(res, 8000));
    const thumb = await ctx.request.get(`${BASE}/api/assets/${now.id}/thumbnail?size=preview`);
    const render = renderId ? await (await ctx.request.get(`${BASE}/api/assets/${renderId}`)).json() : null;
    const renderMeta = renderId ? await (await ctx.request.get(`${BASE}/api/assets/${renderId}/metadata`)).json() : [];
    r.replaced = {
      ...now,
      exposure: await page.evaluate(() => globalThis.__editor.recipe.basic.exposure),
      dirty: await page.evaluate(() => globalThis.__editor.dirty),
      stack: info.stack && { primary: info.stack.primaryAssetId === renderId ? 'render' : info.stack.primaryAssetId === now.id ? 'dng' : info.stack.primaryAssetId, count: info.stack.assetCount },
      renderSource: renderMeta.find((m) => m.key === 'raw-editor.render')?.value?.sourceAssetId === now.id ? 'dng' : renderMeta.find((m) => m.key === 'raw-editor.render')?.value?.sourceAssetId,
      renderStack: render?.stack?.id === info.stack?.id,
      oldStatus: old.status(),
      exif: info.exifInfo && { make: info.exifInfo.make, model: info.exifInfo.model, lens: info.exifInfo.lensModel, date: info.exifInfo.dateTimeOriginal, size: info.exifInfo.fileSizeInByte, w: info.exifInfo.exifImageWidth, h: info.exifInfo.exifImageHeight },
      metadataKeys: meta.map((m) => m.key),
      rating: info.exifInfo?.rating,
      description: info.exifInfo?.description,
      favorite: info.isFavorite,
      tags: (info.tags ?? []).map((t) => t.name),
      inAlbum: (await (await ctx.request.get(`${BASE}/api/albums?assetId=${now.id}`)).json()).some((a) => a.id === extras[id]?.albumId),
      thumbnail: [thumb.status(), (await thumb.body()).length],
    };
  }
  results.push({ ...r, errors });
  await page.close();
}
console.log(JSON.stringify(results, null, 1));
await browser.close();
