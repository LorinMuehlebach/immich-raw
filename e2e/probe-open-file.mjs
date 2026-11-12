// Uploads one file to the test Immich, opens it in the editor, reports status, as-shot white
// balance and camera matrix, then deletes it again. Usage: node e2e/probe-open-file.mjs <file> [shot.png]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.IMMICH_URL ?? 'http://127.0.0.1:8088';
const [file, shotPath] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-gpu', '--use-angle=d3d11'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: 'admin@example.com', password: 'raw-editor-e2e' } });
const bytes = readFileSync(file);
const name = `probe-${basename(file)}`;
const up = await ctx.request.post(`${BASE}/api/assets`, {
  headers: { 'x-immich-checksum': createHash('sha1').update(bytes).digest('base64') },
  multipart: {
    assetData: { name, mimeType: 'application/octet-stream', buffer: bytes },
    fileCreatedAt: '2001-01-01T12:00:00.000Z',
    fileModifiedAt: '2001-01-01T12:00:00.000Z',
    filename: name,
  },
});
const { id } = await up.json();
const result = { id };
try {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/immich-raw/?asset=${id}&debug`);
  await page.waitForFunction(() => ['ready', 'error'].includes(globalThis.__editor?.status) || !!globalThis.__editor?.error, null, { timeout: 120000 });
  await page.waitForTimeout(1500);
  Object.assign(
    result,
    await page.evaluate(() => {
      const e = globalThis.__editor;
      return { status: e.status, error: e.error, camera: e.camera && { asShot: e.camera.asShot, camXyz: e.camera.camXyz } };
    }),
    { errors },
  );
  if (shotPath) await page.screenshot({ path: shotPath });
} finally {
  await ctx.request.delete(`${BASE}/api/assets`, { data: { ids: [id], force: true } });
  await browser.close();
}
console.log(JSON.stringify(result, null, 1));
