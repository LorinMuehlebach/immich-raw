// The scopes above the panels: switching between histogram, waveform, RGB parade and vectorscope,
// each showing the photo, the waveform following an edit, and the choice surviving a reload.
// Usage: node e2e/probe-scopes.mjs <out-dir> [filename-part]   (default: nikon)
//   IMMICH_URL, INSECURE=1 as in smoke.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { API_BASE, PAGE_BASE, browserArgs, expectedConsoleError, loginOnPageOrigin } from './insecure.mjs';

const [outDir, namePart = 'nikon'] = process.argv.slice(2);
if (!outDir) {
  console.error('Usage: node e2e/probe-scopes.mjs <out-dir> [filename-part]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const LOGIN = { email: 'admin@example.com', password: 'raw-editor-e2e' };
const results = [];
const check = (name, ok, details = {}) => {
  results.push({ name, ok, details });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(details)}`);
};

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? 'msedge',
  headless: process.env.HEADED ? false : true,
  args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', ...browserArgs],
});
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await context.request.post(`${API_BASE}/api/auth/login`, { data: LOGIN });
  await loginOnPageOrigin(context, LOGIN);
  const found = await (await context.request.post(`${API_BASE}/api/search/metadata`, { data: { originalFileName: namePart, size: 10 } })).json();
  const raw = found.assets?.items?.find((a) => /\.(arw|nef|cr3|raf|dng)$/i.test(a.originalFileName) && !a.isTrashed);
  if (!raw) throw new Error('seed the instance first: node e2e/seed.mjs <samples>');

  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && !expectedConsoleError(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => r.status() === 404 && errors.push(`404 ${r.url()}`));
  const open = async () => {
    await page.goto(`${PAGE_BASE}/immich-raw/?asset=${raw.id}&debug`);
    await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
    await page.waitForTimeout(1500);
  };
  // Start from the default scope, and the default settings.
  await open();
  await page.evaluate(() => localStorage.removeItem('raw-editor.scope'));
  await open();
  await page.evaluate(() => globalThis.__editor.resetAll());
  await page.waitForTimeout(800);
  check('histogram by default', (await page.evaluate(() => globalThis.__editor.scope)) === 'histogram');

  /** What the current scope holds. */
  const summary = () =>
    page.evaluate(() => {
      const e = globalThis.__editor;
      const d = e.scopeData;
      if (e.scope === 'histogram') return { kind: 'histogram', total: e.histogram?.total ?? 0 };
      if (!d) return { kind: e.scope, data: null };
      const sum = (a) => a.reduce((s, v) => s + v, 0);
      if (d.kind === 'vectorscope') return { kind: d.kind, total: d.total, binSum: sum(d.bins), filled: d.bins.filter((v) => v > 0).length };
      // Mean level (0..1) of each channel, over all columns.
      const mean = d.channels.map((bins) => {
        let s = 0;
        let n = 0;
        for (let i = 0; i < bins.length; i++) {
          const level = Math.floor(i / d.columns);
          s += bins[i] * level;
          n += bins[i];
        }
        return n ? s / n / (d.levels - 1) : 0;
      });
      return { kind: d.kind, total: d.total, channels: d.channels.length, columns: d.columns, levels: d.levels, binSums: d.channels.map(sum), mean };
    });
  const pick = async (label, kind) => {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.waitForFunction((k) => (k === 'histogram' ? globalThis.__editor.histogram : globalThis.__editor.scopeData?.kind === k), kind, { timeout: 5000 });
    await page.waitForTimeout(200);
    await page.locator('.scopes').screenshot({ path: join(outDir, `${kind}.png`) });
    return summary();
  };

  const wave = await pick('Waveform', 'waveform');
  check('waveform: one channel, every pixel counted once per column', wave.kind === 'waveform' && wave.channels === 1 && wave.total > 10000 && wave.binSums[0] === wave.total, wave);

  const parade = await pick('RGB parade', 'parade');
  check('parade: red, green and blue panels', parade.kind === 'parade' && parade.channels === 3 && parade.binSums.every((s) => s === parade.total), parade);

  const vec = await pick('Vectorscope', 'vectorscope');
  check('vectorscope: every pixel in a bin', vec.kind === 'vectorscope' && vec.total > 10000 && vec.binSum === vec.total && vec.filled > 20, vec);
  const square = await page.locator('.scopes canvas').boundingBox();
  check('vectorscope is square', Math.abs(square.width - square.height) < 1, square);

  // The waveform follows an edit: more exposure, higher levels.
  await pick('Waveform', 'waveform');
  const before = (await summary()).mean[0];
  const exposure = page.locator('input[aria-label="Exposure"]').first();
  await exposure.fill('1.5');
  await exposure.press('Enter');
  await page.waitForFunction((m) => {
    const d = globalThis.__editor.scopeData;
    if (d?.kind !== 'waveform') return false;
    let s = 0;
    let n = 0;
    for (let i = 0; i < d.channels[0].length; i++) {
      s += d.channels[0][i] * Math.floor(i / d.columns);
      n += d.channels[0][i];
    }
    return s / n / (d.levels - 1) > m + 0.05;
  }, before, { timeout: 10000 }).catch(() => {});
  const after = (await summary()).mean[0];
  check('waveform rises with exposure', after > before + 0.05, { before, after });
  await page.screenshot({ path: join(outDir, 'waveform-page.png') });

  // The choice is kept in the browser.
  await page.getByRole('button', { name: 'Vectorscope', exact: true }).click();
  await open();
  await page.waitForFunction(() => globalThis.__editor.scopeData?.kind === 'vectorscope', null, { timeout: 10000 }).catch(() => {});
  const kept = await summary();
  check('the scope survives a reload', kept.kind === 'vectorscope' && kept.total > 0, kept);

  const hist = await pick('Histogram', 'histogram');
  check('back to the histogram, with its clipping triangles', hist.total > 0 && (await page.locator('.scopes .tri').count()) === 2, hist);
  await page.evaluate(() => globalThis.__editor.resetAll());
  check('no console errors', errors.length === 0, { errors: errors.slice(0, 5) });
} finally {
  await browser.close();
  writeFileSync(join(outDir, 'probe-scopes.json'), JSON.stringify(results, null, 2));
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
