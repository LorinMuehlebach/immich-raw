// M0: (1) does our camera->sRGB math match LibRaw's own sRGB output (ΔE)?
//     (2) how long does MozJPEG (jSquash) take to encode a full-resolution render?
import encode from '@jsquash/jpeg/encode';
import LibRaw from 'libraw-wasm';

const log = (s) => {
  document.getElementById('log').textContent += s + '\n';
  console.log(s);
};

const BASE = {
  outputBps: 16, gamm: [1, 1, 0, 0, 0, 0], noAutoBright: true,
  useCameraWb: true, userFlip: 0, highlight: 1,
};

async function decode(bytes, settings) {
  const raw = new LibRaw();
  try {
    await raw.open(bytes.slice(), settings);
    const meta = await raw.metadata(true);
    const img = await raw.imageData();
    return { meta, img };
  } finally {
    raw.dispose();
  }
}

// Linear sRGB (D65) -> CIELAB
function lab([r, g, b]) {
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x / 0.95047), fy = f(y), fz = f(z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

async function colorCheck(bytes) {
  const cam = await decode(bytes, { ...BASE, halfSize: true, outputColor: 0 });
  const srgb = await decode(bytes, { ...BASE, halfSize: true, outputColor: 1 });
  const M = cam.meta.color_data.rgb_cam.map((r) => r.slice(0, 3));
  const a = cam.img.data, b = srgb.img.data;
  const n = cam.img.width * cam.img.height;
  // Normalise both so the 99.5th-percentile luminance-ish level is ~0.9: Lab is scale-sensitive.
  let sum = 0, max = 0, count = 0, over2 = 0;
  for (let p = 0; p < n; p += 7) {
    const i = p * 3;
    const c = [a[i] / 65535, a[i + 1] / 65535, a[i + 2] / 65535];
    if (Math.max(...c) > 0.97) continue; // skip clipped pixels
    const ours = [0, 1, 2].map((k) => Math.max(0, M[k][0] * c[0] + M[k][1] * c[1] + M[k][2] * c[2]));
    const ref = [b[i] / 65535, b[i + 1] / 65535, b[i + 2] / 65535];
    const [L1, A1, B1] = lab(ours.map((v) => v * 4));
    const [L2, A2, B2] = lab(ref.map((v) => v * 4));
    const de = Math.hypot(L1 - L2, A1 - A2, B1 - B2); // ΔE76
    sum += de; count++; if (de > max) max = de; if (de > 2) over2++;
  }
  return { pixels: count, meanDeltaE76: +(sum / count).toFixed(3), maxDeltaE76: +max.toFixed(2), pctOver2: +((100 * over2) / count).toFixed(2) };
}

function toRgba8({ meta, img }) {
  const mul = meta.color_data.cam_mul.slice(0, 3);
  const comp = (Math.max(...mul) / Math.min(...mul)) * 2; // +1 EV so the test image isn't dark
  const M = meta.color_data.rgb_cam.map((r) => r.slice(0, 3));
  const lut = new Uint8ClampedArray(4096);
  for (let i = 0; i < 4096; i++) {
    const v = i / 4095;
    lut[i] = 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  }
  const n = img.width * img.height;
  const out = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p++) {
    const i = p * 3, o = p * 4;
    const r = (img.data[i] / 65535) * comp, g = (img.data[i + 1] / 65535) * comp, b = (img.data[i + 2] / 65535) * comp;
    for (let k = 0; k < 3; k++) {
      const v = M[k][0] * r + M[k][1] * g + M[k][2] * b;
      out[o + k] = lut[Math.min(4095, Math.max(0, Math.round(v * 4095)))];
    }
    out[o + 3] = 255;
  }
  return new ImageData(out, img.width, img.height);
}

async function main() {
  const file = new URLSearchParams(location.search).get('file') ?? 'nikon-z7.NEF';
  const bytes = new Uint8Array(await (await fetch(`/samples/${file}`)).arrayBuffer());
  const results = { file };

  results.color = await colorCheck(bytes);
  log(`color check (ours vs LibRaw sRGB): ${JSON.stringify(results.color)}`);

  let t = performance.now();
  const full = await decode(bytes, { ...BASE, outputColor: 0, userQual: 3 });
  log(`full AHD decode ${(performance.now() - t).toFixed(0)} ms, ${full.img.width}x${full.img.height}`);
  t = performance.now();
  const rgba = toRgba8(full);
  log(`to RGBA8 (CPU) ${(performance.now() - t).toFixed(0)} ms`);

  const variants = {
    'q92 444 progressive (plan)': { quality: 92, auto_subsample: false, chroma_subsample: 1, progressive: true, optimize_coding: true },
    'q92 444 baseline': { quality: 92, auto_subsample: false, chroma_subsample: 1, progressive: false, optimize_coding: true },
    'q92 420 baseline': { quality: 92, auto_subsample: false, chroma_subsample: 2, progressive: false, optimize_coding: true },
  };
  results.encode = [];
  // Browser's built-in encoder, for comparison (fast, but no control over chroma subsampling,
  // and Safari caps canvas area).
  t = performance.now();
  const canvas = new OffscreenCanvas(rgba.width, rgba.height);
  canvas.getContext('2d').putImageData(rgba, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  const nativeMs = Math.round(performance.now() - t);
  results.encode.push({ name: 'native convertToBlob q0.92', ms: nativeMs, sizeMB: +(blob.size / 1e6).toFixed(1) });
  log(`encode native convertToBlob q0.92: ${nativeMs} ms, ${(blob.size / 1e6).toFixed(1)} MB`);
  if (new URLSearchParams(location.search).has('nativeOnly')) {
    window.__results = results;
    window.__done = true;
    return;
  }
  for (const [name, opts] of Object.entries(variants)) {
    t = performance.now();
    const buf = await encode(rgba, opts);
    const ms = Math.round(performance.now() - t);
    results.encode.push({ name, ms, sizeMB: +(buf.byteLength / 1e6).toFixed(1) });
    log(`encode ${name}: ${ms} ms, ${(buf.byteLength / 1e6).toFixed(1)} MB`);
  }
  window.__results = results;
  window.__done = true;
}

main().catch((e) => {
  log(`FATAL ${e?.stack ?? e}`);
  window.__results = { fatal: String(e) };
  window.__done = true;
});
