// Merge to HDR end to end against the test Immich: uploads a bracket, opens a shot of it in the
// editor, merges it from the dialog, and checks what Immich ends up with (the HDR DNG, its stack,
// details and metadata). Screenshots go to <out-dir>.
//
// Usage: node e2e/probe-hdr.mjs <dir>   (writes HDR_0001..3.dng there: a -2 / 0 / +2 EV bracket)
//        node e2e/hdr.mjs <bracket-dir> <out-dir>
// KEEP=1 leaves the photos in Immich afterwards (to look at them); otherwise they are deleted.
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';

const [bracketDir, OUT] = process.argv.slice(2);
if (!bracketDir || !OUT) throw new Error('Usage: node e2e/hdr.mjs <bracket-dir> <out-dir>');
mkdirSync(OUT, { recursive: true });
const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
const LOGIN = { email: 'admin@example.com', password: 'raw-editor-e2e' };
// The bracket as probe-hdr.mjs shoots it: 0 EV first, then -2 and +2, 200 ms apart.
const SHOTS = [
  { name: 'HDR_0001', ms: 0, ev: 0 },
  { name: 'HDR_0002', ms: 200, ev: -2 },
  { name: 'HDR_0003', ms: 400, ev: 2 },
];
const T0 = Date.parse('2015-07-01T10:00:00.000Z');

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: !process.env.HEADED, args: ['--enable-gpu', '--use-angle=d3d11'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const api = ctx.request;
await api.post(`${BASE}/api/auth/login`, { data: LOGIN });
const json = async (res) => {
  if (!res.ok()) throw new Error(`${res.url()}: HTTP ${res.status()} ${await res.text()}`);
  return res.json();
};

let failed = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) failed++;
};
const created = [];
try {
  // 1. The bracket, with an album and a tag on the middle shot (the HDR should get both).
  const ids = [];
  for (const s of SHOTS) {
    const bytes = readFileSync(resolve(bracketDir, `${s.name}.dng`));
    const at = new Date(T0 + s.ms).toISOString();
    const body = await json(
      await api.post(`${BASE}/api/assets`, {
        headers: { 'x-immich-checksum': createHash('sha1').update(bytes).digest('base64') },
        multipart: { assetData: { name: `${s.name}.dng`, mimeType: 'image/x-adobe-dng', buffer: bytes }, fileCreatedAt: at, fileModifiedAt: at, filename: `${s.name}.dng` },
      }),
    );
    ids.push(body.id);
    created.push(body.id);
  }
  const [refId] = ids;
  // Immich reads the EXIF in the background.
  for (let i = 0; i < 60; i++) {
    const infos = await Promise.all(ids.map(async (id) => json(await api.get(`${BASE}/api/assets/${id}`))));
    if (infos.every((a) => a.exifInfo?.exposureTime)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const album = await json(await api.post(`${BASE}/api/albums`, { data: { albumName: `hdr-e2e-${Date.now()}`, assetIds: [refId] } }));
  await api.post(`${BASE}/api/tags`, { data: { name: 'hdr-e2e' } });
  const tag = (await json(await api.get(`${BASE}/api/tags`))).find((t) => t.name === 'hdr-e2e');
  await api.put(`${BASE}/api/tags/${tag.id}/assets`, { data: { ids: [refId] } });
  await api.put(`${BASE}/api/assets/${refId}`, { data: { rating: 4, description: 'Bracket for the HDR test' } });
  console.log(`bracket uploaded: ${ids.join(', ')}`);

  // 2. Open the +2 EV shot (not the reference: the dialog must find the whole bracket from any shot).
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${BASE}/immich-raw/?asset=${ids[2]}&debug`);
  await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
  await page.waitForFunction(() => globalThis.__editor?.status === 'ready', null, { timeout: 120000 });
  await page.getByRole('button', { name: 'Merge to HDR…' }).first().click();
  await page.waitForFunction(() => ['options', 'single'].includes(globalThis.__editor.hdrDialog?.phase), null, { timeout: 60000 });
  const dialog = await page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__editor.hdrDialog)));
  await page.screenshot({ path: resolve(OUT, '1-dialog.png') });
  check(dialog.phase === 'options', `the dialog found a bracket (${dialog.phase}${dialog.searchNote ? `: ${dialog.searchNote}` : ''})`);
  check(dialog.frames.length === 3 && dialog.frames.every((f) => ids.includes(f.id)), `with the three shots: ${dialog.frames.map((f) => `${f.fileName} ${f.ev} EV`).join(', ')}`);

  // 3. Merge: the editor switches to the new HDR when it is done.
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  await page.waitForFunction((ids) => {
    const e = globalThis.__editor;
    return e.hdrDialog?.phase === 'error' || (e.status === 'ready' && e.asset && !ids.includes(e.asset.id));
  }, ids, { timeout: 600000, polling: 500 });
  const state = await page.evaluate(() => {
    const e = globalThis.__editor;
    return { error: e.hdrDialog?.error ?? null, id: e.asset?.id, name: e.asset?.originalFileName, hdr: e.recipe.basic.hdr, basic: e.recipe.basic };
  });
  if (state.error) throw new Error(`merge failed: ${state.error}`);
  created.push(state.id);
  console.log(`merged and opened in ${Math.round((Date.now() - t0) / 1000)} s: ${state.name}, starting with ${JSON.stringify(state.basic)}`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: resolve(OUT, '2-editor.png') });
  check(state.name === 'HDR_0001-HDR.dng', `named after the middle shot (${state.name})`);
  check(state.hdr > 0, `opens with HDR ${state.hdr}`);

  // 4. What Immich has.
  const hdr = await json(await api.get(`${BASE}/api/assets/${state.id}`));
  check(hdr.stack?.primaryAssetId === state.id, 'the HDR is in front of its stack');
  const stack = hdr.stack ? await json(await api.get(`${BASE}/api/stacks/${hdr.stack.id}`)) : { assets: [] };
  const inStack = new Set(stack.assets.map((a) => a.id));
  check(ids.every((id) => inStack.has(id)) && stack.assets.length === 4, `the stack holds the HDR and the bracket (${stack.assets.length})`);
  const meta = await json(await api.get(`${BASE}/api/assets/${state.id}/metadata`));
  const record = meta.find((m) => m.key === 'raw-editor.hdr')?.value;
  check(record?.reference === refId && record.frames?.length === 3, `raw-editor.hdr records the reference and frames (${JSON.stringify(record?.frames?.map((f) => f.ev))})`);
  check(hdr.exifInfo?.rating === 4 && hdr.exifInfo?.description === 'Bracket for the HDR test', `rating and description copied (${hdr.exifInfo?.rating}, "${hdr.exifInfo?.description}")`);
  check((hdr.tags ?? []).some((t) => t.id === tag.id), 'tag copied');
  const albumNow = await json(await api.get(`${BASE}/api/albums/${album.id}`));
  check(albumNow.assets.some((a) => a.id === state.id), 'added to the album');
  check(Date.parse(hdr.fileCreatedAt) === T0, `dated like the middle shot (${hdr.fileCreatedAt})`);

  // 5. Immich's own view of it.
  const viewer = await ctx.newPage();
  await viewer.goto(`${BASE}/photos/${state.id}`);
  await viewer.waitForTimeout(4000);
  await viewer.screenshot({ path: resolve(OUT, '3-immich.png') });
  await viewer.close();
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  if (process.env.KEEP === '1') {
    created.length = 0;
    console.log(`kept: open ${BASE}/photos/${state.id}`);
  } else {
    await api.delete(`${BASE}/api/albums/${album.id}`);
  }
} finally {
  if (created.length) await api.delete(`${BASE}/api/assets`, { data: { ids: created, force: true } });
  await browser.close();
}
process.exit(failed ? 1 : 0);
