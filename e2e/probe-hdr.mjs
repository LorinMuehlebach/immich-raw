// Merge to HDR on a generated bracket, in the browser, without Immich: the real decoder (LibRaw),
// merge, DNG writer, LibRaw check of the DNG and the renderer, run against the editor's Vite
// dev server. Immich's part (finding the bracket, upload, stack) is not covered here.
//
// Usage (from the repository root):
//   npm run build -w @immich-raw/inject
//   cd apps/editor && npx vite --port 5183 --strictPort --host 127.0.0.1   (in another terminal)
//   node e2e/probe-hdr.mjs <out-dir>
// EDITOR_URL overrides http://127.0.0.1:5183.
//
// The scene: a dim, textured room (5 to 9 stops under the reference shot's clipping) with a
// window onto a bright sky (up to 1.8 stops over it), shot at 0, -2 and +2 EV with sensor
// noise, each shot moved a few pixels as if hand-held. Checks: the exposures and shifts found,
// the window kept without clipping, less noise in the room than in the reference shot, and the
// DNG decoding back exactly. Writes the reference shot and the merged photo as PNGs to look at.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { buildDng } from '../packages/dng/src/index.ts';
import { mosaic } from './raw-burst.mjs';

const OUT = process.argv[2];
if (!OUT) throw new Error('Usage: node e2e/probe-hdr.mjs <out-dir>');
mkdirSync(OUT, { recursive: true });
const EDITOR = process.env.EDITOR_URL ?? 'http://127.0.0.1:5183';
const W = 2400;
const H = 1600;
const XYZ_TO_SRGB = [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252];

// Shots: EV, where they show the scene (this shot's pixel (x + dx, y + dy) = scene (x, y)), when.
const SHOTS = [
  { name: 'HDR_0001', ev: 0, dx: 0, dy: 0, ms: 0 },
  { name: 'HDR_0002', ev: -2, dx: 6, dy: -4, ms: 200 },
  { name: 'HDR_0003', ev: 2, dx: -3, dy: 5, ms: 400 },
];

function hash(x, y) {
  const h = Math.imul((x * 73856093) ^ (y * 19349663), 0x9e3779b1) >>> 0;
  return (h & 0xffff) / 0xffff;
}

/** Smooth value noise in 0..1 at scale `s` pixels. */
function noise(x, y, s) {
  const fx = x / s;
  const fy = y / s;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash(x0, y0) + (hash(x0 + 1, y0) - hash(x0, y0)) * sx;
  const b = hash(x0, y0 + 1) + (hash(x0 + 1, y0 + 1) - hash(x0, y0 + 1)) * sx;
  return a + (b - a) * sy;
}

const WINDOW = { x0: 1450, x1: 2250, y0: 250, y1: 1150 };
/** A patch of sky (clipped in the 0 and +2 EV shots, so it comes from the -2 EV one). */
const SKY = { x0: 1500, x1: 1600, y0: 290, y1: 340 };
/** A flat patch of wall, for measuring noise. */
const WALL = { x0: 300, x1: 420, y0: 1250, y1: 1370 };

/** Linear radiance per channel; 1 = the reference shot's clipping point. */
function scene(x, y) {
  const inWindow = x >= WINDOW.x0 && x < WINDOW.x1 && y >= WINDOW.y0 && y < WINDOW.y1;
  if (inWindow) {
    const bar = Math.abs(x - (WINDOW.x0 + WINDOW.x1) / 2) < 14 || Math.abs(y - (WINDOW.y0 + WINDOW.y1) / 2) < 14;
    if (bar) return [0.006, 0.005, 0.004];
    // Sky: brighter towards the top, with clouds; a dark branch across it.
    const t = (y - WINDOW.y0) / (WINDOW.y1 - WINDOW.y0);
    const cloud = noise(x, y, 60) * 0.6 + noise(x, y, 17) * 0.4;
    const sky = (1.0 + 2.0 * (1 - t)) * (0.8 + 0.4 * cloud);
    const branch = Math.abs(y - (WINDOW.y0 + 300 + 0.35 * (x - WINDOW.x0) + 40 * Math.sin(x / 50))) < 7;
    if (branch) return [0.05, 0.04, 0.03];
    return [0.65 * sky, 0.8 * sky, sky];
  }
  if (x >= WALL.x0 - 40 && x < WALL.x1 + 40 && y >= WALL.y0 - 40 && y < WALL.y1 + 40) return [0.018, 0.015, 0.011];
  // Room: bricks with mortar and texture, darker into the corner.
  const row = Math.floor(y / 40);
  const bx = x + (row % 2) * 45;
  const mortar = y % 40 < 4 || bx % 90 < 4;
  const brick = 0.6 + 0.4 * hash(Math.floor(bx / 90), row);
  const tex = 0.8 + 0.4 * noise(x, y, 5);
  const falloff = 0.35 + 0.65 * (x / W);
  const v = (mortar ? 0.006 : 0.03 * brick * tex) * falloff;
  return [v, 0.8 * v, 0.55 * v];
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const T0 = Date.parse('2015-07-01T10:00:00.000Z');

const files = {};
for (const s of SHOTS) {
  const k = 2 ** s.ev;
  const rgb16 = new Uint16Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = scene(x - s.dx, y - s.dy);
      for (let c = 0; c < 3; c++) rgb16[(y * W + x) * 3 + c] = Math.round(Math.min(1, v[c] * k) * 65535);
    }
  }
  const d = new Date(T0 + s.ms);
  const text = `${d.getUTCFullYear()}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const dng = await buildDng(
    {
      make: 'Immich-RAW',
      model: 'Test Camera',
      uniqueCameraModel: 'Immich-RAW Test Camera',
      software: 'immich-raw e2e',
      orientation: 1,
      colorMatrix1: XYZ_TO_SRGB,
      calibrationIlluminant1: 21,
      asShotNeutral: [1, 1, 1],
      dateTime: text,
      exif: { dateTimeOriginal: text, offsetTimeOriginal: '+00:00', subSecTimeOriginal: pad(d.getUTCMilliseconds(), 3), exposureTime: (1 / 250) * k, fNumber: 8, iso: 100 },
    },
    mosaic(rgb16, W, H, 11 + s.ev),
  );
  const path = resolve(OUT, `${s.name}.dng`);
  writeFileSync(path, dng);
  files[s.name] = path;
}
console.log(`bracket written: ${SHOTS.map((s) => `${s.name} (${s.ev >= 0 ? '+' : ''}${s.ev} EV)`).join(', ')}`);

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: !process.env.HEADED, args: ['--enable-gpu', '--use-angle=d3d11'] });
let failed = 0;
try {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/probe-hdr/*.dng', (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop().replace('.dng', '');
    return route.fulfill({ body: readFileSync(files[name]), contentType: 'application/octet-stream' });
  });
  // Any page of the dev server will do: only its module graph is used.
  await page.goto(`${EDITOR}/immich-raw/`);
  const fsUrl = (p) => `/immich-raw/@fs/${resolve(p).replace(/\\/g, '/')}`;
  const result = await page.evaluate(
    async ({ shots, W, H, mods, WALL, WINDOW, SKY }) => {
      const { buildHdr } = await import(mods.build);
      const P = await import(mods.pipeline);
      const { RawSession } = await import(mods.decoder);
      const { defaultRecipe } = await import(mods.recipe);
      const asset = (s) => ({
        id: s.name,
        originalFileName: `${s.name}.dng`,
        checksum: s.name,
        exifInfo: { make: 'Immich-RAW', model: 'Test Camera', dateTimeOriginal: '2015-07-01T10:00:00.000Z', timeZone: 'UTC', fNumber: 8, iso: 100 },
      });
      const fetchBytes = async (name) => new Uint8Array(await (await fetch(`/probe-hdr/${name}.dng`)).arrayBuffer());
      /** What the editor starts a merged HDR with (withAutoHdr in editor.svelte.ts). */
      const startRecipe = (r, base) => {
        const recipe = structuredClone(base);
        const samples = r.toneSamples(recipe);
        const whitePoint = r.profileWhitePoint(recipe);
        recipe.basic.hdr = P.autoHdr(samples, { whitePoint });
        Object.assign(recipe.basic, P.autoTone(samples, { whitePoint, hdr: recipe.basic.hdr }));
        return recipe;
      };
      const render = async (img, meta, auto) => {
        const r = new P.Renderer(document.createElement('canvas'));
        try {
          r.setSource(img, P.cameraInfo(meta));
          const recipe = auto ? startRecipe(r, defaultRecipe()) : defaultRecipe();
          const out = await r.exportImage(recipe, img);
          const c = new OffscreenCanvas(out.width, out.height);
          c.getContext('2d').putImageData(out, 0, 0);
          const blob = await c.convertToBlob({ type: 'image/png' });
          const b64 = await new Promise((res) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result).split(',')[1]);
            fr.readAsDataURL(blob);
          });
          return { png: b64, hdr: recipe.basic.hdr, basic: recipe.basic };
        } finally {
          r.dispose();
        }
      };
      const labels = [];
      const t0 = performance.now();
      const built = await buildHdr({
        frames: shots.map((s) => ({ asset: asset(s) })),
        align: true,
        deghost: 'off',
        software: 'probe',
        download: (a, onProgress) => fetchBytes(a.id).then((b) => (onProgress(1), b)),
        preview: async (half, meta) => {
          const r = new P.Renderer(document.createElement('canvas'));
          try {
            r.setSource(half, P.cameraInfo(meta));
            return await r.exportImage(startRecipe(r, defaultRecipe()), half);
          } finally {
            r.dispose();
          }
        },
        onProgress: (label) => labels[labels.length - 1] !== label && labels.push(label),
      });
      const seconds = (performance.now() - t0) / 1000;

      // Decode the DNG and the reference shot as the editor does.
      const merged = await RawSession.open(built.bytes);
      const mergedFull = await merged.full();
      const refSession = await RawSession.open(await fetchBytes('HDR_0001'));
      const refFull = await refSession.full();
      // Noise on the flat wall patch (green, relative to its mean), in the merged photo's geometry.
      const g = built.frames.find((f) => f.id === 'HDR_0001').shift;
      const patch = (img, s) => {
        let sum = 0;
        let sq = 0;
        let n = 0;
        for (let y = WALL.y0; y < WALL.y1; y++) {
          for (let x = WALL.x0; x < WALL.x1; x++) {
            const v = img.data[((y + s.dy) * img.width + x + s.dx) * 3 + 1];
            sum += v;
            sq += v * v;
            n++;
          }
        }
        const mean = sum / n;
        return { mean, rel: Math.sqrt(Math.max(0, sq / n - mean * mean)) / mean };
      };
      const patchMean = (img, r) => {
        let sum = 0;
        let n = 0;
        for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++, n++) sum += img.data[(y * img.width + x) * 3 + 1];
        return sum / n;
      };
      // The top of the window (blue): share of pixels within 1 % of its brightest one. Clipped,
      // the sky is flat at that value; kept, its clouds spread it out.
      const flatShare = (img, s) => {
        const v = [];
        for (let y = WINDOW.y0 + 20; y < WINDOW.y0 + 200; y++) for (let x = WINDOW.x0 + 20; x < WINDOW.x1 - 20; x++) v.push(img.data[((y + s.dy) * img.width + x + s.dx) * 3 + 2]);
        const mx = v.reduce((a, b) => (b > a ? b : a), 0);
        return v.filter((x) => x >= 0.99 * mx).length / v.length;
      };
      const out = {
        seconds,
        labels,
        size: built.bytes.length,
        verification: built.verification,
        headroom: built.headroom,
        frames: built.frames,
        noiseMerged: patch(mergedFull, { dx: 0, dy: 0 }),
        noiseRef: patch(refFull, g),
        skyOverWall: patchMean(mergedFull, SKY) / patch(mergedFull, { dx: 0, dy: 0 }).mean,
        flatMerged: flatShare(mergedFull, { dx: 0, dy: 0 }),
        flatRef: flatShare(refFull, g),
        renders: {
          reference: await render(refSession.half, refSession.meta, false),
          merged: await render(merged.half, merged.meta, true),
        },
        baseline: merged.meta.baselineExposure,
      };
      merged.close();
      refSession.close();
      return out;
    },
    {
      shots: SHOTS,
      W,
      H,
      WALL,
      WINDOW,
      SKY,
      mods: {
        build: '/immich-raw/src/lib/hdr/build.ts',
        pipeline: fsUrl('packages/pipeline/src/index.ts'),
        decoder: fsUrl('packages/decoder/src/index.ts'),
        recipe: fsUrl('packages/recipe/src/index.ts'),
      },
    },
  );

  for (const [name, r] of Object.entries(result.renders)) writeFileSync(resolve(OUT, `${name}.png`), Buffer.from(r.png, 'base64'));
  console.log(`merged in ${result.seconds.toFixed(1)} s: ${result.labels.join(' → ')}`);
  console.log(`DNG ${(result.size / 1e6).toFixed(1)} MB, baseline exposure ${result.baseline.toFixed(2)} EV, headroom ${result.headroom.toFixed(2)} stops`);
  console.log(`start look: ${JSON.stringify(result.renders.merged.basic)}`);
  const check = (ok, text) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
    if (!ok) failed++;
  };
  check(result.verification.ok, `DNG check: ${result.verification.text}`);
  const ref = result.frames.find((f) => f.id === 'HDR_0001');
  for (const s of SHOTS) {
    const f = result.frames.find((x) => x.id === s.name);
    // LibRaw scales a frame whose brightest pixel is near white (the -2 EV one: 0.9) up to it,
    // so decoded frames sit up to ~0.15 EV off their nominal step, and the measurement follows
    // the decoded values. A sanity check only: the sky / wall check below is the real one.
    const evOk = Math.abs(f.ev - s.ev) < 0.3 && (s.ev === 0 || f.measured);
    check(evOk, `${s.name}: exposure ${f.ev.toFixed(3)} EV (${f.measured ? 'measured' : 'from EXIF'}), expected ${s.ev}`);
    const rel = { dx: f.shift.dx - ref.shift.dx, dy: f.shift.dy - ref.shift.dy };
    check(rel.dx === s.dx && rel.dy === s.dy, `${s.name}: shift ${rel.dx}, ${rel.dy} against the reference, expected ${s.dx}, ${s.dy}`);
  }
  const gain = Math.log2(result.noiseRef.rel / result.noiseMerged.rel);
  // Shot noise: 4x the light (+2 EV) gives half the relative noise, one stop.
  check(gain > 0.8, `wall noise ${(result.noiseMerged.rel * 100).toFixed(2)} % merged vs ${(result.noiseRef.rel * 100).toFixed(2)} % in the reference: ${gain.toFixed(2)} stops less`);
  // The merged photo keeps the scene's brightness ratios across frames: sky (from -2 EV) over
  // wall (from +2 EV), green, against the scene itself. Merged geometry = the reference shot's.
  let skyTruth = 0;
  let skyN = 0;
  for (let y = SKY.y0; y < SKY.y1; y++) for (let x = SKY.x0; x < SKY.x1; x++, skyN++) skyTruth += scene(x, y)[1];
  const truth = skyTruth / skyN / scene(WALL.x0, WALL.y0)[1];
  const ratioErr = Math.log2(result.skyOverWall / truth);
  check(Math.abs(ratioErr) < 0.05, `sky / wall brightness ${result.skyOverWall.toFixed(1)}, scene ${truth.toFixed(1)}: ${ratioErr >= 0 ? '+' : ''}${ratioErr.toFixed(3)} EV`);
  check(result.flatRef > 0.5, `the reference shot clips the sky (${(result.flatRef * 100).toFixed(0)} % of it flat at the top)`);
  check(result.flatMerged < 0.02, `the merged photo keeps it (${(result.flatMerged * 100).toFixed(1)} % flat)`);
  // The sky reaches 3.6x the reference's clipping point: log2(3.6) = 1.85 stops.
  check(result.headroom > 1.6 && result.headroom < 2.2, `highlights reach ${result.headroom.toFixed(2)} stops over the reference's clipping (scene: 1.85)`);
  check(result.renders.merged.hdr > 0, `the merged photo starts with HDR ${result.renders.merged.hdr}`);
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  console.log(`renders: ${resolve(OUT, 'reference.png')}, ${resolve(OUT, 'merged.png')}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
