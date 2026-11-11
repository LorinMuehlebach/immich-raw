// Times the batch export with 1 to 16 photos at once, through the export page that Immich's
// selection button opens, against the test Immich (e2e/README.md, seeded). Samples the private
// memory of the browser (Windows, every 250 ms, Edge processes started by this script) and stops a
// run when Windows has less than MIN_FREE_GB (default 2) of commit left, before other programs fail.
//
// Usage: node e2e/bench-export.mjs <out-dir> [set] [levels] [preset]
//   set:    mixed (default: the 8 sample RAWs, 40-61 MP from 5 cameras) or xt30 (16 X-T30 RAFs, 26 MP)
//   levels: photos at once, e.g. 1,2,4,8,16 (the default)
//   preset: low, medium or high (default: high, full-size JPEG)
// INSECURE=1 runs it over plain HTTP from a non-secure page (no RAW cache, no memory figure).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { API_BASE, INSECURE, PAGE_BASE, browserArgs, loginOnPageOrigin } from './insecure.mjs';

const [outDir, set = 'mixed', levelArg = '1,2,4,8,16', preset = 'high'] = process.argv.slice(2);
if (!outDir) {
  console.error('Usage: node e2e/bench-export.mjs <out-dir> [mixed|xt30] [levels] [preset]');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const LEVELS = levelArg.split(',').map(Number);
const LOGIN = { email: 'admin@example.com', password: 'raw-editor-e2e' };
const RAW = /\.(arw|nef|cr2|cr3|raf|rw2|orf|dng)$/i;
const SETS = {
  mixed: (a) => /^(sony-a7rv|fuji-xt5|canon-lr|canon-r5|leica-q2|nikon-z7|nikon-z7-copy)\./i.test(a.originalFileName),
  xt30: (a) => /^DSCF\d+\.RAF$/i.test(a.originalFileName),
};
const LIMIT = { mixed: 8, xt30: 16 };
const MIN_FREE_GB = Number(process.env.MIN_FREE_GB ?? 2);

// Memory sampler, as in spikes/decode-bench/run-bench.mjs.
const startedAt = new Date();
const memory = { peaks: {}, lowestFreeGb: {}, lowestRamGb: {} };
let mark = 'startup';
/** Called when Windows runs low on memory. */
let onLowMemory = () => {};
const sampler = process.platform === 'win32' ? startSampler(startedAt) : null;
function startSampler(since) {
  // Headroom = the most Windows can commit (RAM + the page file at its maximum size; it grows on
  // demand) minus what is committed. A system-managed page file can grow to 3x RAM.
  const script = `
    $since = [datetime]::Parse('${since.toISOString()}').ToUniversalTime()
    $ramKb = (Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize
    $managed = (Get-CimInstance Win32_ComputerSystem).AutomaticManagedPagefile
    $pageMaxMb = (Get-CimInstance Win32_PageFileSetting | Measure-Object -Property MaximumSize -Sum).Sum
    $limitKb = if ($managed -or -not $pageMaxMb) { $ramKb * 4 } else { $ramKb + $pageMaxMb * 1024 }
    while ($true) {
      $sum = (Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
        Where-Object { $_.CreationDate.ToUniversalTime() -gt $since } |
        Measure-Object -Property PrivatePageCount -Sum).Sum
      $os = Get-CimInstance Win32_OperatingSystem
      $headroom = $limitKb - ($os.TotalVirtualMemorySize - $os.FreeVirtualMemory)
      [Console]::Out.WriteLine("$sum $headroom $($os.FreePhysicalMemory)")
      Start-Sleep -Milliseconds 250
    }`;
  const p = spawn('powershell.exe', ['-NoProfile', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  p.stdout.setEncoding('utf8');
  // A chunk can end mid-line: keep the unfinished line for the next one.
  let rest = '';
  p.stdout.on('data', (chunk) => {
    const lines = (rest + chunk).split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) {
      const [sum, headroomKb, ramKb] = line.trim().split(' ').map(Number);
      const mb = Math.round(sum / 1e6);
      if (Number.isFinite(mb) && mb > 0) memory.peaks[mark] = Math.max(memory.peaks[mark] ?? 0, mb);
      // Free RAM: below a few GB Windows pages to disk and the timings suffer.
      if (Number.isFinite(ramKb) && ramKb > 0) memory.lowestRamGb[mark] = Math.min(memory.lowestRamGb[mark] ?? Infinity, Math.round((ramKb / 2 ** 20) * 10) / 10);
      // Commit headroom: allocations fail when it runs out.
      const freeGb = headroomKb / 2 ** 20;
      if (!Number.isFinite(freeGb) || freeGb <= 0) continue;
      memory.lowestFreeGb[mark] = Math.min(memory.lowestFreeGb[mark] ?? Infinity, Math.round(freeGb * 10) / 10);
      if (freeGb < MIN_FREE_GB) onLowMemory();
    }
  });
  return p;
}

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? 'msedge',
  headless: true,
  args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', ...browserArgs],
});
const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
// The folder picker can't be scripted: export into a ZIP.
await context.addInitScript(() => {
  delete window.showDirectoryPicker;
  window.showDirectoryPicker = undefined;
});
const results = { set, preset, insecure: INSECURE, machine: { cpu: cpus()[0]?.model.trim(), threads: cpus().length, ramGb: Math.round(totalmem() / 2 ** 30) }, runs: [] };

/** Opens the export page for `ids`, exports with `level` at once, returns seconds and the page's summary. */
async function exportOnce(ids, level, presetId) {
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  page.on('crash', () => errors.push('page crashed'));
  try {
    const key = `bench${level}${Date.now()}`;
    await page.addInitScript(
      ([k, h]) => {
        if (!sessionStorage.getItem(k)) localStorage.setItem(k, h);
      },
      [`immich-raw.export.${key}`, JSON.stringify({ ids, context: 'timeline', expected: ids.length, returnPath: '/', createdAt: Date.now() })],
    );
    await page.goto(`${PAGE_BASE}/immich-raw/?export=${key}`);
    await page.locator('.summary b').first().waitFor({ timeout: 120000 });
    await page.locator('select[aria-label="Preset"]').selectOption(presetId);
    await page.locator('select[aria-label="Photos at once"]').selectOption(String(level));
    const env = await page.evaluate(() => ({ secure: isSecureContext, isolated: crossOriginIsolated, cores: navigator.hardwareConcurrency, memoryGb: navigator.deviceMemory ?? null }));
    const t0 = Date.now();
    // Done when the ZIP arrives, or when the result shows without one (every photo failed), or
    // stopped when Windows runs low on memory.
    const download = page.waitForEvent('download', { timeout: 3600000 });
    download.catch(() => {});
    const low = new Promise((resolve) => (onLowMemory = () => resolve('low')));
    await page.getByRole('button', { name: 'Export as ZIP' }).click();
    const finished = await Promise.race([page.locator('.dialog .result').waitFor({ timeout: 3600000 }).then(() => 'done'), low]);
    onLowMemory = () => {};
    if (finished === 'low') return { seconds: (Date.now() - t0) / 1000, stopped: `Windows had less than ${MIN_FREE_GB} GB of memory left`, env, errors: errors.slice(0, 5) };
    const seconds = (Date.now() - t0) / 1000;
    const result = (await page.locator('.dialog .result').textContent())?.replace(/\s+/g, ' ').trim();
    const zip = await Promise.race([download.then((d) => d.path()), new Promise((r) => setTimeout(() => r(null), 5000))]);
    return { seconds, result, env, zip: !!zip, errors: errors.slice(0, 5) };
  } finally {
    await page.close();
  }
}

try {
  const login = await context.request.post(`${API_BASE}/api/auth/login`, { data: LOGIN });
  if (!login.ok()) throw new Error(`login failed: HTTP ${login.status()}`);
  if (INSECURE) await loginOnPageOrigin(context, LOGIN);
  const found = await (await context.request.post(`${API_BASE}/api/search/metadata`, { data: { size: 500, type: 'IMAGE', withExif: true } })).json();
  const assets = found.assets.items.filter((a) => RAW.test(a.originalFileName) && SETS[set](a)).slice(0, LIMIT[set]);
  if (!assets.length) throw new Error(`no RAWs for set ${set}: seed the instance first`);
  results.photos = assets.map((a) => `${a.originalFileName} (${a.exifInfo?.make ?? ''} ${a.exifInfo?.model ?? ''}, ${Math.round((a.exifInfo?.exifImageWidth * a.exifInfo?.exifImageHeight) / 1e6)} MP)`);
  const ids = assets.map((a) => a.id);
  console.log(`${ids.length} photos, preset ${preset}, levels ${LEVELS.join(', ')}${INSECURE ? ', plain HTTP' : ''}`);

  // Warm-up: fills the RAW cache (secure pages only) and compiles the decoder.
  mark = 'warm-up';
  const warm = await exportOnce(ids, Math.min(2, Math.max(...LEVELS)), 'low');
  console.log(
    `warm-up: ${warm.seconds.toFixed(1)} s, browser peak ${memory.peaks[mark] ?? '?'} MB, commit headroom ${memory.lowestFreeGb[mark] ?? "?"} GB, free RAM ${memory.lowestRamGb[mark] ?? "?"} GB · ${warm.stopped ?? warm.result}${warm.errors.length ? ` · errors: ${warm.errors.join(' | ')}` : ''}`,
  );
  if (warm.stopped) throw new Error(`warm-up stopped: ${warm.stopped}`);
  results.env = warm.env;

  for (const level of LEVELS) {
    mark = `x${level}`;
    const run = await exportOnce(ids, level, preset);
    const row = { level, seconds: run.seconds, perPhoto: run.seconds / ids.length, peakMb: memory.peaks[mark] ?? null, lowestFreeGb: memory.lowestFreeGb[mark] ?? null, lowestRamGb: memory.lowestRamGb[mark] ?? null, result: run.result, stopped: run.stopped, errors: run.errors };
    results.runs.push(row);
    const time = run.stopped ? `STOPPED after ${run.seconds.toFixed(1)} s (${run.stopped})` : `${run.seconds.toFixed(1)} s (${row.perPhoto.toFixed(1)} s/photo)`;
    console.log(`${level} at once: ${time}, peak ${row.peakMb ?? '?'} MB, commit headroom ${row.lowestFreeGb ?? "?"} GB, free RAM ${row.lowestRamGb ?? "?"} GB · ${run.result ?? ''}${run.errors.length ? ` · errors: ${run.errors.join(' | ')}` : ''}`);
    if (run.stopped) break; // more at once would only need more memory
  }
  const base = results.runs.find((r) => r.level === 1)?.seconds;
  if (base) for (const r of results.runs) if (!r.stopped) r.speedup = Math.round((base / r.seconds) * 100) / 100;
} catch (e) {
  results.error = String(e?.stack ?? e);
  console.error(results.error);
} finally {
  sampler?.kill();
  await browser.close();
  writeFileSync(join(outDir, `bench-export-${set}-${preset}${INSECURE ? '-http' : ''}.json`), JSON.stringify(results, null, 2));
  console.table(results.runs.map(({ level, seconds, perPhoto, speedup, peakMb, lowestFreeGb, lowestRamGb, stopped }) => ({ level, seconds: Math.round(seconds * 10) / 10, perPhoto: Math.round(perPhoto * 10) / 10, speedup, peakMb, lowestFreeGb, lowestRamGb, stopped: !!stopped })));
}
