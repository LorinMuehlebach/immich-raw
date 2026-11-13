// M0 decode benchmark: decodes each sample with the settings from the plan and reports
// timings, output format, the metadata fields the pipeline needs, clip thresholds and memory.
import LibRaw from 'libraw-wasm';

const log = (s) => {
  document.getElementById('log').textContent += s + '\n';
  console.log(s);
};

// Settings from the plan: linear camera RGB, 16-bit, as-shot WB, unclipped highlights, no flip.
// `gamm` must have 6 entries (LibRaw's params.gamm[6]); the wrapper silently ignores
// shorter arrays even though its .d.ts types it as [number, number].
const BASE = {
  outputColor: 0,
  outputBps: 16,
  gamm: [1, 1, 0, 0, 0, 0],
  noAutoBright: true,
  useCameraWb: true,
  userFlip: 0,
  highlight: 1,
};

// `?q=0,2` replaces the default set with full decodes at those userQual levels (`?q=` alone:
// only the half decode).
const qParam = new URLSearchParams(location.search).get('q');
const CONFIGS = qParam !== null
  ? [
      { name: 'half', settings: { ...BASE, halfSize: true } },
      ...qParam
        .split(',')
        .filter(Boolean)
        .map((q) => ({ name: `full-q${q}`, settings: { ...BASE, userQual: Number(q) } })),
    ]
  : [
      { name: 'half', settings: { ...BASE, halfSize: true } },
      { name: 'full-DHT', settings: { ...BASE, userQual: 11 } },
      { name: 'full-AHD', settings: { ...BASE, userQual: 3 } },
    ];

// `?warm=1` adds a half decode on a worker started 2 s earlier: its `open` has no WebAssembly
// start-up in it, which shows what starting the worker early (prewarmDecoder) saves.
const WARM = new URLSearchParams(location.search).get('warm') === '1';
// `?tiles=2,4` adds decodes split into that many horizontal stripes (LibRaw's cropbox), one
// worker per stripe, all at once: the half decode and the editor's full decode (AHD, or
// Markesteijn 1-pass for X-Trans). Every stripe is checked row by row against a whole decode.
const TILES = (new URLSearchParams(location.search).get('tiles') ?? '')
  .split(',')
  .map(Number)
  .filter((n) => n > 1);

const REQUIRED_COLOR_FIELDS = ['black', 'maximum', 'cam_mul', 'pre_mul', 'rgb_cam', 'cam_xyz'];

// The runner samples browser process memory and attributes the peak to the active mark.
const mark = (label) => console.log(`MARK ${label}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function channelStats(img) {
  const { data, width, height } = img;
  const n = width * height;
  const max = [0, 0, 0];
  const atMax = [0, 0, 0];
  for (let i = 0; i < n * 3; i += 3) {
    for (let c = 0; c < 3; c++) if (data[i + c] > max[c]) max[c] = data[i + c];
  }
  for (let i = 0; i < n * 3; i += 3) {
    for (let c = 0; c < 3; c++) if (data[i + c] >= max[c] - 1) atMax[c]++;
  }
  return { max, clippedPct: atMax.map((v) => +((100 * v) / n).toFixed(3)) };
}

// CPU preview using the plan's math: compensate the highlight=1 multiplier normalisation,
// apply LibRaw's camera->sRGB matrix (rgb_cam), encode sRGB. Returns a PNG data URL.
function previewPng(img, color, longSide = 900) {
  const mul = color.cam_mul.slice(0, 3).map((v, i) => (v > 0 ? v : color.cam_mul[1]));
  const comp = Math.max(...mul) / Math.min(...mul);
  const M = color.rgb_cam.map((row) => row.slice(0, 3));
  const step = Math.max(1, Math.ceil(Math.max(img.width, img.height) / longSide));
  const w = Math.floor(img.width / step);
  const h = Math.floor(img.height / step);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const out = ctx.createImageData(w, h);
  const enc = (v) => {
    v = Math.min(1, Math.max(0, v));
    return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y * step) * img.width + x * step) * 3;
      const r = (img.data[i] / 65535) * comp;
      const g = (img.data[i + 1] / 65535) * comp;
      const b = (img.data[i + 2] / 65535) * comp;
      const o = (y * w + x) * 4;
      out.data[o] = enc(M[0][0] * r + M[0][1] * g + M[0][2] * b);
      out.data[o + 1] = enc(M[1][0] * r + M[1][1] * g + M[1][2] * b);
      out.data[o + 2] = enc(M[2][0] * r + M[2][1] * g + M[2][2] * b);
      out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' }).then(
    (blob) =>
      new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(blob);
      }),
  );
}

function pickMeta(meta) {
  const c = meta.color_data ?? {};
  return {
    camera: `${meta.camera_make} ${meta.camera_model}`,
    lens: meta.lens?.Lens || meta.lens?.makernotes?.Lens || '',
    flip: meta.flip,
    filters: meta.filters,
    cdesc: meta.cdesc,
    colors: meta.colors,
    dngVersion: meta.dng_version,
    missingColorFields: REQUIRED_COLOR_FIELDS.filter((k) => c[k] === undefined),
    black: c.black,
    maximum: c.maximum,
    cam_mul: c.cam_mul,
    pre_mul: c.pre_mul,
    rgb_cam: c.rgb_cam,
    cam_xyz: c.cam_xyz,
    dngColorIlluminants: (c.dng_color ?? []).map((d) => d.illuminant),
    hasForwardMatrix: (c.dng_color ?? []).some((d) => d.forwardmatrix?.flat().some((v) => v !== 0)),
    baselineExposure: c.dng_levels?.baseline_exposure,
    asShotNeutral: c.dng_levels?.asshotneutral,
    gps: meta.gps_data?.gpsparsed ?? false,
  };
}

/** One decode in a fresh worker. `startedMs` is how long the worker existed before `open`. */
async function decodeOnce(bytes, settings, startedMs = 0) {
  const raw = new LibRaw();
  try {
    if (startedMs) await sleep(startedMs);
    let t = performance.now();
    await raw.open(bytes.slice(), settings);
    const openMs = Math.round(performance.now() - t);
    t = performance.now();
    const img = await raw.imageData();
    const imageDataMs = Math.round(performance.now() - t);
    return { img, openMs, imageDataMs };
  } finally {
    raw.dispose();
  }
}

/** FNV-1a hash of each of `count` rows from `first`, to compare rows without keeping images. */
function rowHashes(img, first = 0, count = img.height) {
  const out = new Uint32Array(count);
  const stride = img.width * 3;
  for (let r = 0; r < count; r++) {
    let h = 0x811c9dc5;
    const start = (first + r) * stride;
    for (let i = start; i < start + stride; i++) h = Math.imul(h ^ img.data[i], 0x01000193);
    out[r] = h >>> 0;
  }
  return out;
}

// Stripe edges sit on multiples of 6 rows (X-Trans' pattern, and even for Bayer): LibRaw moves
// a crop's corner onto the colour pattern, so aligned edges keep every stripe where it was asked.
const ALIGN = 6;
// Rows each stripe decodes beyond its own on both sides and then drops (full-size rows).
const OVERLAP = 24;

async function splitDecode(bytes, settings, n, size, half, ref) {
  const k = half ? 2 : 1;
  const step = Math.ceil(size.height / n / ALIGN) * ALIGN;
  const stripes = [];
  for (let y0 = 0; y0 < size.height; y0 += step) {
    const y1 = Math.min(size.height, y0 + step);
    const top = Math.max(0, y0 - OVERLAP);
    const bottom = Math.min(size.height, y1 + OVERLAP);
    stripes.push({ y0, y1, top, bottom });
  }
  const t0 = performance.now();
  const parts = await Promise.all(stripes.map((s) => decodeOnce(bytes, { ...settings, cropbox: [0, s.top, size.width, s.bottom - s.top] })));
  const wallMs = Math.round(performance.now() - t0);
  let checkedRows = 0;
  let differentRows = 0;
  const problems = [];
  parts.forEach(({ img }, i) => {
    const s = stripes[i];
    const first = Math.floor((s.y0 - s.top) / k);
    const count = Math.floor(s.y1 / k) - Math.floor(s.y0 / k);
    if (img.width !== ref.width || img.height < first + count) {
      problems.push(`stripe ${i}: got ${img.width}x${img.height}, rows ${s.top}-${s.bottom} asked`);
      return;
    }
    const hashes = rowHashes(img, first, count);
    for (let r = 0; r < count; r++) {
      checkedRows++;
      if (hashes[r] !== ref.hashes[Math.floor(s.y0 / k) + r]) differentRows++;
    }
  });
  return {
    config: `${half ? 'half' : 'full'}-${n}-stripes`,
    wallMs,
    stripes: parts.map((p, i) => ({ rows: `${stripes[i].top}-${stripes[i].bottom}`, size: `${p.img.width}x${p.img.height}`, openMs: p.openMs, imageDataMs: p.imageDataMs })),
    checkedRows,
    differentRows,
    identical: problems.length === 0 && differentRows === 0 && checkedRows === ref.hashes.length,
    problems,
  };
}

/** The extra runs from `?warm=1` and `?tiles=`. */
async function extraRuns(bytes, entry, file) {
  const runs = [];
  if (WARM) {
    mark(`${file}|half-warm`);
    const { img, openMs, imageDataMs } = await decodeOnce(bytes, { ...BASE, halfSize: true }, 2000);
    runs.push({ config: 'half-warm', openMs, imageDataMs, totalMs: openMs + imageDataMs, output: { width: img.width, height: img.height } });
    log(`half-warm open ${openMs} ms, imageData ${imageDataMs} ms`);
    await sleep(1500);
  }
  if (!TILES.length || !entry.size) return runs;
  const xtrans = entry.meta?.filters === 9;
  const settings = [
    { half: true, s: { ...BASE, halfSize: true } },
    { half: false, s: { ...BASE, userQual: xtrans ? 2 : 3 } },
  ];
  for (const { half, s } of settings) {
    // The whole decode to compare against, also timed on its own.
    mark(`${file}|${half ? 'half' : 'full'}-whole`);
    const whole = await decodeOnce(bytes, s);
    const ref = { width: whole.img.width, hashes: rowHashes(whole.img) };
    runs.push({ config: `${half ? 'half' : 'full'}-whole`, wallMs: whole.openMs + whole.imageDataMs, openMs: whole.openMs, imageDataMs: whole.imageDataMs });
    log(`${half ? 'half' : 'full'}-whole open ${whole.openMs} ms, imageData ${whole.imageDataMs} ms`);
    whole.img = null;
    await sleep(1500);
    for (const n of TILES) {
      mark(`${file}|${half ? 'half' : 'full'}-${n}-stripes`);
      try {
        const r = await splitDecode(bytes, s, n, entry.size, half, ref);
        runs.push(r);
        log(`${r.config} wall ${r.wallMs} ms, identical ${r.identical} (${r.differentRows}/${r.checkedRows} rows differ) ${r.problems.join('; ')}`);
      } catch (e) {
        runs.push({ config: `${half ? 'half' : 'full'}-${n}-stripes`, error: String(e?.message ?? e) });
        log(`${half ? 'half' : 'full'}-${n}-stripes ERROR ${e?.message ?? e}`);
      }
      await sleep(1500);
    }
  }
  return runs;
}

async function run() {
  log(`crossOriginIsolated=${crossOriginIsolated} hardwareConcurrency=${navigator.hardwareConcurrency}`);
  const only = new URLSearchParams(location.search).get('only');
  let files = await (await fetch('/samples/index.json')).json();
  if (only) files = files.filter((f) => f.includes(only));
  const results = [];

  for (const file of files) {
    const t0 = performance.now();
    const bytes = new Uint8Array(await (await fetch(`/samples/${file}`)).arrayBuffer());
    const fetchMs = performance.now() - t0;
    log(`\n== ${file} (${(bytes.length / 1e6).toFixed(1)} MB, fetch ${fetchMs.toFixed(0)} ms)`);
    const entry = { file, sizeMB: +(bytes.length / 1e6).toFixed(1), runs: [] };

    for (const cfg of CONFIGS) {
      const raw = new LibRaw();
      const run = { config: cfg.name };
      mark(`${file}|${cfg.name}`);
      try {
        let t = performance.now();
        await raw.open(bytes.slice(), cfg.settings); // open() transfers (detaches) the buffer
        run.openMs = Math.round(performance.now() - t);

        t = performance.now();
        const meta = await raw.metadata(true);
        run.metadataMs = Math.round(performance.now() - t);

        t = performance.now();
        const img = await raw.imageData();
        run.imageDataMs = Math.round(performance.now() - t);
        run.totalMs = run.openMs + run.metadataMs + run.imageDataMs;
        run.output = {
          width: img.width,
          height: img.height,
          colors: img.colors,
          bits: img.bits,
          type: img.data.constructor.name,
          lengthOk: img.data.length === img.width * img.height * img.colors,
          megapixels: +((img.width * img.height) / 1e6).toFixed(1),
        };
        await sleep(800); // let the runner take a sample while the decoded image is alive
        run.stats = channelStats(img);

        if (cfg.name === 'half') {
          entry.meta = pickMeta(meta);
          entry.size = { width: meta.width, height: meta.height };
          const mul = entry.meta.cam_mul.slice(0, 3);
          const mx = Math.max(...mul);
          // Expected clip point per channel with highlight=1: 65535 * mul_c / max(mul)
          entry.expectedClip = mul.map((m) => Math.round((65535 * m) / mx));
          entry.previewPng = await previewPng(img, meta.color_data);
        }
        log(
          `${cfg.name.padEnd(9)} open ${run.openMs} ms, imageData ${run.imageDataMs} ms, ` +
            `${run.output.width}x${run.output.height} ${run.output.bits}-bit, max ${run.stats.max.join('/')}`,
        );
      } catch (e) {
        run.error = String(e?.message ?? e);
        log(`${cfg.name.padEnd(9)} ERROR ${run.error}`);
      } finally {
        raw.dispose();
      }
      mark(`${file}|${cfg.name}|disposed`);
      await sleep(1500); // sample memory after the worker is gone
      entry.runs.push(run);
    }
    entry.runs.push(...(await extraRuns(bytes, entry, file)));
    results.push(entry);
  }
  window.__results = results;
  window.__done = true;
  log('\nDONE');
}

run().catch((e) => {
  log(`FATAL ${e?.stack ?? e}`);
  window.__results = { fatal: String(e) };
  window.__done = true;
});
