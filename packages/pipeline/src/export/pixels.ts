// An export's pixels between the renderer and the encoder: 8 or 16 bits per sample, in the
// colour space the export asked for (encoded with that space's curve).
import { srgb8Converter, type OutputColor, type OutputSpace } from '../color/output-spaces.ts';
import { resample16 } from './resample.ts';
import { resizeImage } from './resize.ts';

export interface Pixels {
  /** RGBA: 0-255 (8 bits) or 0-65535 (16 bits). */
  data: Uint8ClampedArray<ArrayBuffer> | Uint16Array<ArrayBuffer>;
  width: number;
  height: number;
  bits: 8 | 16;
  space: OutputSpace;
}

/** 8-bit sRGB pixels of an ImageData (no copy). */
export function pixelsOf(img: ImageData, space: OutputSpace = 'srgb'): Pixels {
  return { data: img.data as Uint8ClampedArray<ArrayBuffer>, width: img.width, height: img.height, bits: 8, space };
}

/**
 * The 8-bit pixels as an ImageData (no copy). Tagged sRGB whatever their space: a canvas only
 * converts between differently tagged images, so other spaces' values pass through unchanged.
 */
export function asImageData(p: Pixels): ImageData {
  if (p.bits !== 8) throw new Error('asImageData: 8-bit pixels only');
  return new ImageData(p.data as Uint8ClampedArray<ArrayBuffer>, p.width, p.height);
}

/**
 * 8-bit sRGB pixels (a JPEG from the library, say) in another colour space and bit depth. Their
 * colours stay inside sRGB: only a RAW rendered for the space has more.
 */
export function convertPixels(p: Pixels, color: OutputColor): Pixels {
  if (p.space === color.space && p.bits === color.bits) return p;
  if (p.space !== 'srgb' || p.bits !== 8) throw new Error('convertPixels: only from 8-bit sRGB');
  const src = p.data;
  const max = color.bits === 16 ? 65535 : 255;
  const out = color.bits === 16 ? new Uint16Array(src.length) : new Uint8ClampedArray(src.length);
  if (color.space === 'srgb') {
    for (let i = 0; i < src.length; i++) out[i] = src[i]! * 257;
    return { ...p, data: out, bits: color.bits };
  }
  const convert = srgb8Converter(color.space);
  // Photos repeat colours a lot: remember the last few hundred thousand conversions.
  const cache = new Map<number, number>();
  const packed = (v: readonly [number, number, number]) => (Math.round(v[0] * 1023) << 20) | (Math.round(v[1] * 1023) << 10) | Math.round(v[2] * 1023);
  for (let i = 0; i < src.length; i += 4) {
    const key = (src[i]! << 16) | (src[i + 1]! << 8) | src[i + 2]!;
    let v = cache.get(key);
    if (v === undefined) {
      v = packed(convert(src[i]!, src[i + 1]!, src[i + 2]!));
      if (cache.size > 400_000) cache.clear();
      cache.set(key, v);
    }
    out[i] = Math.round((((v >>> 20) & 1023) / 1023) * max);
    out[i + 1] = Math.round((((v >>> 10) & 1023) / 1023) * max);
    out[i + 2] = Math.round(((v & 1023) / 1023) * max);
    out[i + 3] = max;
  }
  return { data: out as Pixels['data'], width: p.width, height: p.height, bits: color.bits, space: color.space };
}

/** The pixels at width x height: the browser's resampling for 8 bits, Lanczos-3 for 16. */
export async function resizePixels(p: Pixels, width: number, height: number): Promise<Pixels> {
  if (width === p.width && height === p.height) return p;
  if (p.bits === 16) {
    const r = resample16({ data: p.data as Uint16Array<ArrayBuffer>, width: p.width, height: p.height }, width, height);
    return { ...p, data: r.data as Uint16Array<ArrayBuffer>, width, height };
  }
  const img = await resizeImage(asImageData(p), width, height);
  return { ...p, data: img.data as Uint8ClampedArray<ArrayBuffer>, width, height };
}
