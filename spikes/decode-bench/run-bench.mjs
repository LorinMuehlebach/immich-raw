// Runs the decode bench page in headless Microsoft Edge and writes results + previews.
// Usage: node run-bench.mjs <samples-dir> <out-dir> [only]
//   Q=0,2      full decodes at these userQual levels instead of DHT and AHD (Q= : half only)
//   WARM=1     also a half decode on a worker started early (no WebAssembly start-up)
//   TILES=2,4  also decodes split into that many stripes on as many workers at once, checked
//              row by row against a whole decode (needs much more memory)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const [samplesDir, outDir, only] = process.argv.slice(2);
if (!samplesDir || !outDir) {
  console.error('Usage: node run-bench.mjs <samples-dir> <out-dir> [only]');
  process.exit(1);
}
process.env.SAMPLES_DIR = samplesDir;
mkdirSync(outDir, { recursive: true });

const root = dirname(fileURLToPath(import.meta.url));
const server = await createServer({ root, configFile: join(root, 'vite.config.mjs'), logLevel: 'warn' });
await server.listen(5199);
const query = new URLSearchParams();
if (only) query.set('only', only);
if (process.env.Q !== undefined) query.set('q', process.env.Q); // e.g. Q=0,2 to compare demosaic levels
if (process.env.WARM) query.set('warm', '1');
if (process.env.TILES) query.set('tiles', process.env.TILES);
const url = `http://localhost:5199/?${query}`;

// Memory sampler (Windows): private bytes of all msedge.exe processes started after this point.
// The decoder's shared WASM heap lives in a worker inside the renderer, which the page itself
// can't measure reliably.
const startedAt = new Date();
const memory = { current: 0, peaks: {} };
let activeMark = 'startup';
const sampler = process.platform === 'win32' ? startSampler(startedAt) : null;
function startSampler(since) {
  const iso = since.toISOString();
  const script = `
    $since = [datetime]::Parse('${iso}').ToUniversalTime()
    while ($true) {
      $sum = (Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
        Where-Object { $_.CreationDate.ToUniversalTime() -gt $since } |
        Measure-Object -Property PrivatePageCount -Sum).Sum
      [Console]::Out.WriteLine([string]$sum)
      Start-Sleep -Milliseconds 250
    }`;
  const p = spawn('powershell.exe', ['-NoProfile', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (chunk) => {
    for (const line of chunk.split(/\r?\n/)) {
      const mb = Math.round(Number(line) / 1e6);
      if (!Number.isFinite(mb) || mb <= 0) continue;
      memory.current = mb;
      memory.peaks[activeMark] = Math.max(memory.peaks[activeMark] ?? 0, mb);
    }
  });
  return p;
}

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true });
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    const text = m.text();
    if (text.startsWith('MARK ')) {
      activeMark = text.slice(5);
      return;
    }
    console.log(`[page] ${text}`);
  });
  page.on('pageerror', (e) => console.error(`[pageerror] ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => window.__done === true, null, { timeout: 30 * 60 * 1000, polling: 1000 });
  const results = await page.evaluate(() => window.__results);

  for (const r of Array.isArray(results) ? results : []) {
    for (const run of r.runs ?? []) {
      run.peakBrowserMB = memory.peaks[`${r.file}|${run.config}`] ?? null;
      run.afterDisposeBrowserMB = memory.peaks[`${r.file}|${run.config}|disposed`] ?? null;
    }
    if (r.previewPng) {
      const b64 = r.previewPng.split(',')[1];
      writeFileSync(join(outDir, `${r.file}.preview.png`), Buffer.from(b64, 'base64'));
      r.previewPng = `${r.file}.preview.png`;
    }
  }
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\nWrote ${join(outDir, 'results.json')}`);
  printSummary(Array.isArray(results) ? results : []);
} finally {
  sampler?.kill();
  await browser.close();
  await server.close();
}

function printSummary(results) {
  const rows = [];
  for (const r of results) {
    for (const run of r.runs) {
      rows.push({
        file: r.file,
        config: run.config,
        mp: run.output?.megapixels ?? '-',
        decodeMs: run.error ? 'ERROR' : (run.totalMs ?? run.wallMs),
        openMs: run.openMs ?? run.stripes?.map((s) => s.openMs).join('/') ?? '-',
        imageDataMs: run.imageDataMs ?? run.stripes?.map((s) => s.imageDataMs).join('/') ?? '-',
        identical: run.identical ?? '-',
        peakMB: run.peakBrowserMB ?? '-',
        afterMB: run.afterDisposeBrowserMB ?? '-',
        max: run.stats?.max.join('/') ?? run.error ?? '-',
      });
    }
    if (r.expectedClip) rows.push({ file: r.file, config: 'expected clip', max: r.expectedClip.join('/') });
  }
  console.table(rows);
}
