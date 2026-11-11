// Generic runner: opens <page>.html in headless Edge, waits for window.__done and saves
// window.__results to <out-dir>/<page>.json.
// Usage: node run-page.mjs <page> <samples-dir> <out-dir> [query-string]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const [pageName, samplesDir, outDir, query = ''] = process.argv.slice(2);
if (!pageName || !samplesDir || !outDir) {
  console.error('Usage: node run-page.mjs <page> <samples-dir> <out-dir> [query-string]');
  process.exit(1);
}
process.env.SAMPLES_DIR = samplesDir;
mkdirSync(outDir, { recursive: true });

const root = dirname(fileURLToPath(import.meta.url));
const server = await createServer({ root, configFile: join(root, 'vite.config.mjs'), logLevel: 'warn' });
await server.listen(5199);
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? 'msedge',
  headless: true,
  args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log(`[page] ${m.text()}`));
  page.on('pageerror', (e) => console.error(`[pageerror] ${e.message}`));
  await page.goto(`http://localhost:5199/${pageName}.html${query ? `?${query}` : ''}`);
  await page.waitForFunction(() => window.__done === true, null, { timeout: 15 * 60 * 1000, polling: 500 });
  const results = await page.evaluate(() => window.__results);
  writeFileSync(join(outDir, `${pageName}.json`), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  await server.close();
}
