// Compares the single-threaded LibRaw build (packages/libraw/lib) with the npm libraw-wasm 1.6.0
// it replaces: the same RAWs, decoded with the editor's settings, must give the same bytes.
// Also reports decode times. Runs in headless Edge on a cross-origin isolated 127.0.0.1 page,
// because the old (pthreads) build needs shared memory.
//
// Usage: node e2e/probe-decoder-compare.mjs <samples-dir> [only]
//   OLD_LIBRAW=<dir>  the old build (default node_modules/libraw-wasm/dist, from the M0 spike)
//   REPS=2            decodes per build and step; times are the fastest
//   STEPS=half,full   only these steps (half, full, best, sensor)
import { createServer } from 'node:http';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const [samplesDir, only] = process.argv.slice(2);
if (!samplesDir) {
  console.error('Usage: node e2e/probe-decoder-compare.mjs <samples-dir> [only]');
  process.exit(1);
}
const root = resolve(fileURLToPath(import.meta.url), '../..');
const dirs = {
  old: resolve(process.env.OLD_LIBRAW ?? join(root, 'node_modules/libraw-wasm/dist')),
  new: join(root, 'packages/libraw/lib'),
};
for (const d of Object.values(dirs)) if (!existsSync(join(d, 'index.js'))) throw new Error(`No index.js in ${d}`);
const REPS = Number(process.env.REPS ?? 1);
const ONLY_STEPS = process.env.STEPS?.split(',');
const RAW_EXT = new Set(['.arw', '.nef', '.cr2', '.cr3', '.raf', '.dng', '.orf', '.rw2', '.pef']);
const samples = readdirSync(samplesDir)
  .filter((f) => RAW_EXT.has(extname(f).toLowerCase()))
  .filter((f) => !only || f.toLowerCase().includes(only.toLowerCase()))
  .sort();

// The editor's settings (packages/decoder/src/libraw.ts).
const PAGE = `<!doctype html><meta charset="utf-8"><title>decoder compare</title><script type="module">
const BASE = { outputColor: 0, outputBps: 16, gamm: [1, 1, 0, 0, 0, 0], noAutoBright: true, useCameraWb: true, userFlip: 0, highlight: 1 };
const STEPS = {
  half: () => ({ ...BASE, halfSize: true }),
  full: (xtrans) => ({ ...BASE, userQual: xtrans ? 2 : 3 }),
  best: () => ({ ...BASE, userQual: 3 }),
  sensor: () => ({ ...BASE, noInterpolation: true, noAutoScale: true }),
};
const kept = {};
const hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
window.decode = async (build, file, step, xtrans) => {
  const { default: LibRaw } = await import('/' + build + '/index.js');
  const bytes = new Uint8Array(await (await fetch('/samples/' + encodeURIComponent(file))).arrayBuffer());
  const raw = new LibRaw();
  try {
    const t0 = performance.now();
    await raw.open(bytes, STEPS[step](xtrans));
    const meta = await raw.metadata(true);
    const img = await raw.imageData();
    const sensor = step === 'sensor' ? await raw.rawImageData() : null;
    const ms = performance.now() - t0;
    const data = sensor ? sensor.data : img.data;
    kept[build] = data;
    return { ms, width: img.width, height: img.height, filters: meta.filters, hash: await hex(data), meta: await hex(new TextEncoder().encode(JSON.stringify(meta))) };
  } finally {
    raw.dispose();
  }
};
window.diff = () => {
  const a = kept.old, b = kept.new;
  if (!a || !b || a.length !== b.length) return { sizes: [a?.length, b?.length] };
  let n = 0, max = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; if (d > max) max = d; } }
  return { differing: n, of: a.length, maxDiff: max };
};
window.forget = () => { delete kept.old; delete kept.new; };
window.ready = true;
</script>`;

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const MIME = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };
const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  for (const [k, v] of Object.entries(ISOLATION)) res.setHeader(k, v);
  if (url === '/') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(PAGE);
  }
  const [, area, name] = /^\/(old|new|samples)\/([^/]+)$/.exec(url) ?? [];
  const path = area === 'samples' ? join(samplesDir, basename(name ?? '')) : area ? join(dirs[area], basename(name)) : null;
  if (!path || !existsSync(path)) {
    res.statusCode = 404;
    return res.end();
  }
  res.setHeader('Content-Type', MIME[extname(path)] ?? 'application/octet-stream');
  res.setHeader('Content-Length', statSync(path).size);
  createReadStream(path).pipe(res);
});
await new Promise((r) => server.listen(5198, '127.0.0.1', r));

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto('http://127.0.0.1:5198/');
await page.waitForFunction(() => window.ready && crossOriginIsolated);

const rows = [];
let failures = 0;
for (const file of samples) {
  // X-Trans gets quality 2 in the editor and 3-pass Markesteijn for lossy DNGs; Bayer files
  // use AHD for both, so 'best' is only run on X-Trans.
  const probe = await page.evaluate(([f]) => window.decode('new', f, 'half', false), [file]);
  const xtrans = probe.filters === 9;
  for (const step of ['half', 'full', ...(xtrans ? ['best'] : []), 'sensor'].filter((s) => !ONLY_STEPS || ONLY_STEPS.includes(s))) {
    const result = { old: null, new: null, oldMs: Infinity, newMs: Infinity };
    for (let rep = 0; rep < REPS; rep++) {
      // Alternate the order so neither build always runs on a warm cache.
      for (const build of rep % 2 ? ['new', 'old'] : ['old', 'new']) {
        const r = await page.evaluate(([b, f, s, x]) => window.decode(b, f, s, x), [build, file, step, xtrans]);
        result[build] = r;
        result[`${build}Ms`] = Math.min(result[`${build}Ms`], r.ms);
      }
    }
    const same = result.old.hash === result.new.hash;
    const sameMeta = result.old.meta === result.new.meta;
    const diff = same ? null : await page.evaluate(() => window.diff());
    await page.evaluate(() => window.forget());
    if (!same || !sameMeta) failures++;
    const row = {
      file,
      step,
      size: `${result.new.width}x${result.new.height}`,
      pixels: same ? 'identical' : `DIFFERENT ${JSON.stringify(diff)}`,
      metadata: sameMeta ? 'identical' : 'DIFFERENT',
      oldMs: Math.round(result.oldMs),
      newMs: Math.round(result.newMs),
      change: `${(((result.newMs - result.oldMs) / result.oldMs) * 100).toFixed(1)} %`,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}
console.table(rows);
console.log(failures ? `${failures} step(s) differ` : 'All decodes are byte-identical.');
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
