// HDR merge of bracketed exposures: the maths, on decoded images (pure, so it can be tested).
//
// Every frame is brought back to camera-native values (LibRaw's white balance scaling undone),
// divided by its exposure relative to the reference frame, and the merged image keeps, for
// every pixel, the brightest frame that isn't clipped there: it has the least noise. Frames are
// added brightest first; each takes what the brighter ones left ("cover"), so the weights of a
// pixel always add up to exactly 1 and the darkest frame fills in whatever is left.
//
// - Alignment: median threshold bitmaps (Ward, "Fast, Robust Image Registration for Compositing
//   High Dynamic Range Photographs from Hand-Held Exposures", 2003). Shifts only, no rotation.
// - Exposure ratios are measured on the pixels two frames both exposed well; EXIF is the fallback.
// - Ghosts (things that moved between frames) are found per block against the reference frame;
//   there the other frames step back and the reference shows.
//
// Shift convention: frame pixel (x + dx, y + dy) shows what reference pixel (x, y) shows.

/** Interleaved RGB, 16-bit, as LibRaw decodes it (white balance applied, nothing clipped). */
export interface Rgb16 {
  width: number;
  height: number;
  data: Uint16Array;
}

export interface Shift {
  dx: number;
  dy: number;
}

export type Vec3 = [number, number, number];

const clampInt = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Factors that undo LibRaw's white balance: it scaled channel c by mul_c / max(mul) (see
 * BASE_SETTINGS in the decoder), so native_c = decoded_c * k_c. Same as Convert to DNG does.
 */
export function nativeScale(camMul: number[]): Vec3 {
  const g = camMul[1] || 1;
  const m = [camMul[0]! / g, 1, camMul[2]! / g];
  const mx = Math.max(...m);
  return [mx / m[0]!, mx / m[1]!, mx / m[2]!];
}

/** Native green of every pixel: what alignment and the exposure measurements look at. */
export function greenPlane(img: Rgb16, k: Vec3): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  const kg = k[1];
  for (let i = 0; i < n; i++) out[i] = d[i * 3 + 1]! * kg;
  return out;
}

/** Saturation level of each channel (native values): the largest value the frame holds. */
export function clipLevels(img: Rgb16, k: Vec3): Vec3 {
  const d = img.data;
  let r = 1;
  let g = 1;
  let b = 1;
  for (let i = 0; i < d.length; i += 3) {
    if (d[i]! > r) r = d[i]!;
    if (d[i + 1]! > g) g = d[i + 1]!;
    if (d[i + 2]! > b) b = d[i + 2]!;
  }
  return [r * k[0], g * k[1], b * k[2]];
}

// ------------------------------------------------------------------------------- alignment

/** Median of a plane, from a sample of about 100 000 values. */
function sampledMedian(plane: Float32Array): number {
  const step = Math.max(1, Math.floor(plane.length / 100_000));
  const s = new Float32Array(Math.ceil(plane.length / step));
  for (let i = 0, j = 0; i < plane.length; i += step, j++) s[j] = plane[i]!;
  s.sort();
  return s[s.length >> 1] ?? 0;
}

/** Noise allowance (native units) around the median, and the band (log2) treated as "at the median". */
const MTB_FLOOR = 16;
const MTB_BAND = 0.1;

/**
 * Median threshold bitmap of a plane: bit 0 = above the frame's own median (the same for any
 * exposure), bit 1 = far enough from the median to count (Ward's exclusion bitmap).
 */
export function mtbCodes(plane: Float32Array, median = sampledMedian(plane)): Uint8Array {
  const out = new Uint8Array(plane.length);
  const lo = (median + MTB_FLOOR) * 2 ** -MTB_BAND - MTB_FLOOR;
  const hi = (median + MTB_FLOOR) * 2 ** MTB_BAND - MTB_FLOOR;
  for (let i = 0; i < plane.length; i++) {
    const v = plane[i]!;
    out[i] = (v > median ? 1 : 0) | (v < lo || v > hi ? 2 : 0);
  }
  return out;
}

/** Same bitmap straight from a decoded image's native green (no float plane at full size). */
export function mtbCodesOf(img: Rgb16, k: Vec3): Uint8Array {
  const n = img.width * img.height;
  const step = Math.max(1, Math.floor(n / 100_000));
  const s = new Float32Array(Math.ceil(n / step));
  for (let i = 0, j = 0; i < n; i += step, j++) s[j] = img.data[i * 3 + 1]! * k[1];
  s.sort();
  const median = s[s.length >> 1] ?? 0;
  const lo = (median + MTB_FLOOR) * 2 ** -MTB_BAND - MTB_FLOOR;
  const hi = (median + MTB_FLOOR) * 2 ** MTB_BAND - MTB_FLOOR;
  const out = new Uint8Array(n);
  const kg = k[1];
  for (let i = 0; i < n; i++) {
    const v = img.data[i * 3 + 1]! * kg;
    out[i] = (v > median ? 1 : 0) | (v < lo || v > hi ? 2 : 0);
  }
  return out;
}

/**
 * Share of compared pixels whose bitmaps disagree, with `b` shifted by (dx, dy) against `a`
 * shifted by (ax, ay) (both relative to a common frame of w x h), every `rowStep`-th row.
 */
export function mtbError(a: Uint8Array, b: Uint8Array, w: number, h: number, ax: number, ay: number, dx: number, dy: number, rowStep = 1): number {
  let diff = 0;
  let count = 0;
  const x0 = Math.max(0, -ax, -dx);
  const x1 = Math.min(w, w - ax, w - dx);
  const y0 = Math.max(0, -ay, -dy);
  const y1 = Math.min(h, h - ay, h - dy);
  for (let y = y0; y < y1; y += rowStep) {
    let pa = (y + ay) * w + x0 + ax;
    let pb = (y + dy) * w + x0 + dx;
    for (let x = x0; x < x1; x++, pa++, pb++) {
      const ca = a[pa]!;
      const cb = b[pb]!;
      if (ca & cb & 2) {
        count++;
        diff += (ca ^ cb) & 1;
      }
    }
  }
  return count ? diff / count : 1;
}

function halvePlane(p: Float32Array, w: number, h: number): { plane: Float32Array; w: number; h: number } {
  const w2 = w >> 1;
  const h2 = h >> 1;
  const out = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    const r0 = 2 * y * w;
    const r1 = r0 + w;
    for (let x = 0; x < w2; x++) out[y * w2 + x] = 0.25 * (p[r0 + 2 * x]! + p[r0 + 2 * x + 1]! + p[r1 + 2 * x]! + p[r1 + 2 * x + 1]!);
  }
  return { plane: out, w: w2, h: h2 };
}

/**
 * Shift of `img` against `ref` (same size), by MTB on an image pyramid, up to `maxShift`
 * pixels either way: a full search at the coarsest level, then +-1 at each finer one.
 */
export function alignMtb(ref: Float32Array, img: Float32Array, w: number, h: number, maxShift = 64): Shift {
  const levels: { a: Float32Array; b: Float32Array; w: number; h: number }[] = [{ a: ref, b: img, w, h }];
  while (levels.length < 12 && 2 ** levels.length - 1 < maxShift) {
    const top = levels[levels.length - 1]!;
    if (Math.min(top.w, top.h) < 64) break;
    const a = halvePlane(top.a, top.w, top.h);
    const b = halvePlane(top.b, top.w, top.h);
    levels.push({ a: a.plane, b: b.plane, w: a.w, h: a.h });
  }
  let dx = 0;
  let dy = 0;
  for (let l = levels.length - 1; l >= 0; l--) {
    const { a, b, w: lw, h: lh } = levels[l]!;
    if (l < levels.length - 1) {
      dx *= 2;
      dy *= 2;
    }
    const ca = mtbCodes(a);
    const cb = mtbCodes(b);
    const r = l === levels.length - 1 ? Math.max(1, Math.ceil(maxShift / 2 ** l)) : 1;
    let best = { dx, dy, err: Infinity };
    for (let sy = -r; sy <= r; sy++) {
      for (let sx = -r; sx <= r; sx++) {
        const err = mtbError(ca, cb, lw, lh, 0, 0, dx + sx, dy + sy);
        // Ties go to the smaller move.
        const tie = Math.abs(err - best.err) <= 1e-9 && Math.abs(dx + sx) + Math.abs(dy + sy) < Math.abs(best.dx) + Math.abs(best.dy);
        if (err < best.err - 1e-9 || tie) best = { dx: dx + sx, dy: dy + sy, err };
      }
    }
    dx = best.dx;
    dy = best.dy;
  }
  return { dx, dy };
}

/**
 * Exact shift of a full-size frame against the previous one, near `guess`: compares their
 * bitmaps (mtbCodesOf) every second row. `prevShift` is where the previous frame sits.
 */
export function refineShift(prev: Uint8Array, prevShift: Shift, cur: Uint8Array, w: number, h: number, guess: Shift, radius = 1): Shift {
  let best = { ...guess, err: Infinity };
  for (let sy = -radius; sy <= radius; sy++) {
    for (let sx = -radius; sx <= radius; sx++) {
      const err = mtbError(prev, cur, w, h, prevShift.dx, prevShift.dy, guess.dx + sx, guess.dy + sy, 2);
      const moved = Math.abs(sx) + Math.abs(sy);
      if (err < best.err - 1e-9 || (Math.abs(err - best.err) <= 1e-9 && moved === 0)) best = { dx: guess.dx + sx, dy: guess.dy + sy, err };
    }
  }
  return { dx: best.dx, dy: best.dy };
}

// ------------------------------------------------------------------------------- exposure

/** Ghost detection compares pixels between these shares of the clip level (noise below, clipping above). */
const WELL_LO = 0.004;
const WELL_HI = 0.85;

/**
 * Exposure measurements stay between these shares of the clip level: clear of the noise floor
 * (noise clipped at black lifts dark pixels) and of the top, where one channel may have clipped
 * and the demosaic bends the others.
 */
const RATIO_LO = 0.01;
const RATIO_HI = 0.6;

/**
 * Brightness of `b` relative to `a` (planes of the same size, each at its shift), from the
 * median per-pixel ratio where both are well exposed. Null when they share too few such pixels.
 * Measured on the decoded values, so it also covers LibRaw scaling a frame whose brightest pixel
 * is close to white (its adjust_maximum).
 */
export function exposureRatio(a: Float32Array, b: Float32Array, w: number, h: number, sa: Shift, sb: Shift, clipA: number, clipB: number): number | null {
  const logs: number[] = [];
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 200_000)));
  for (let y = 0; y < h; y += step) {
    const ya = y + sa.dy;
    const yb = y + sb.dy;
    if (ya < 0 || ya >= h || yb < 0 || yb >= h) continue;
    for (let x = 0; x < w; x += step) {
      const xa = x + sa.dx;
      const xb = x + sb.dx;
      if (xa < 0 || xa >= w || xb < 0 || xb >= w) continue;
      const va = a[ya * w + xa]!;
      const vb = b[yb * w + xb]!;
      if (va > RATIO_LO * clipA && va < RATIO_HI * clipA && vb > RATIO_LO * clipB && vb < RATIO_HI * clipB) logs.push(Math.log2(vb / va));
    }
  }
  if (logs.length < 500) return null;
  logs.sort((p, q) => p - q);
  return 2 ** logs[logs.length >> 1]!;
}

/** Relative exposure of a shot from its settings: time x ISO / f-number². */
export function exifExposure(m: { shutter: number; aperture: number; iso: number }): number | null {
  if (!(m.shutter > 0)) return null;
  const n = m.aperture > 0 ? m.aperture : 1;
  const iso = m.iso > 0 ? m.iso : 100;
  return (m.shutter * iso) / (n * n);
}

// ------------------------------------------------------------------------------- ghosts

/** Movement map in reference coordinates: 0 = static, 1 = moved; `block` px per cell. */
export interface GhostMap {
  data: Float32Array;
  bw: number;
  bh: number;
  block: number;
}

/** Stops of disagreement with the reference that count as movement, per deghost setting. */
export const DEGHOST_STOPS = { low: 1, medium: 0.6, high: 0.35 } as const;
export type Deghost = 'off' | keyof typeof DEGHOST_STOPS;

/**
 * Where `img` (relative exposure `e`, at shift `s`) shows something other than the reference:
 * mean log brightness per block, compared where both are well exposed. Planes are the same size;
 * `block` is in their pixels. Grown by one block and softened, so whole objects step back.
 */
export function ghostMap(ref: Float32Array, img: Float32Array, w: number, h: number, s: Shift, e: number, clipRef: number, clipImg: number, stops: number, block = 16): GhostMap {
  const bw = Math.ceil(w / block);
  const bh = Math.ceil(h / block);
  const raw = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let sum = 0;
      let n = 0;
      let total = 0;
      for (let y = by * block; y < Math.min(h, (by + 1) * block); y += 2) {
        const yi = y + s.dy;
        for (let x = bx * block; x < Math.min(w, (bx + 1) * block); x += 2) {
          total++;
          const xi = x + s.dx;
          if (xi < 0 || xi >= w || yi < 0 || yi >= h) continue;
          const vr = ref[y * w + x]!;
          const vi = img[yi * w + xi]!;
          if (vr > WELL_LO * clipRef && vr < WELL_HI * clipRef && vi > WELL_LO * clipImg && vi < WELL_HI * clipImg) {
            sum += Math.log2(vi / e / vr);
            n++;
          }
        }
      }
      raw[by * bw + bx] = n >= Math.max(4, total * 0.25) ? smoothstep(0.7 * stops, 1.3 * stops, Math.abs(sum / n)) : 0;
    }
  }
  // Grow by one block (max), then soften (3 x 3 mean).
  const grown = new Float32Array(bw * bh);
  const soft = new Float32Array(bw * bh);
  for (const [src, dst, op] of [
    [raw, grown, 'max'],
    [grown, soft, 'mean'],
  ] as const) {
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let acc = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const v = src[clampInt(y + dy, 0, bh - 1) * bw + clampInt(x + dx, 0, bw - 1)]!;
            acc = op === 'max' ? Math.max(acc, v) : acc + v;
            n++;
          }
        }
        dst[y * bw + x] = op === 'max' ? acc : acc / n;
      }
    }
  }
  return { data: soft, bw, bh, block };
}

/** The same map for an image `factor` times larger (half-size analysis -> full-size merge). */
export const scaleGhostMap = (g: GhostMap, factor: number): GhostMap => ({ ...g, block: g.block * factor });

/** Bilinear value of a block map at pixel (x, y) (block centres at (i + 0.5) * block). */
function sampleBlocks(data: Float32Array, bw: number, bh: number, block: number, x: number, y: number): number {
  const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / block - 0.5));
  const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / block - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(bw - 1, x0 + 1);
  const y1 = Math.min(bh - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = data[y0 * bw + x0]! + (data[y0 * bw + x1]! - data[y0 * bw + x0]!) * tx;
  const b = data[y1 * bw + x0]! + (data[y1 * bw + x1]! - data[y1 * bw + x0]!) * tx;
  return a + (b - a) * ty;
}

// ------------------------------------------------------------------------------- merging

export interface MergeFrame {
  /** Full-size decode, sensor orientation, same size as the reference. */
  image: Rgb16;
  /** nativeScale of the frame's white balance. */
  k: Vec3;
  /** Brightness relative to the reference frame (2 = one stop brighter). */
  exposure: number;
  /** Native saturation level per channel (clipLevels). */
  clip: Vec3;
  shift: Shift;
  /** Movement against the reference (full-size coordinates); null for the reference itself. */
  ghost: GhostMap | null;
}

/** Share of the clip level where a frame starts to give way to darker ones, and where it is gone. */
const CLIP_FADE = [0.75, 0.92] as const;
/** Clip weights are worked out per block of this many pixels, grown by one block. */
const CLIP_BLOCK = 8;

/**
 * Builds the merged image, one frame at a time from the brightest to the darkest. Output values
 * are reference-native values times `scale` (pick it so the darkest frame's clip level fits in
 * 16 bits), interleaved RGB.
 */
export class HdrMerger {
  readonly out: Uint16Array;
  /** How much of each pixel is still to be filled, 255 = all. */
  private readonly cover: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly scale: number,
  ) {
    this.out = new Uint16Array(width * height * 3);
    this.cover = new Uint8Array(width * height).fill(255);
  }

  /** Weight per block of the frame (its own coordinates): 1 well exposed .. 0 clipped nearby. */
  private clipWeights(f: MergeFrame): { data: Float32Array; bw: number; bh: number } {
    const { width: w, height: h, data } = f.image;
    const bw = Math.ceil(w / CLIP_BLOCK);
    const bh = Math.ceil(h / CLIP_BLOCK);
    const t = new Float32Array(bw * bh);
    const s = [f.k[0] / f.clip[0], f.k[1] / f.clip[1], f.k[2] / f.clip[2]];
    for (let y = 0; y < h; y++) {
      const row = Math.floor(y / CLIP_BLOCK) * bw;
      for (let x = 0, o = y * w * 3; x < w; x++, o += 3) {
        const v = Math.max(data[o]! * s[0]!, data[o + 1]! * s[1]!, data[o + 2]! * s[2]!);
        const b = row + Math.floor(x / CLIP_BLOCK);
        if (v > t[b]!) t[b] = v;
      }
    }
    const w8 = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let m = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) m = Math.max(m, t[clampInt(y + dy, 0, bh - 1) * bw + clampInt(x + dx, 0, bw - 1)]!);
        w8[y * bw + x] = 1 - smoothstep(CLIP_FADE[0], CLIP_FADE[1], m);
      }
    }
    return { data: w8, bw, bh };
  }

  /**
   * Adds the next frame (brightest first). `last`: the darkest, which fills everything that is
   * left. `progress` is awaited every few rows, so the page can update.
   */
  async add(f: MergeFrame, last: boolean, progress?: (fraction: number) => void | Promise<void>): Promise<void> {
    const { width: W, height: H } = this;
    if (f.image.width !== W || f.image.height !== H) throw new Error(`The frames differ in size (${f.image.width}x${f.image.height}, expected ${W}x${H}).`);
    const clipW = last ? null : this.clipWeights(f);
    const src = f.image.data;
    const { out, cover } = this;
    const gain = this.scale / f.exposure;
    const k0 = f.k[0] * gain;
    const k1 = f.k[1] * gain;
    const k2 = f.k[2] * gain;
    const { dx, dy } = f.shift;
    const ghost = last ? null : f.ghost;
    for (let y = 0; y < H; y++) {
      if (progress && (y & 63) === 0) await progress(y / H);
      let sy = y + dy;
      if (sy < 0 || sy >= H) {
        if (!last) continue;
        sy = clampInt(sy, 0, H - 1);
      }
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        const c = cover[p]!;
        if (c === 0) continue;
        let sx = x + dx;
        if (sx < 0 || sx >= W) {
          if (!last) continue;
          sx = clampInt(sx, 0, W - 1);
        }
        let next = 0;
        if (!last) {
          let w = sampleBlocks(clipW!.data, clipW!.bw, clipW!.bh, CLIP_BLOCK, sx, sy);
          if (ghost && w > 0) w *= 1 - sampleBlocks(ghost.data, ghost.bw, ghost.bh, ghost.block, x, y);
          if (w <= 0) continue;
          next = Math.round(c * (1 - w));
          if (next === c) continue;
        }
        const f8 = (c - next) / 255;
        cover[p] = next;
        const o = (sy * W + sx) * 3;
        const q = p * 3;
        // Random rounding (a fixed hash per pixel), so deep shadows don't band.
        const dither = ((Math.imul(p, 0x9e3779b1) >>> 8) & 0xffff) / 65536;
        out[q] = Math.min(65535, out[q]! + f8 * src[o]! * k0 + dither);
        out[q + 1] = Math.min(65535, out[q + 1]! + f8 * src[o + 1]! * k1 + dither);
        out[q + 2] = Math.min(65535, out[q + 2]! + f8 * src[o + 2]! * k2 + dither);
      }
    }
    await progress?.(1);
  }
}
