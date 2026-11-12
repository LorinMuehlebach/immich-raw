// How long the editor takes to open a RAW until it can be edited: from navigating to the editor
// until the photo shows, once with the original downloaded and once from the browser's cache.
// Also collects the editor's own immich-raw:* timings of each step.
// Usage: node e2e/probe-open-speed.mjs <out-dir> [file-parts]   (default: sony,canon,fuji)
//   IMMICH_URLS=http://127.0.0.1:8088,http://127.0.0.1:8087  compare editors served at several
//              addresses of the same test Immich; the runs alternate between them
//   REPS=3     opens per file, address and cache state (the median is reported)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const [outDir, parts = 'sony,canon,fuji'] = process.argv.slice(2);
if (!outDir) {
  console.error('Usage: node e2e/probe-open-speed.mjs <out-dir> [file-parts]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const bases = (process.env.IMMICH_URLS ?? process.env.IMMICH_URL ?? 'http://127.0.0.1:8088').split(',');
const reps = Number(process.env.REPS ?? 3);
const LOGIN = { email: 'admin@example.com', password: 'raw-editor-e2e' };
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? 'msedge',
  headless: !process.env.HEADED,
  args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
});
const runs = [];
try {
  // Cookies don't depend on the port: one login serves every address on 127.0.0.1.
  const setup = await browser.newContext();
  const login = await setup.request.post(`${bases[0]}/api/auth/login`, { data: LOGIN });
  if (!login.ok()) throw new Error(`login failed: HTTP ${login.status()}`);
  const assets = [];
  for (const part of parts.split(',')) {
    const r = await setup.request.post(`${bases[0]}/api/search/metadata`, { data: { originalFileName: part, size: 10 } });
    const found = (await r.json()).assets?.items?.find((a) => /\.(arw|nef|cr3|raf|dng)$/i.test(a.originalFileName));
    if (found) assets.push(found);
    else console.warn(`no RAW matching "${part}"`);
  }
  await setup.close();

  for (let rep = 0; rep < reps; rep++) {
    for (const asset of assets) {
      for (const base of bases) {
        // A fresh context has an empty cache: the first open downloads, the second reads the cache.
        const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
        await context.request.post(`${base}/api/auth/login`, { data: LOGIN });
        const page = await context.newPage();
        for (const cache of ['download', 'cached']) {
          const t0 = Date.now();
          await page.goto(`${base}/immich-raw/?asset=${asset.id}`);
          await page.locator('.frame:not(.hidden) canvas').waitFor({ timeout: 120000 });
          const ms = Date.now() - t0;
          const steps = await page.evaluate(() =>
            Object.fromEntries(
              performance
                .getEntriesByType('measure')
                .filter((m) => m.name.startsWith('immich-raw:'))
                .map((m) => [m.name.slice('immich-raw:'.length), Math.round(m.duration)]),
            ),
          );
          runs.push({ file: asset.originalFileName, base, cache, rep, ms, steps });
          console.log(`${asset.originalFileName} ${base} ${cache}: ${ms} ms ${JSON.stringify(steps)}`);
          // Leave the page so the background full decode stops before the next open.
          await page.goto('about:blank');
          await page.waitForTimeout(1500);
        }
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  writeFileSync(join(outDir, 'open-speed.json'), JSON.stringify(runs, null, 2));
}

const rows = [];
for (const file of [...new Set(runs.map((r) => r.file))]) {
  for (const cache of ['download', 'cached']) {
    const row = { file, cache };
    for (const base of bases) {
      const xs = runs.filter((r) => r.file === file && r.cache === cache && r.base === base).map((r) => r.ms);
      row[base] = xs.length ? median(xs) : '-';
    }
    rows.push(row);
  }
}
console.log('\nMedian ms until the photo shows:');
console.table(rows);
