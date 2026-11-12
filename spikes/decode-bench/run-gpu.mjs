// Runs the WebGL2 proxy spike in Edge and saves results + a screenshot.
// Usage: node run-gpu.mjs <samples-dir> <out-dir> [file] [--headed]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const [samplesDir, outDir, file = 'sony-a7rv.ARW'] = args.filter((a) => !a.startsWith('--'));
process.env.SAMPLES_DIR = samplesDir;
mkdirSync(outDir, { recursive: true });

const root = dirname(fileURLToPath(import.meta.url));
const server = await createServer({ root, configFile: join(root, 'vite.config.mjs'), logLevel: 'warn' });
await server.listen(5199);

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? 'msedge',
  headless: !headed,
  // Ask for the real GPU in headless mode instead of the software fallback.
  args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('console', (m) => console.log(`[page] ${m.text()}`));
  await page.goto(`http://localhost:5199/gpu.html?file=${encodeURIComponent(file)}`);
  await page.waitForFunction(() => window.__done === true, null, { timeout: 5 * 60 * 1000, polling: 500 });
  const results = await page.evaluate(() => window.__gpuResults);
  if (results.screenshot) {
    writeFileSync(join(outDir, `${file}.gpu.jpg`), Buffer.from(results.screenshot.split(',')[1], 'base64'));
    results.screenshot = `${file}.gpu.jpg`;
  }
  writeFileSync(join(outDir, `${file}.gpu.json`), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  await server.close();
}
