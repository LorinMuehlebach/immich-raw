// WebP, AVIF and JPEG XL encoders (jSquash's WebAssembly builds of libwebp, libavif with libaom,
// and libjxl), each loaded on first use, and the metadata their files carry. An encode blocks
// its thread for seconds at full size, so this runs in a worker (the editor's encode.worker.ts).
//
// AVIF and JPEG XL use their single-threaded builds. The multi-threaded ones start emscripten
// pthread workers that load the bundled encoder chunk again by URL, which a bundler's chunking
// can break; batch exports already encode several photos at once instead.
import { avifCicp, setAvifCicp, type Cicp } from './avif.ts';
import { jxlContainer } from './jxl.ts';
import { WEBP_MAX_SIDE, addWebpMetadata } from './webp.ts';

export type CodecFormat = 'webp' | 'avif' | 'jxl';

export interface CodecJob {
  format: CodecFormat;
  width: number;
  height: number;
  /** RGBA, 8 bits per sample, width * height * 4 values. */
  data: Uint8ClampedArray<ArrayBuffer>;
  /** 0-100. */
  quality: number;
  /** WebP and JPEG XL: lossless instead of `quality`. */
  lossless?: boolean;
  /** EXIF as a TIFF block (buildTiff); WebP and JPEG XL. */
  exif?: Uint8Array;
  /** XMP packet; WebP and JPEG XL. */
  xmp?: string;
  /** ICC profile of the pixels' colour space; WebP only. */
  icc?: Uint8Array;
  /** Colour space of the pixels, for AVIF; sRGB when left out. */
  cicp?: Cicp;
}

export const SRGB_CICP: Cicp = { primaries: 1, transfer: 13 };

interface WasmEncoder {
  encode(data: BufferSource, width: number, height: number, options: object): Uint8Array | null;
}
type Factory = (overrides: object) => Promise<WasmEncoder>;

let avif: Promise<{ module: WasmEncoder; defaults: object }> | null = null;
let jxl: Promise<{ module: WasmEncoder; defaults: object }> | null = null;

function load(factory: Promise<{ default: unknown }>, meta: Promise<{ defaultOptions: unknown }>) {
  return Promise.all([factory, meta]).then(async ([f, m]) => ({
    // As jSquash's initEmscriptenModule: don't run anything in the module before it's called.
    module: await (f.default as Factory)({ noInitialRun: true }),
    defaults: m.defaultOptions as object,
  }));
}

const avifEncoder = () => (avif ??= load(import('@jsquash/avif/codec/enc/avif_enc.js'), import('@jsquash/avif/meta.js')));
const jxlEncoder = () => (jxl ??= load(import('@jsquash/jxl/codec/enc/jxl_enc.js'), import('@jsquash/jxl/meta.js')));

const megapixels = (j: CodecJob) => (j.width * j.height) / 1e6;

/** Speed settings that keep a full-size photo to tens of seconds on one core. */
export function codecOptions(j: CodecJob): Record<string, number | boolean> {
  const mp = megapixels(j);
  const quality = Math.max(0, Math.min(100, Math.round(j.quality)));
  switch (j.format) {
    case 'webp':
      return j.lossless
        ? { lossless: 1, quality: 75, method: mp > 24 ? 2 : 4, exact: 0 }
        : { lossless: 0, quality, method: 4, use_sharp_yuv: 1, exact: 0 };
    case 'avif': {
      // 4:4:4 at high quality, where 4:2:0 would blur colour edges; sharp YUV when subsampling.
      const subsample = quality >= 90 ? 3 : 1;
      return { quality, qualityAlpha: -1, speed: mp > 30 ? 8 : mp > 12 ? 7 : 6, subsample, enableSharpYUV: subsample === 1, bitDepth: 8 };
    }
    case 'jxl':
      return j.lossless
        ? { lossless: true, quality: 100, lossyModular: false, lossyPalette: false, effort: mp > 12 ? 3 : 5 }
        : { lossless: false, quality, effort: mp > 24 ? 5 : 7 };
  }
}

function checkSize(j: CodecJob): void {
  if (j.data.length !== j.width * j.height * 4) throw new Error(`Expected ${j.width} × ${j.height} RGBA pixels.`);
  if (j.format === 'webp' && (j.width > WEBP_MAX_SIDE || j.height > WEBP_MAX_SIDE)) {
    throw new Error(`WebP can't be larger than ${WEBP_MAX_SIDE} pixels a side; this export is ${j.width} × ${j.height}.`);
  }
}

/** The finished file: encoded, with the job's metadata. */
export async function encodeWithCodec(j: CodecJob): Promise<Uint8Array> {
  checkSize(j);
  const opts = codecOptions(j);
  switch (j.format) {
    case 'webp': {
      const { default: encode } = await import('@jsquash/webp/encode');
      const buf = await encode(new ImageData(j.data, j.width, j.height), opts);
      return addWebpMetadata(new Uint8Array(buf), { icc: j.icc, exif: j.exif, xmp: j.xmp });
    }
    case 'avif': {
      const { module, defaults } = await avifEncoder();
      const out = module.encode(new Uint8Array(j.data.buffer, j.data.byteOffset, j.data.byteLength), j.width, j.height, { ...defaults, ...opts });
      if (!out) throw new Error('The AVIF encoder failed.');
      const cicp = j.cicp ?? SRGB_CICP;
      const set = setAvifCicp(out, cicp);
      if (!set.boxes && (cicp.primaries !== 1 || cicp.transfer !== 13)) throw new Error('The AVIF encoder wrote no colour description to set.');
      return set.bytes;
    }
    case 'jxl': {
      const { module, defaults } = await jxlEncoder();
      const out = module.encode(j.data, j.width, j.height, { ...defaults, ...opts });
      if (!out) throw new Error('The JPEG XL encoder failed.');
      return jxlContainer(out, { exif: j.exif, xmp: j.xmp });
    }
  }
}

export { avifCicp };
