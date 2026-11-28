// Resizing 16-bit images, which the browser's resampling can't do (createImageBitmap and canvas
// work in 8 bits). Separable Lanczos-3 on the encoded values, widened by the scale factor when
// shrinking so every source pixel counts. The horizontal pass goes into a 16-bit intermediate
// image, the vertical pass one output row at a time.

export interface Rgba16 {
  /** RGBA, 0-65535. */
  data: Uint16Array;
  width: number;
  height: number;
}

const LOBES = 3;

function lanczos(x: number): number {
  if (x === 0) return 1;
  if (x <= -LOBES || x >= LOBES) return 0;
  const px = Math.PI * x;
  return (LOBES * Math.sin(px) * Math.sin(px / LOBES)) / (px * px);
}

/** For each output position: the first source index and `taps` weights (summing to 1). */
export function resampleWeights(src: number, dst: number): { start: Int32Array; taps: number; weights: Float32Array } {
  const scale = src / dst;
  const filterScale = Math.max(1, scale);
  const support = LOBES * filterScale;
  const taps = Math.ceil(support) * 2 + 1;
  const start = new Int32Array(dst);
  const weights = new Float32Array(dst * taps);
  for (let i = 0; i < dst; i++) {
    const centre = (i + 0.5) * scale - 0.5;
    const first = Math.floor(centre - support) + 1;
    start[i] = first;
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      const w = lanczos((first + t - centre) / filterScale);
      weights[i * taps + t] = w;
      sum += w;
    }
    for (let t = 0; t < taps; t++) weights[i * taps + t] = weights[i * taps + t]! / sum;
  }
  return { start, taps, weights };
}

const clamp16 = (v: number) => (v <= 0 ? 0 : v >= 65535 ? 65535 : Math.round(v));

/** The image resized to width x height (alpha set to opaque). Returns the input when the size is the same. */
export function resample16(img: Rgba16, width: number, height: number): Rgba16 {
  if (width === img.width && height === img.height) return img;
  const { data, width: sw, height: sh } = img;
  const h = resampleWeights(sw, width);
  const v = resampleWeights(sh, height);

  // Horizontal: every source row to `width` RGB pixels.
  const mid = new Uint16Array(sh * width * 3);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4;
    const out = y * width * 3;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      const s0 = h.start[x]!;
      const wi = x * h.taps;
      for (let t = 0; t < h.taps; t++) {
        const w = h.weights[wi + t]!;
        if (w === 0) continue;
        const sx = Math.min(sw - 1, Math.max(0, s0 + t));
        const p = row + sx * 4;
        r += w * data[p]!;
        g += w * data[p + 1]!;
        b += w * data[p + 2]!;
      }
      const o = out + x * 3;
      mid[o] = clamp16(r);
      mid[o + 1] = clamp16(g);
      mid[o + 2] = clamp16(b);
    }
  }

  // Vertical: each output row from `taps` intermediate rows.
  const out = new Uint16Array(width * height * 4);
  const acc = new Float64Array(width * 3);
  for (let y = 0; y < height; y++) {
    acc.fill(0);
    const s0 = v.start[y]!;
    const wi = y * v.taps;
    for (let t = 0; t < v.taps; t++) {
      const w = v.weights[wi + t]!;
      if (w === 0) continue;
      const row = Math.min(sh - 1, Math.max(0, s0 + t)) * width * 3;
      for (let i = 0; i < width * 3; i++) acc[i] = acc[i]! + w * mid[row + i]!;
    }
    const o = y * width * 4;
    for (let x = 0; x < width; x++) {
      out[o + x * 4] = clamp16(acc[x * 3]!);
      out[o + x * 4 + 1] = clamp16(acc[x * 3 + 1]!);
      out[o + x * 4 + 2] = clamp16(acc[x * 3 + 2]!);
      out[o + x * 4 + 3] = 65535;
    }
  }
  return { data: out, width, height };
}
