// Merge to HDR, end to end in the browser: reads the bracket's RAWs, measures them at half size
// (exposures, alignment, movement), merges them at full size (merge.ts), writes a 16-bit linear
// DNG and decodes it again to check it. Nothing is uploaded here (save.ts does that).
//
// Memory: the full-size work holds the merged image (6 bytes per pixel), one decoded frame
// (6 bytes) and two 1-byte maps, plus the decoder's own peak while a frame decodes.
import type { AssetResponseDto } from '@immich/sdk';
import { RawSession, decodeFull, readExtraMeta, type LinearImage, type RawMeta } from '@immich-raw/decoder';
import { assembleDng, type DngMetadata } from '@immich-raw/dng';
import { readDngCarryOver } from '@immich-raw/lens';
import { encodeTiles, exifDate, exifStamp, makePreviews, normMul, tiffOrientation, type SourceExif, type Verification } from '../dng/convert.ts';
import {
  DEGHOST_STOPS,
  HdrMerger,
  alignMtb,
  clipLevels,
  exifExposure,
  exposureRatio,
  ghostMap,
  greenPlane,
  mtbCodesOf,
  nativeScale,
  refineShift,
  scaleGhostMap,
  type Deghost,
  type GhostMap,
  type Shift,
  type Vec3,
} from './merge.ts';

export interface BracketFrame {
  asset: AssetResponseDto;
  /** The editor's session when this is the open photo: its decodes are reused. */
  session?: RawSession | null;
}

export interface HdrBuildOptions {
  frames: BracketFrame[];
  align: boolean;
  deghost: Deghost;
  software: string;
  download: (asset: AssetResponseDto, onProgress: (fraction: number) => void, signal?: AbortSignal) => Promise<Uint8Array>;
  /**
   * The merged photo with its starting settings, in sensor orientation (the DNG's previews are
   * stored like its raw data). `meta`: the merged photo's, as the editor will read it from the DNG.
   */
  preview: (half: LinearImage, meta: RawMeta) => Promise<ImageData>;
  onProgress?: (label: string, fraction: number) => void;
  signal?: AbortSignal;
}

export interface HdrFrameInfo {
  id: string;
  fileName: string;
  /** Stops relative to the reference shot. */
  ev: number;
  /** Measured from the pixels (true) or taken from the camera settings. */
  measured: boolean;
  /** Full-size pixels: this frame's (x + dx, y + dy) is the merged photo's (x, y). */
  shift: Shift;
}

export interface BuiltHdr {
  bytes: Uint8Array;
  fileName: string;
  width: number;
  height: number;
  reference: AssetResponseDto;
  frames: HdrFrameInfo[];
  /** Stops the merged range reaches beyond the reference shot's clipping point. */
  headroom: number;
  verification: Verification;
}

/** Long side of the half-size images alignment searches up to this share of (camera shake). */
const MAX_SHIFT_SHARE = 0.03;
/**
 * Measured exposure steps further than this (stops) from the camera's settings are not trusted:
 * real shutter speeds are off their nominal values by a few hundredths of a stop, not more.
 */
const TRUST_STOPS = 0.5;

/** `DSC01234.ARW` -> `DSC01234-HDR.dng`. */
export function hdrFileName(original: string): string {
  const dot = original.lastIndexOf('.');
  return `${dot > 0 ? original.slice(0, dot) : original}-HDR.dng`;
}

interface Analysed {
  asset: AssetResponseDto;
  bytes: Uint8Array;
  session: RawSession | null;
  meta: RawMeta;
  k: Vec3;
  /** At half size. */
  clip: Vec3;
  plane: Float32Array | null;
  /** Size of the plane (the half-size decode). */
  pw: number;
  ph: number;
  exif: number;
  halfShift: Shift;
  exposure: number;
  measured: boolean;
  ghost: GhostMap | null;
}

const aborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('Merging was stopped.', 'AbortError');
};

/** Lets the page paint between long loops. */
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function buildHdr(opts: HdrBuildOptions): Promise<BuiltHdr> {
  const progress = opts.onProgress ?? (() => {});
  const { signal } = opts;
  const n = opts.frames.length;
  if (n < 2) throw new Error('Merging needs at least two photos.');

  // 1. The originals (from the browser's cache when they are there).
  const bytes: Uint8Array[] = [];
  for (const [i, f] of opts.frames.entries()) {
    aborted(signal);
    bytes.push(await opts.download(f.asset, (x) => progress(`Reading ${f.asset.originalFileName}`, (i + x) / n), signal));
  }

  // 2. Half size: exposures, clipping, alignment, movement.
  const frames: Analysed[] = [];
  for (const [i, f] of opts.frames.entries()) {
    aborted(signal);
    progress(`Measuring ${f.asset.originalFileName}`, i / n);
    const session = f.session ?? (await RawSession.open(bytes[i]!, undefined, signal));
    const { meta, half } = session;
    const first = frames[0];
    if (first && (meta.width !== first.meta.width || meta.height !== first.meta.height || meta.flip !== first.meta.flip)) {
      throw new Error(`${f.asset.originalFileName} has another size or orientation than ${first.asset.originalFileName}.`);
    }
    const exif = exifExposure(meta);
    if (!exif) throw new Error(`${f.asset.originalFileName} has no shutter speed in its metadata.`);
    const k = nativeScale(meta.camMul);
    frames.push({
      asset: f.asset,
      bytes: bytes[i]!,
      session: f.session ?? null,
      meta,
      k,
      clip: clipLevels(half, k),
      plane: greenPlane(half, k),
      pw: half.width,
      ph: half.height,
      exif,
      halfShift: { dx: 0, dy: 0 },
      exposure: 1,
      measured: false,
      ghost: null,
    });
    if (!f.session) session.close();
    await breathe();
  }
  const planeW = frames[0]!.pw;
  const planeH = frames[0]!.ph;
  if (!frames.every((f) => f.pw === planeW && f.ph === planeH)) throw new Error('The photos decode to different sizes.');

  // The reference: the middle exposure.
  const byEv = [...frames].sort((a, b) => a.exif - b.exif);
  const ref = byEv[(byEv.length - 1) >> 1]!;

  if (opts.align) {
    const maxShift = Math.max(8, Math.round(MAX_SHIFT_SHARE * Math.max(planeW, planeH)));
    for (const [i, f] of frames.entries()) {
      if (f === ref) continue;
      aborted(signal);
      progress('Aligning', i / n);
      f.halfShift = alignMtb(ref.plane!, f.plane!, planeW, planeH, maxShift);
      await breathe();
    }
  }

  // Exposures: step by step from the reference, each step measured between neighbours.
  const at = byEv.indexOf(ref);
  const step = (from: Analysed, to: Analysed) => {
    const camera = to.exif / from.exif;
    const r = exposureRatio(from.plane!, to.plane!, planeW, planeH, from.halfShift, to.halfShift, from.clip[1], to.clip[1]);
    const trusted = r !== null && Math.abs(Math.log2(r / camera)) <= TRUST_STOPS;
    to.exposure = from.exposure * (trusted ? r : camera);
    to.measured = trusted;
  };
  ref.measured = true;
  for (let i = at + 1; i < byEv.length; i++) step(byEv[i - 1]!, byEv[i]!);
  for (let i = at - 1; i >= 0; i--) step(byEv[i + 1]!, byEv[i]!);

  if (opts.deghost !== 'off') {
    for (const f of frames) {
      if (f === ref) continue;
      aborted(signal);
      progress('Looking for movement', 0);
      f.ghost = scaleGhostMap(ghostMap(ref.plane!, f.plane!, planeW, planeH, f.halfShift, f.exposure, ref.clip[1], f.clip[1], DEGHOST_STOPS[opts.deghost]), 2);
      await breathe();
    }
  }
  for (const f of frames) f.plane = null;

  // 3. Full size, brightest first.
  const order = [...frames].sort((a, b) => b.exposure - a.exposure);
  const darkest = order[order.length - 1]!;
  // The darkest frame's clip level fills the 16 bits. (With room to spare LibRaw would treat the
  // top value as the white level anyway: its adjust_maximum.)
  const scale = 65535 / (Math.max(...darkest.clip) / darkest.exposure);
  let merger: HdrMerger | null = null;
  let prevCodes: Uint8Array | null = null;
  let prevShift: Shift = { dx: 0, dy: 0 };
  let prevGuess: Shift = { dx: 0, dy: 0 };
  const finalShift = new Map<Analysed, Shift>();
  for (const [j, f] of order.entries()) {
    aborted(signal);
    const label = `Merging ${f.asset.originalFileName} (${j + 1} of ${n})`;
    progress(label, 0);
    let img: LinearImage | null = f.session ? await f.session.full() : await decodeFull(f.bytes, f.meta.isXTrans, signal);
    merger ??= new HdrMerger(img.width, img.height, scale);
    const guess = { dx: 2 * f.halfShift.dx, dy: 2 * f.halfShift.dy };
    let shift = guess;
    if (opts.align) {
      const codes = mtbCodesOf(img, f.k);
      if (prevCodes) {
        // Carry the previous frame's correction over, then look one pixel around.
        const start = { dx: guess.dx + prevShift.dx - prevGuess.dx, dy: guess.dy + prevShift.dy - prevGuess.dy };
        shift = refineShift(prevCodes, prevShift, codes, img.width, img.height, start, 1);
      }
      prevCodes = codes;
      prevShift = shift;
      prevGuess = guess;
    }
    finalShift.set(f, shift);
    await merger.add({ image: img, k: f.k, exposure: f.exposure, clip: clipLevels(img, f.k), shift, ghost: f.ghost }, j === n - 1, async (x) => {
      progress(label, x);
      await breathe();
    });
    img = null;
  }
  prevCodes = null;
  const out = merger!.out;
  const { width, height } = merger!;

  // 4. The DNG: camera-native values, white balance and look of the reference shot.
  aborted(signal);
  const refBytes = ref.bytes;
  const refMeta = ref.meta;
  const kRef = ref.k;
  const exposureEv = -Math.log2(scale);
  progress('Making the preview', 0);
  const half = halfDecoded(out, width, height, kRef);
  const mergedMeta: RawMeta = { ...refMeta, baselineExposure: refMeta.baselineExposure + exposureEv };
  const { preview, thumbnail } = await makePreviews(await opts.preview(half, mergedMeta));
  const extra = await readExtraMeta(refBytes).catch(() => ({ defaultCrop: null, lensMake: '', bodySerial: '' }));
  const carry = /\.dng$/i.test(ref.asset.originalFileName) ? readDngCarryOver(refBytes) : null;
  const meta = hdrMetadata(ref.asset, refMeta, exposureEv, opts.software, extra, carry, preview, thumbnail, width, height);
  const tiles = await encodeTiles({ type: 'linear16', data: out, width, height }, (f) => progress('Compressing', f));
  aborted(signal);
  progress('Writing the DNG', 0);
  const dng = assembleDng(meta, { kind: 'linear', encoding: 'lossless', width, height }, tiles);

  // 5. Decode it as the editor will, and compare.
  progress('Checking the DNG', 0);
  const verification = await verifyHdr(dng, out, width, height, refMeta);
  const clipRef = Math.max(...ref.clip);
  return {
    bytes: dng,
    fileName: hdrFileName(ref.asset.originalFileName),
    width,
    height,
    reference: ref.asset,
    frames: frames.map((f) => ({
      id: f.asset.id,
      fileName: f.asset.originalFileName,
      ev: Math.log2(f.exposure),
      measured: f.measured,
      shift: finalShift.get(f) ?? { dx: 0, dy: 0 },
    })),
    headroom: Math.log2(65535 / scale / clipRef),
    verification,
  };
}

/** The merged image as LibRaw will decode it (reference white balance applied), at half size. */
export function halfDecoded(out: Uint16Array, width: number, height: number, k: Vec3): LinearImage {
  const w = Math.max(1, width >> 1);
  const h = Math.max(1, height >> 1);
  const data = new Uint16Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const r0 = 2 * y * width;
    const r1 = Math.min(2 * y + 1, height - 1) * width;
    for (let x = 0; x < w; x++) {
      const a = (r0 + 2 * x) * 3;
      const b = (r0 + Math.min(2 * x + 1, width - 1)) * 3;
      const c = (r1 + 2 * x) * 3;
      const d = (r1 + Math.min(2 * x + 1, width - 1)) * 3;
      const o = (y * w + x) * 3;
      for (let ch = 0; ch < 3; ch++) data[o + ch] = Math.round((out[a + ch]! + out[b + ch]! + out[c + ch]! + out[d + ch]!) / 4 / k[ch]!);
    }
  }
  return { width: w, height: h, data, halfSize: true };
}

function hdrMetadata(
  ref: AssetResponseDto,
  meta: RawMeta,
  exposureEv: number,
  software: string,
  extra: { defaultCrop: DngMetadata['defaultCrop'] | null; lensMake: string; bodySerial: string },
  carry: ReturnType<typeof readDngCarryOver>,
  preview: DngMetadata['preview'],
  thumbnail: DngMetadata['thumbnail'],
  width: number,
  height: number,
): DngMetadata {
  const ex: SourceExif = ref.exifInfo ?? {};
  const mul = normMul(meta.camMul);
  const camXyz = meta.camXyz.slice(0, 3).flatMap((r) => r.slice(0, 3));
  const date = exifDate(ex.dateTimeOriginal, ex.timeZone);
  const m: DngMetadata = {
    make: (ex.make || meta.make).trim(),
    model: (ex.model || meta.model).trim(),
    uniqueCameraModel: `${meta.make} ${meta.model}`.trim(),
    software,
    orientation: tiffOrientation(meta.flip),
    colorMatrix1: carry?.colorMatrix1 ?? camXyz,
    calibrationIlluminant1: carry?.colorMatrix1 ? (carry.calibrationIlluminant1 ?? 21) : 21,
    asShotNeutral: [1 / mul[0], 1, 1 / mul[2]],
    // The merged values sit `exposureEv` below the reference shot's; this brings them back.
    baselineExposure: meta.baselineExposure + exposureEv,
    originalRawFileName: ref.originalFileName,
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
  const crop = extra.defaultCrop;
  if (crop && crop.x + crop.width <= width && crop.y + crop.height <= height) m.defaultCrop = crop;
  if (typeof ex.latitude === 'number' && typeof ex.longitude === 'number') m.gps = { latitude: ex.latitude, longitude: ex.longitude };
  if (carry?.colorMatrix2) {
    m.colorMatrix2 = carry.colorMatrix2;
    m.calibrationIlluminant2 = carry.calibrationIlluminant2 ?? 21;
  }
  if (carry?.forwardMatrix1) m.forwardMatrix1 = carry.forwardMatrix1;
  if (carry?.forwardMatrix2) m.forwardMatrix2 = carry.forwardMatrix2;
  return m;
}

/** LibRaw must read the DNG back as the merged image, with the reference's white balance. */
async function verifyHdr(bytes: Uint8Array, out: Uint16Array, width: number, height: number, refMeta: RawMeta): Promise<Verification> {
  let session: RawSession;
  let full: LinearImage;
  try {
    session = await RawSession.open(bytes);
    full = await session.full();
  } catch (e) {
    return { ok: false, text: `The DNG could not be decoded: ${e instanceof Error ? e.message : String(e)}` };
  }
  session.close();
  if (full.width !== width || full.height !== height || session.meta.flip !== refMeta.flip) {
    return { ok: false, text: `The DNG decodes to another size or orientation (${full.width}x${full.height}).` };
  }
  const ma = normMul(refMeta.camMul);
  const mb = normMul(session.meta.camMul);
  if (Math.abs(ma[0] / mb[0] - 1) > 0.01 || Math.abs(ma[2] / mb[2] - 1) > 0.01) return { ok: false, text: 'The DNG has another white balance than the reference shot.' };
  const k = nativeScale(session.meta.camMul);
  const points: [number, number][] = [];
  for (let gy = 0; gy < 200; gy++) {
    const y = Math.floor(((gy + 0.5) * height) / 200);
    for (let gx = 0; gx < 300; gx++) {
      const x = Math.floor(((gx + 0.5) * width) / 300);
      const o = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) points.push([out[o + c]!, full.data[o + c]! * k[c]!]);
    }
  }
  // LibRaw may scale the whole image a little (it takes the top value as white when that is
  // close to the white level: adjust_maximum); only a small, uniform gain is fine.
  const ratios = points.filter(([want]) => want > 1000).map(([want, got]) => got / want).sort((a, b) => a - b);
  const gain = ratios.length ? ratios[ratios.length >> 1]! : 1;
  if (Math.abs(gain - 1) > 0.03) return { ok: false, text: `The DNG decodes ${(Math.log2(gain)).toFixed(2)} EV off the merged image.` };
  const off = points.filter(([want, got]) => Math.abs(got / gain - want) > 3 + 0.002 * want).length;
  return off / points.length > 1e-3
    ? { ok: false, text: `The DNG decodes differently from the merged image in ${((off / points.length) * 100).toFixed(2)} % of the checked pixels.` }
    : { ok: true, text: 'Decodes back to the merged image.' };
}
