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

// `?q=0,2` replaces the default set with full decodes at those userQual levels.
const qParam = new URLSearchParams(location.search).get('q');
const CONFIGS = qParam
  ? [
      { name: 'half', settings: { ...BASE, halfSize: true } },
      ...qParam.split(',').map((q) => ({ name: `full-q${q}`, settings: { ...BASE, userQual: Number(q) } })),
    ]
  : [
      { name: 'half', settings: { ...BASE, halfSize: true } },
      { name: 'full-DHT', settings: { ...BASE, userQual: 11 } },
      { name: 'full-AHD', settings: { ...BASE, userQual: 3 } },
    ];

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
