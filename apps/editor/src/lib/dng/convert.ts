// Convert to DNG: builds a DNG from the original RAW in the browser and checks it.
//
// Lossless keeps the sensor mosaic exactly (lossless JPEG tiles). Lossy stores a demosaiced
// image as 8-bit JPEG tiles behind a linearisation curve (Adobe's lossy DNG), about a
// quarter of the size. Either way the result is decoded again with LibRaw and compared
// with the original before anyone gets to delete the original.
import { RawSession, decodeBest, readExtraMeta, readSensor, type LinearImage, type RawMeta } from '@immich-raw/decoder';
import { assembleDng, tileLayout, type DngMetadata } from '@immich-raw/dng';
import { readDngCarryOver } from '@immich-raw/lens';
import { encodeJpeg } from '@immich-raw/pipeline';
import type { WorkerJob, WorkerReply } from './dng.worker.ts';

export type DngMode = 'lossless' | 'lossy';
export const LOSSY_QUALITY = 0.92;
/** Long side of the preview JPEG inside the DNG (Immich's preview is 1440 px). */
const PREVIEW_SIZE = 2048;
const THUMB_SIZE = 256;

/** The parts of Immich's exifInfo the DNG gets. */
export interface SourceExif {
  dateTimeOriginal?: string | null;
  timeZone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  make?: string | null;
  model?: string | null;
  lensModel?: string | null;
  fNumber?: number | null;
  iso?: number | null;
  focalLength?: number | null;
}

export interface BuildOptions {
  bytes: Uint8Array;
  fileName: string;
  mode: DngMode;
  exif: SourceExif | null | undefined;
  software: string;
  /** The photo with default settings, in sensor orientation (the DNG's previews are stored unrotated). */
  preview: () => Promise<ImageData>;
  /** The editor's half-size decode of the original, to check the DNG against. */
  reference: { image: LinearImage; meta: RawMeta };
  /** The editor's full-resolution decode (AHD), used for lossy DNGs of Bayer files. */
  full: () => Promise<LinearImage>;
  onProgress?: (label: string, fraction: number) => void;
}

export interface Verification {
  ok: boolean;
  /** Plain-language result for the dialog. */
  text: string;
}

export interface BuiltDng {
  bytes: Uint8Array;
  fileName: string;
  width: number;
  height: number;
  verification: Verification;
}

export async function buildDng(opts: BuildOptions): Promise<BuiltDng> {
  const progress = opts.onProgress ?? (() => {});
  const { meta } = opts.reference;
  const isDng = /\.dng$/i.test(opts.fileName);
  const carry = isDng ? readDngCarryOver(opts.bytes) : null;

  let tiles: Uint8Array[];
  let raw: Parameters<typeof assembleDng>[1];
  let extra: { defaultCrop: { x: number; y: number; width: number; height: number } | null; lensMake: string; bodySerial: string };

  if (opts.mode === 'lossless') {
    progress('Reading the sensor data', 0);
    const sensor = await readSensor(opts.bytes);
    extra = { defaultCrop: sensor.defaultCrop, lensMake: sensor.lensMake, bodySerial: sensor.bodySerial };
    const shared = toShared(sensor.data);
    raw = {
      kind: 'cfa',
      width: sensor.width,
      height: sensor.height,
      patternWidth: sensor.patternWidth,
      patternHeight: sensor.patternHeight,
      pattern: sensor.pattern,
      black: sensor.black,
      white: sensor.white,
    };
    const { count } = tileLayout(sensor.width, sensor.height);
    tiles = await encodeTiles({ type: 'cfa', data: shared, width: sensor.width, height: sensor.height, patternWidth: sensor.patternWidth }, count, (f) =>
      progress('Compressing', f),
    );
  } else {
    let image: LinearImage | null = null;
    extra = { defaultCrop: null, lensMake: '', bodySerial: '' };
    if (meta.isXTrans) {
      // X-Trans: the 3-pass demosaic is clearly better than the editor's 1-pass one.
      progress('Demosaicing at best quality', 0);
      try {
        const best = await decodeBest(opts.bytes);
        extra = { defaultCrop: best.defaultCrop, lensMake: best.lensMake, bodySerial: best.bodySerial };
        image = best.image;
      } catch (e) {
        console.warn("Best-quality demosaic failed, using the editor's decode", e);
      }
    }
    if (!image) {
      progress('Reading the full-resolution image', 0);
      extra = await readExtraMeta(opts.bytes);
      image = await opts.full();
    }
    const best = { image };
    const { width, height } = best.image;
    // LibRaw scaled channel c by mul_c / max(mul) (white balance, nothing clipped); the DNG
    // stores camera-native values, so undo that.
    const mul = normMul(meta.camMul);
    const mx = Math.max(...mul);
    const k = mul.map((m) => mx / m);
    const shared = new Uint16Array(new SharedArrayBuffer(width * height * 3 * 2));
    const src = best.image.data;
    for (let i = 0; i < src.length; i += 3) {
      shared[i] = Math.min(65535, Math.round(src[i]! * k[0]!));
      shared[i + 1] = Math.min(65535, Math.round(src[i + 1]! * k[1]!));
      shared[i + 2] = Math.min(65535, Math.round(src[i + 2]! * k[2]!));
    }
    raw = { kind: 'linear', width, height };
    const { count } = tileLayout(width, height);
    tiles = await encodeTiles({ type: 'linear', data: shared, width, height, quality: LOSSY_QUALITY }, count, (f) => progress('Compressing', f));
  }

  progress('Making the preview', 0);
  const { preview, thumbnail } = await makePreviews(await opts.preview());

  progress('Writing the DNG', 0);
  const dngMeta = dngMetadata(opts, meta, extra, carry, preview, thumbnail);
  const bytes = assembleDng(dngMeta, raw, tiles);

  progress('Checking the DNG', 0);
  const verification = await verify(bytes, opts.reference, opts.mode);
  return { bytes, fileName: dngFileName(opts.fileName), width: raw.width, height: raw.height, verification };
}

export function dngFileName(original: string): string {
  const dot = original.lastIndexOf('.');
  return `${dot > 0 ? original.slice(0, dot) : original}.dng`;
}

const normMul = (m: number[]): [number, number, number] => {
  const g = m[1] || 1;
  return [m[0]! / g, 1, m[2]! / g];
};

function toShared(data: Uint16Array): Uint16Array {
  const out = new Uint16Array(new SharedArrayBuffer(data.byteLength));
  out.set(data);
  return out;
}

/** LibRaw flip -> TIFF Orientation. */
export function tiffOrientation(flip: number): number {
  return ({ 0: 1, 1: 2, 2: 4, 3: 3, 4: 5, 5: 8, 6: 6, 7: 7 } as Record<number, number>)[flip] ?? 1;
}

type JobWithoutTiles = WorkerJob extends infer J ? (J extends WorkerJob ? Omit<J, 'tiles'> : never) : never;

/** Encodes all tiles on a pool of workers sharing the image. */
function encodeTiles(job: JobWithoutTiles, count: number, onProgress: (f: number) => void): Promise<Uint8Array[]> {
  const out: Uint8Array[] = new Array(count);
  const workers = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1, count));
  const batch = 6;
  let next = 0;
  let done = 0;
  const pool: Worker[] = [];
  return new Promise<Uint8Array[]>((resolve, reject) => {
    let finished = 0;
    let failed = false;
    const fail = (e: Error) => {
      if (failed) return;
      failed = true;
      for (const w of pool) w.terminate();
      reject(e);
    };
    for (let i = 0; i < workers; i++) {
      const w = new Worker(new URL('./dng.worker.ts', import.meta.url), { type: 'module' });
      pool.push(w);
      const give = () => {
        if (next >= count) {
          w.terminate();
          if (++finished === workers) resolve(out);
          return;
        }
        const tiles: number[] = [];
        for (; tiles.length < batch && next < count; next++) tiles.push(next);
        w.postMessage({ ...job, tiles } as WorkerJob);
      };
      w.onmessage = (e: MessageEvent<WorkerReply>) => {
        const m = e.data;
        if (m.type === 'tile') {
          out[m.index] = m.bytes;
          onProgress(++done / count);
        } else if (m.type === 'done') give();
        else fail(new Error(m.message));
      };
      w.onerror = (e) => fail(new Error(e.message || 'A compression worker failed.'));
      give();
    }
  });
}

async function makePreviews(img: ImageData): Promise<{ preview: DngMetadata['preview']; thumbnail: DngMetadata['thumbnail'] }> {
  const scaled = async (max: number) => {
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * s));
    const h = Math.max(1, Math.round(img.height * s));
    const bmp = await createImageBitmap(img, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return ctx.getImageData(0, 0, w, h);
  };
  const big = await scaled(PREVIEW_SIZE);
  const jpeg = await encodeJpeg(big, 0.85);
  const small = await scaled(THUMB_SIZE);
  const rgb = new Uint8Array(small.width * small.height * 3);
  for (let i = 0, j = 0; i < small.data.length; i += 4, j += 3) {
    rgb[j] = small.data[i]!;
    rgb[j + 1] = small.data[i + 1]!;
    rgb[j + 2] = small.data[i + 2]!;
  }
  return { preview: { width: big.width, height: big.height, jpeg }, thumbnail: { width: small.width, height: small.height, rgb } };
}

/** Immich's UTC date + time zone -> EXIF local date, sub-seconds and offset. */
export function exifDate(iso: string | null | undefined, timeZone: string | null | undefined): { date?: string; subSec?: string; offset?: string } {
  if (!iso) return {};
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return {};
  let off: number | null = null;
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(d);
      const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
      const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
      off = name === 'GMT' ? 0 : m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : null;
    } catch {
      off = null;
    }
  }
  // Without a zone Immich keeps the camera's local time as if it were UTC.
  const local = new Date(d.getTime() + (off ?? 0) * 60_000).toISOString();
  const date = `${local.slice(0, 4)}:${local.slice(5, 7)}:${local.slice(8, 10)} ${local.slice(11, 19)}`;
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = off === null ? undefined : `${off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return { date, subSec: local.slice(20, 23), offset };
}

const exifStamp = (d: Date) => {
  const s = d.toISOString();
  return `${s.slice(0, 4)}:${s.slice(5, 7)}:${s.slice(8, 10)} ${s.slice(11, 19)}`;
};

function dngMetadata(
  opts: BuildOptions,
  meta: RawMeta,
  extra: { defaultCrop: DngMetadata['defaultCrop'] | null; lensMake: string; bodySerial: string },
  carry: ReturnType<typeof readDngCarryOver>,
  preview: DngMetadata['preview'],
  thumbnail: DngMetadata['thumbnail'],
): DngMetadata {
  const ex = opts.exif ?? {};
  const mul = normMul(meta.camMul);
  const camXyz = meta.camXyz.slice(0, 3).flatMap((r) => r.slice(0, 3));
  const date = exifDate(ex.dateTimeOriginal, ex.timeZone);
  const make = (ex.make || meta.make).trim();
  const model = (ex.model || meta.model).trim();
  const m: DngMetadata = {
    make,
    model,
    uniqueCameraModel: `${meta.make} ${meta.model}`.trim(),
    software: opts.software,
    orientation: tiffOrientation(meta.flip),
    // A DNG original brings its own (dual-illuminant) matrices; otherwise LibRaw's D65 one.
    colorMatrix1: carry?.colorMatrix1 ?? camXyz,
    calibrationIlluminant1: carry?.colorMatrix1 ? (carry.calibrationIlluminant1 ?? 21) : 21,
    asShotNeutral: [1 / mul[0], 1, 1 / mul[2]],
    originalRawFileName: opts.fileName,
    dateTime: exifStamp(new Date()),
    exif: {
      dateTimeOriginal: date.date,
      subSecTimeOriginal: date.subSec,
      offsetTimeOriginal: date.offset,
      exposureTime: meta.shutter > 0 ? meta.shutter : undefined,
      fNumber: meta.aperture > 0 ? meta.aperture : (ex.fNumber ?? undefined),
      iso: meta.iso > 0 ? meta.iso : (ex.iso ?? undefined),
      focalLength: meta.focalLength > 0 ? meta.focalLength : (ex.focalLength ?? undefined),
      lensMake: extra.lensMake || undefined,
      lensModel: (meta.lens || ex.lensModel || '').trim() || undefined,
      bodySerialNumber: extra.bodySerial || undefined,
    },
    preview,
    thumbnail,
  };
  if (extra.defaultCrop) m.defaultCrop = extra.defaultCrop;
  if (typeof ex.latitude === 'number' && typeof ex.longitude === 'number') m.gps = { latitude: ex.latitude, longitude: ex.longitude };
  if (carry) {
    if (carry.colorMatrix2) {
      m.colorMatrix2 = carry.colorMatrix2;
      m.calibrationIlluminant2 = carry.calibrationIlluminant2 ?? 21;
    }
    if (carry.forwardMatrix1) m.forwardMatrix1 = carry.forwardMatrix1;
    if (carry.forwardMatrix2) m.forwardMatrix2 = carry.forwardMatrix2;
    if (carry.baselineExposure !== undefined) m.baselineExposure = carry.baselineExposure;
    // Lens corrections (WarpRectilinear, vignetting) are relative to the active area and
    // normalised, so they still fit. List 1 works on the stored image incl. masked borders,
    // which we don't keep, so it only comes along when there were none.
    if (carry.opcodeList3) m.opcodeList3 = carry.opcodeList3;
    if (carry.opcodeList2 && opts.mode === 'lossless') m.opcodeList2 = carry.opcodeList2;
    if (carry.opcodeList1 && opts.mode === 'lossless' && carry.activeAreaOrigin[0] === 0 && carry.activeAreaOrigin[1] === 0) m.opcodeList1 = carry.opcodeList1;
  }
  return m;
}

/**
 * Decodes the DNG with LibRaw (as the editor will) and compares it with the original's
 * half-size decode. Lossless must match to the last bit (give or take rounding of the
 * white balance); lossy must match closely except at fine edges.
 */
async function verify(bytes: Uint8Array, ref: { image: LinearImage; meta: RawMeta }, mode: DngMode): Promise<Verification> {
  let session: RawSession;
  try {
    session = await RawSession.open(bytes);
  } catch (e) {
    return { ok: false, text: `The DNG could not be decoded: ${e instanceof Error ? e.message : String(e)}` };
  }
  const a = ref.image;
  const b = session.half;
  const m = session.meta;
  // LibRaw rounds odd sizes down to even in half-size mode (Canon R5: 8191 vs 8190), and a
  // demosaiced DNG reports the full decode's size, so allow a pixel or two.
  if (Math.abs(m.width - ref.meta.width) > 2 || Math.abs(m.height - ref.meta.height) > 2 || m.flip !== ref.meta.flip) {
    return { ok: false, text: `The DNG has a different size or orientation (${m.width}x${m.height}, flip ${m.flip}).` };
  }
  const ma = normMul(ref.meta.camMul);
  const mb = normMul(m.camMul);
  if (Math.abs(ma[0] / mb[0] - 1) > 0.01 || Math.abs(ma[2] / mb[2] - 1) > 0.01) return { ok: false, text: 'The DNG has a different white balance.' };

  if (mode === 'lossless') {
    if (a.width !== b.width || a.height !== b.height) return { ok: false, text: 'The DNG decodes to a different size.' };
    let off = 0;
    let maxDiff = 0;
    for (let i = 0; i < a.data.length; i++) {
      const d = Math.abs(a.data[i]! - b.data[i]!);
      if (d > 2) off++;
      if (d > maxDiff) maxDiff = d;
    }
    const share = off / a.data.length;
    if (share > 1e-4) return { ok: false, text: `The DNG differs from the original in ${(share * 100).toFixed(2)} % of the pixels.` };
    return { ok: true, text: maxDiff === 0 ? 'Decodes identically to the original.' : 'Decodes the same as the original (rounding differences only).' };
  }

  // Lossy: compare 3x3 averages on a grid, in EV, ignoring near-black.
  const errs: number[] = [];
  const avg = (img: LinearImage, x: number, y: number, c: number) => {
    const cx = Math.min(img.width - 2, Math.max(1, Math.round(x * img.width)));
    const cy = Math.min(img.height - 2, Math.max(1, Math.round(y * img.height)));
    let s = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += img.data[((cy + dy) * img.width + cx + dx) * 3 + c]!;
    return s / 9;
  };
  for (let gy = 0; gy < 160; gy++) {
    for (let gx = 0; gx < 240; gx++) {
      const x = (gx + 0.5) / 240;
      const y = (gy + 0.5) / 160;
      for (let c = 0; c < 3; c++) {
        const va = avg(a, x, y, c);
        const vb = avg(b, x, y, c);
        if (va < 400 && vb < 400) continue;
        errs.push(Math.abs(Math.log2((va + 64) / (vb + 64))));
      }
    }
  }
  if (errs.length < 1000) return { ok: true, text: 'Decodes fine (the photo is too dark to compare in detail).' };
  errs.sort((p, q) => p - q);
  const median = errs[Math.floor(errs.length / 2)]!;
  const p95 = errs[Math.floor(errs.length * 0.95)]!;
  const ok = median < 0.03 && p95 < 0.25;
  return {
    ok,
    text: ok
      ? `Decodes like the original: typical difference ${(median * 100).toFixed(1)} % of a stop.`
      : `The DNG differs too much from the original (typical ${median.toFixed(3)} EV, 95 % within ${p95.toFixed(2)} EV).`,
  };
}
