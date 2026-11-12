// Output sharpening for exports, after the final resize: an unsharp mask on luma.
//
// Modelled on Lightroom's Screen / Matte / Glossy x Low / Standard / High. 'screen' is for
// viewing at 1:1 on a display, so the radius is a fixed fraction of an output pixel. On paper
// the radius is a fixed physical size (1 px at 300 ppi, ~0.085 mm), so it grows with the print
// resolution; matte paper soaks up more detail than glossy, so it gets more amount.

export type SharpenMedia = 'screen' | 'matte' | 'glossy';
export type SharpenLevel = 'low' | 'standard' | 'high';

/** Structural type so Node tests (no ImageData) work; ImageData satisfies it. */
export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const SCREEN_RADIUS = 0.6;
const PAPER_RADIUS_AT_300_PPI = 1;
const MIN_RADIUS = 0.5;
const MAX_RADIUS = 3;
const DEFAULT_PPI = 300;
const AMOUNT: Record<SharpenMedia, number> = { screen: 0.6, matte: 1, glossy: 0.7 };
const LEVEL: Record<SharpenLevel, number> = { low: 0.6, standard: 1, high: 1.5 };
/** Luma detail below this is left alone (noise, JPEG grain); full strength from twice this. */
const THRESHOLD = 2;

// Rec. 709 luma weights
const KR = 0.2126;
const KG = 0.7152;
const KB = 0.0722;

/** Unsharp-mask parameters for an output medium: radius in output pixels, amount (0..~1.5), threshold (0..255 luma units). */
export function sharpenParams(media: SharpenMedia, level: SharpenLevel, ppi: number): { radius: number; amount: number; threshold: number } {
  const amount = AMOUNT[media] * LEVEL[level];
  if (media === 'screen') return { radius: SCREEN_RADIUS, amount, threshold: THRESHOLD };
  const p = Number.isFinite(ppi) && ppi > 0 ? ppi : DEFAULT_PPI;
  const radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, (p / 300) * PAPER_RADIUS_AT_300_PPI));
  return { radius, amount, threshold: THRESHOLD };
}

/** Sharpens in place: unsharp mask on luma only (apply the same luma delta to R, G, B so colours don't shift), alpha untouched. */
export function outputSharpen(img: RgbaImage, media: SharpenMedia, level: SharpenLevel, ppi: number): void {
  const { data, width: w, height: h } = img;
  if (w < 3 || h < 3) return;
  const { radius, amount, threshold } = sharpenParams(media, level, ppi);
  if (!(amount > 0)) return;
  const k = gaussianHalfKernel(radius);
  const r = k.length - 1;
  const k0 = k[0];

  // Horizontal pass: each row's luma, padded by repeating the edge pixels, blurred into `hblur`.
  // This is the only full-size plane; the vertical pass works one row at a time.
  const hblur = new Float32Array(w * h);
  const row = new Float32Array(w + 2 * r);
  for (let y = 0; y < h; y++) {
    for (let x = 0, p = y * w * 4; x < w; x++, p += 4) row[x + r] = KR * data[p] + KG * data[p + 1] + KB * data[p + 2];
    const first = row[r];
    const last = row[r + w - 1];
    for (let i = 0; i < r; i++) {
      row[i] = first;
      row[r + w + i] = last;
    }
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const c = x + r;
      let s = k0 * row[c];
      for (let i = 1; i <= r; i++) s += k[i] * (row[c - i] + row[c + i]);
      hblur[o + x] = s;
    }
  }

  // Vertical pass per row (edge rows repeated), then add the luma detail to R, G and B.
  // The pixel's own luma is recomputed from its still-unmodified RGB.
  const blur = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) blur[x] = k0 * hblur[o + x];
    for (let i = 1; i <= r; i++) {
      const a = Math.max(0, y - i) * w;
      const b = Math.min(h - 1, y + i) * w;
      const ki = k[i];
      for (let x = 0; x < w; x++) blur[x] += ki * (hblur[a + x] + hblur[b + x]);
    }
    for (let x = 0, p = o * 4; x < w; x++, p += 4) {
      const R = data[p];
      const G = data[p + 1];
      const B = data[p + 2];
      let d = KR * R + KG * G + KB * B - blur[x];
      const ad = Math.abs(d);
      if (ad <= threshold) continue;
      if (ad < 2 * threshold) d *= (ad - threshold) / threshold;
      d *= amount;
      // Uint8ClampedArray rounds and clamps.
      data[p] = R + d;
      data[p + 1] = G + d;
      data[p + 2] = B + d;
    }
  }
}

/** One half of a normalised Gaussian kernel (index 0 is the centre), truncated at 3 sigma. */
function gaussianHalfKernel(sigma: number): Float64Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(r + 1);
  let sum = 0;
  for (let i = 0; i <= r; i++) {
    k[i] = Math.exp((-i * i) / (2 * sigma * sigma));
    sum += i === 0 ? k[i] : 2 * k[i];
  }
  for (let i = 0; i <= r; i++) k[i] /= sum;
  return k;
}
