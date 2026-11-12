// Pixel helpers for the AI masks: resizing, model input tensors, and mapping finished maps
// from the upright analysis image back to the decoded image.
import type { Affine, RgbaImage } from './types.ts';

export const applyAffine = (m: Affine, x: number, y: number): [number, number] => {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
};

/** Inverse of a 3x3 map, scaled so the last element is 1. */
export function invertAffine(m: Affine): Affine {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const inv: Affine = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d];
  const k = Math.abs(inv[8]) > 1e-12 ? inv[8] : det;
  return inv.map((v) => v / k) as Affine;
}

/** Halves an image with a 2x2 box filter. */
function halve(img: RgbaImage): RgbaImage {
  const w = Math.max(1, img.width >> 1);
  const h = Math.max(1, img.height >> 1);
  const out = new Uint8ClampedArray(w * h * 4);
  const W = img.width;
  const s = img.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.min(img.height - 1, 2 * y);
    const y1 = Math.min(img.height - 1, 2 * y + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(W - 1, 2 * x);
      const x1 = Math.min(W - 1, 2 * x + 1);
      for (let c = 0; c < 4; c++) {
        out[(y * w + x) * 4 + c] = (s[(y0 * W + x0) * 4 + c]! + s[(y0 * W + x1) * 4 + c]! + s[(y1 * W + x0) * 4 + c]! + s[(y1 * W + x1) * 4 + c]! + 2) >> 2;
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** Resizes an image to w x h (box-halving first when shrinking a lot, then bilinear). */
export function resizeRgba(img: RgbaImage, w: number, h: number): RgbaImage {
  let src = img;
  while (src.width >= 2 * w && src.height >= 2 * h) src = halve(src);
  if (src.width === w && src.height === h) return src;
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = src.width / w;
  const sy = src.height / h;
  const d = src.data;
  const W = src.width;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(src.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(W - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(W - 1, x0 + 1);
      const tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = d[(y0 * W + x0) * 4 + c]! * (1 - tx) + d[(y0 * W + x1) * 4 + c]! * tx;
        const b = d[(y1 * W + x0) * 4 + c]! * (1 - tx) + d[(y1 * W + x1) * 4 + c]! * tx;
        out[(y * w + x) * 4 + c] = a * (1 - ty) + b * ty;
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** Size that fits in maxSide on the long edge, keeping the aspect ratio. */
export function fitSize(w: number, h: number, maxSide: number): [number, number] {
  const k = Math.min(1, maxSide / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

/** Pixels x0..x1, y0..y1 (clamped to the image) as a new image. */
export function cropRgba(img: RgbaImage, x0: number, y0: number, x1: number, y1: number): RgbaImage {
  const ax = Math.max(0, Math.min(img.width - 1, Math.floor(x0)));
  const ay = Math.max(0, Math.min(img.height - 1, Math.floor(y0)));
  const w = Math.max(1, Math.min(img.width, Math.ceil(x1)) - ax);
  const h = Math.max(1, Math.min(img.height, Math.ceil(y1)) - ay);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(img.data.subarray(((ay + y) * img.width + ax) * 4, ((ay + y) * img.width + ax + w) * 4), y * w * 4);
  return { width: w, height: h, data: out };
}

/**
 * Model input: the image resized to w x h, as planar RGB ((v * scale - mean) / std), placed at
 * the top left of a padW x padH tensor (zeros elsewhere).
 */
export function toTensor(img: RgbaImage, w: number, h: number, mean: readonly number[], std: readonly number[], scale = 1 / 255, padW = w, padH = h): Float32Array {
  const r = resizeRgba(img, w, h);
  const out = new Float32Array(3 * padW * padH);
  const plane = padW * padH;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const o = y * padW + x;
      for (let c = 0; c < 3; c++) out[c * plane + o] = (r.data[i + c]! * scale - mean[c]!) / std[c]!;
    }
  }
  return out;
}

/** Bilinear resize of a single-channel map (pixel centres aligned); values times `scale`. */
export function resizeMap(src: ArrayLike<number>, sw: number, sh: number, dw: number, dh: number, scale = 1): Float32Array {
  const out = new Float32Array(dw * dh);
  const kx = sw / dw;
  const ky = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * ky - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * kx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = fx - x0;
      const a = src[y0 * sw + x0]! * (1 - tx) + src[y0 * sw + x1]! * tx;
      const b = src[y1 * sw + x0]! * (1 - tx) + src[y1 * sw + x1]! * tx;
      out[y * dw + x] = (a * (1 - ty) + b * ty) * scale;
    }
  }
  return out;
}

/** 0..1 floats -> 0..255 bytes. */
export function toBytes(f: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, f[i]!)) * 255);
  return out;
}

/** Brightness 0..1 of each pixel (Rec. 709 weights on the encoded values). */
export function luma(img: RgbaImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) out[i] = (0.2126 * d[i * 4]! + 0.7152 * d[i * 4 + 1]! + 0.0722 * d[i * 4 + 2]!) / 255;
  return out;
}

const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/**
 * Brightens a dark rendering so its brightest 1 % sit near white (at most 3 stops), as the
 * models were trained on well-exposed photos. Bright images are left alone.
 */
export function normalizeBrightness(img: RgbaImage): RgbaImage {
  const hist = new Uint32Array(256);
  const d = img.data;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) hist[Math.round(0.2126 * d[i * 4]! + 0.7152 * d[i * 4 + 1]! + 0.0722 * d[i * 4 + 2]!)]!++;
  let acc = 0;
  let p99 = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!;
    if (acc >= n * 0.99) {
      p99 = v;
      break;
    }
  }
  const gain = Math.min(8, decode(235 / 255) / Math.max(1e-4, decode(Math.max(1, p99) / 255)));
  if (gain <= 1.05) return img;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(encode(Math.min(1, decode(v / 255) * gain)) * 255);
  const out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) {
    out[i] = lut[d[i]!]!;
    out[i + 1] = lut[d[i + 1]!]!;
    out[i + 2] = lut[d[i + 2]!]!;
    out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

/**
 * Turns a map over the upright analysis image (mw x mh) into an rw x rh map over the decoded
 * image. sToT maps decoded-image coordinates (0..1) to the analysis image (0..1).
 */
export function resampleToSource(map: Float32Array, mw: number, mh: number, sToT: Affine, rw: number, rh: number): Uint8Array {
  const out = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const [tx, ty] = applyAffine(sToT, (x + 0.5) / rw, (y + 0.5) / rh);
      if (tx < 0 || ty < 0 || tx > 1 || ty > 1) continue;
      const fx = Math.min(mw - 1, Math.max(0, tx * mw - 0.5));
      const fy = Math.min(mh - 1, Math.max(0, ty * mh - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(mw - 1, x0 + 1);
      const y1 = Math.min(mh - 1, y0 + 1);
      const ax = fx - x0;
      const ay = fy - y0;
      const v = (map[y0 * mw + x0]! * (1 - ax) + map[y0 * mw + x1]! * ax) * (1 - ay) + (map[y1 * mw + x0]! * (1 - ax) + map[y1 * mw + x1]! * ax) * ay;
      out[y * rw + x] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
  return out;
}
