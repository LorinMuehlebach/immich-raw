// Developed photos (JPEG, PNG, WebP, AVIF, HEIC in Safari, ...), decoded by the browser. The
// renderer takes linear camera RGB, so such a photo goes in as linear sRGB from a "camera" that
// records sRGB: identity camera matrix, neutral multipliers, nothing to reconstruct. With the
// starting settings for these photos (no profile curve, no sharpening), it shows as it is.
import { XYZ_TO_SRGB } from './color.ts';
import { halve } from './libraw.ts';
import type { DecoderInfo, LinearImage, PhotoSession, RawMeta } from './types.ts';

export const IMAGE_DECODER: DecoderInfo = { name: 'browser', version: '1', libraw: '', demosaic: 'none' };

/** The EXIF fields Immich reports for a photo (AssetResponseDto.exifInfo) that the editor uses. */
export interface ImageExif {
  make?: string | null;
  model?: string | null;
  lensModel?: string | null;
  iso?: number | null;
  /** "1/250" or "0.5". */
  exposureTime?: string | null;
  fNumber?: number | null;
  focalLength?: number | null;
}

/** 8-bit sRGB value -> linear 0..65535. */
export const SRGB_TO_LINEAR16: Uint16Array = (() => {
  const lut = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    const lin = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    lut[i] = Math.round(lin * 65535);
  }
  return lut;
})();

/** RGBA rows (as getImageData returns them) into linear RGB16 at `out`, starting at pixel `offset`. */
export function linearFromRgba(rgba: Uint8ClampedArray | Uint8Array, out: Uint16Array, offset = 0): void {
  const lut = SRGB_TO_LINEAR16;
  const n = rgba.length >> 2;
  let o = offset * 3;
  for (let i = 0; i < n; i++) {
    const s = i << 2;
    out[o++] = lut[rgba[s]!]!;
    out[o++] = lut[rgba[s + 1]!]!;
    out[o++] = lut[rgba[s + 2]!]!;
  }
}

/** Seconds from EXIF's "1/250" or "0.5"; 0 when unknown. */
export function exposureSeconds(v: string | null | undefined): number {
  if (!v) return 0;
  const m = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(v);
  const s = m ? Number(m[1]) / Number(m[2]) : Number(v);
  return Number.isFinite(s) && s > 0 ? s : 0;
}

/** The metadata of a developed photo of `width` x `height` (already upright). */
export function imageMeta(width: number, height: number, exif?: ImageExif | null): RawMeta {
  return {
    width,
    height,
    flip: 0,
    camMul: [1, 1, 1, 1],
    preMul: [1, 1, 1, 1],
    rgbCam: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
    ],
    camXyz: [...XYZ_TO_SRGB.map((r) => [...r]), [0, 0, 0]],
    black: 0,
    maximum: 65535,
    baselineExposure: 0,
    isXTrans: false,
    make: exif?.make?.trim() ?? '',
    model: exif?.model?.trim() ?? '',
    lens: exif?.lensModel?.trim() ?? '',
    iso: exif?.iso ?? 0,
    shutter: exposureSeconds(exif?.exposureTime),
    aperture: exif?.fNumber ?? 0,
    focalLength: exif?.focalLength ?? 0,
    rendered: true,
  };
}

/** Rows read from the canvas at a time: keeps the 8-bit copy small next to the 16-bit image. */
const BAND_ROWS = 256;

export class ImageSession implements PhotoSession {
  readonly meta: RawMeta;
  readonly half: LinearImage;
  readonly decoder = IMAGE_DECODER;
  readonly fullStarted = true;
  private readonly image: LinearImage;

  private constructor(meta: RawMeta, full: LinearImage) {
    this.meta = meta;
    this.image = full;
    this.half = halve(full);
  }

  /** From decoded pixels (linear RGB16, upright); open() reads a file into these. */
  static fromLinear(full: Omit<LinearImage, 'halfSize'>, exif?: ImageExif | null): ImageSession {
    return new ImageSession(imageMeta(full.width, full.height, exif), { ...full, halfSize: false });
  }

  /**
   * Decodes `blob` with the browser (EXIF orientation applied, colours converted to sRGB).
   * Throws when the browser can't read the format (e.g. HEIC outside Safari, TIFF).
   */
  static async open(blob: Blob, exif?: ImageExif | null): Promise<ImageSession> {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    try {
      const { width, height } = bitmap;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('No 2D canvas to read the photo with.');
      ctx.drawImage(bitmap, 0, 0);
      const data = new Uint16Array(width * height * 3);
      for (let y = 0; y < height; y += BAND_ROWS) {
        const rows = Math.min(BAND_ROWS, height - y);
        linearFromRgba(ctx.getImageData(0, y, width, rows).data, data, y * width);
      }
      return ImageSession.fromLinear({ width, height, data }, exif);
    } finally {
      bitmap.close();
    }
  }

  full(): Promise<LinearImage> {
    return Promise.resolve(this.image);
  }

  close(): void {}
}
