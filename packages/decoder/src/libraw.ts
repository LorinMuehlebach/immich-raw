// libraw-wasm wrapper. Each decode runs in its own LibRaw instance (= its own worker),
// disposed afterwards: WASM memory never shrinks, so reusing a worker would keep the
// peak (up to ~1.5 GB at 61 MP) alive for the whole session.
import type LibRawType from '@immich-raw/libraw';
import { camXyzFromRgbCam, hasCamXyz } from './color.ts';
import { startMeasure } from './timing.ts';
import type { DecoderInfo, LinearImage, RawMeta, SensorData } from './types.ts';

// libraw-wasm (our single-threaded build in packages/libraw) is loaded unbundled from its own
// folder (the app copies packages/libraw/lib there). Its worker and libraw.wasm are found
// relative to that script at runtime, and libraw.wasm stays a separate, replaceable file (LGPL).
let librawUrl = '/immich-raw/libraw/index.js';
let librawModule: Promise<typeof LibRawType> | null = null;

/** Where to load libraw-wasm's index.js from. Call before the first decode. */
export function setLibRawUrl(url: string): void {
  librawUrl = url;
  librawModule = null;
  dropSpare();
}

function loadLibRaw(): Promise<typeof LibRawType> {
  librawModule ??= import(/* @vite-ignore */ librawUrl).then((m: { default: typeof LibRawType }) => m.default);
  return librawModule;
}

// A LibRaw instance started ahead of time. Its worker loads and instantiates the WebAssembly as
// soon as it exists, so the decode that takes it doesn't wait for that. It still serves one
// decode only and is disposed afterwards, like any other instance.
let spare: Promise<LibRawType> | null = null;

/**
 * Starts the next decode's worker now (e.g. while the photo downloads). Keeps at most one
 * waiting; the next decode takes it.
 */
export function prewarmDecoder(): void {
  if (spare) return;
  const started = loadLibRaw().then((LibRaw) => new LibRaw());
  spare = started;
  started.catch(() => {
    if (spare === started) spare = null;
  });
}

function dropSpare(): void {
  spare?.then((raw) => raw.dispose(), () => {});
  spare = null;
}

/** The waiting instance from prewarmDecoder(), or a new one. */
async function takeLibRaw(): Promise<LibRawType> {
  const waiting = spare;
  spare = null;
  if (waiting) {
    try {
      return await waiting;
    } catch {
      // fall through to a fresh instance
    }
  }
  const LibRaw = await loadLibRaw();
  return new LibRaw();
}

// Settings proven in M0 (docs/spike-results.md):
// - linear camera RGB, 16-bit, as-shot WB, no auto brightening, no rotation
// - highlight 1: WB multipliers are normalised by their maximum, so no channel clips;
//   channel c saturates at 65535 * mul_c / max(mul)
// - gamm must have 6 entries: the wrapper ignores shorter arrays
const BASE_SETTINGS = {
  outputColor: 0,
  outputBps: 16,
  gamm: [1, 1, 0, 0, 0, 0] as unknown as [number, number],
  noAutoBright: true,
  useCameraWb: true,
  userFlip: 0,
  highlight: 1,
};

/** AHD for Bayer sensors; quality 2 for X-Trans (3-pass Markesteijn takes ~33 s at 40 MP). */
const demosaicFor = (isXTrans: boolean) => (isXTrans ? { userQual: 2, name: 'markesteijn-1pass' } : { userQual: 3, name: 'AHD' });

// '+nothread': built without pthreads (packages/libraw/build), same pixels as the npm 1.6.0.
export const DECODER = { name: 'libraw-wasm', version: '1.6.0+nothread', libraw: '0.22.1' };

interface RawWasmMeta {
  width: number;
  height: number;
  flip: number;
  camera_make: string;
  camera_model: string;
  iso_speed: number;
  shutter: number;
  aperture: number;
  focal_len: number;
  filters?: number;
  raw_inset_crops?: { cleft: number; ctop: number; cwidth: number; cheight: number }[];
  shootinginfo?: { BodySerial?: string };
  lens?: { Lens?: string; LensMake?: string; makernotes?: { Lens?: string } };
  color_data?: {
    black: number;
    maximum: number;
    cam_mul: number[];
    pre_mul: number[];
    rgb_cam: number[][];
    cam_xyz: number[][];
    dng_levels?: { baseline_exposure?: number };
  };
}

function toMeta(m: RawWasmMeta): RawMeta {
  const c = m.color_data;
  const noColor = 'This RAW file has no color information the editor can use.';
  if (!c?.cam_mul || !c.rgb_cam) throw new Error(noColor);
  // Cameras missing from LibRaw's table (e.g. DNGs from new or unusual cameras) come with an
  // all-zero cam_xyz; rebuild it from the file's own matrix, which rgb_cam is made from.
  const camXyz = hasCamXyz(c.cam_xyz) ? c.cam_xyz : camXyzFromRgbCam(c.rgb_cam, c.pre_mul ?? []);
  if (!camXyz) throw new Error(noColor);
  return {
    width: m.width,
    height: m.height,
    flip: m.flip ?? 0,
    camMul: c.cam_mul,
    preMul: c.pre_mul,
    rgbCam: c.rgb_cam,
    camXyz,
    black: c.black,
    maximum: c.maximum,
    // LibRaw reports -999 when the file has no DNG BaselineExposure.
    baselineExposure: Math.abs(c.dng_levels?.baseline_exposure ?? 0) <= 10 ? (c.dng_levels?.baseline_exposure ?? 0) : 0,
    isXTrans: m.filters === 9,
    make: m.camera_make ?? '',
    model: m.camera_model ?? '',
    lens: m.lens?.Lens || m.lens?.makernotes?.Lens || '',
    iso: m.iso_speed ?? 0,
    shutter: m.shutter ?? 0,
    aperture: m.aperture ?? 0,
    focalLength: m.focal_len ?? 0,
  };
}

/** `label` names the timing measures: `immich-raw:<label> open`, `… metadata`, `… imageData`. */
async function decode(bytes: Uint8Array, settings: Record<string, unknown>, withMeta: boolean, label: string) {
  const raw = await takeLibRaw();
  try {
    // open() transfers (detaches) the buffer it gets, so always hand it a copy. It also waits
    // for the worker's WebAssembly, unless the instance was started early.
    let done = startMeasure(`${label} open`);
    await raw.open(bytes.slice(), settings as never);
    done();
    let meta: RawWasmMeta | undefined;
    if (withMeta) {
      done = startMeasure(`${label} metadata`);
      meta = (await raw.metadata(true)) as unknown as RawWasmMeta;
      done();
    }
    done = startMeasure(`${label} imageData`);
    const img = await raw.imageData();
    done();
    if (!img || !(img.data instanceof Uint16Array) || img.colors !== 3) {
      throw new Error('The decoder returned no 16-bit RGB image.');
    }
    return { meta, img: { width: img.width, height: img.height, data: img.data } };
  } finally {
    raw.dispose();
  }
}

type FullMeta = RawWasmMeta & { raw_width: number; raw_height: number; top_margin: number; left_margin: number };

/** Default crop (LibRaw reports it in raw-frame coordinates), lens make and body serial. */
function extraMeta(m: FullMeta, width: number, height: number): Pick<SensorData, 'defaultCrop' | 'lensMake' | 'bodySerial'> {
  const inset = m.raw_inset_crops?.[0];
  let defaultCrop: SensorData['defaultCrop'] = null;
  if (inset && inset.cwidth > 0 && inset.cheight > 0 && inset.cwidth < 65535) {
    const x = Math.max(0, inset.cleft - m.left_margin);
    const y = Math.max(0, inset.ctop - m.top_margin);
    const w = Math.min(inset.cwidth, width - x);
    const h = Math.min(inset.cheight, height - y);
    if (w > 16 && h > 16) defaultCrop = { x, y, width: w, height: h };
  }
  return { defaultCrop, lensMake: m.lens?.LensMake ?? '', bodySerial: m.shootinginfo?.BodySerial ?? '' };
}

/**
 * Reads the sensor mosaic for a lossless DNG. LibRaw's metadata doesn't report every black
 * level (per-channel and per-position blacks of Canon, Fuji and DNG files show up as 0), so
 * the colour pattern and the blacks are read off an undemosaiced, unscaled decode instead:
 * there each pixel holds raw - black in its own colour channel only.
 */
export async function readSensor(bytes: Uint8Array): Promise<SensorData> {
  const raw = await takeLibRaw();
  try {
    await raw.open(bytes.slice(), { ...BASE_SETTINGS, noInterpolation: true, noAutoScale: true } as never);
    const m = (await raw.metadata(true)) as unknown as FullMeta;
    // imageData() must come first: after rawImageData() it returns an empty image.
    const img = await raw.imageData();
    const sensor = await raw.rawImageData();
    if (!img || !(img.data instanceof Uint16Array) || img.colors !== 3 || !sensor) throw new Error('The decoder returned no sensor data.');
    const { width, height } = img;
    if (sensor.width < width || sensor.height < height) throw new Error('Unexpected sensor size.');
    const meta = toMeta(m);
    const pw = meta.isXTrans ? 6 : 2;
    const ph = pw;
    const at = (x: number, y: number) => sensor.data[(sensor.top_margin + y) * sensor.raw_width + sensor.left_margin + x]!;
    // Per pattern position: the colour seen there and how often each black value occurs.
    const colour: number[] = new Array(pw * ph).fill(-1);
    const blacks: Map<number, number>[] = Array.from({ length: pw * ph }, () => new Map());
    const stepY = Math.max(1, Math.floor(height / 400 / ph)) * ph;
    const stepX = Math.max(1, Math.floor(width / 400 / pw)) * pw;
    for (let by = ph; by + ph < height; by += stepY) {
      for (let bx = pw; bx + pw < width; bx += stepX) {
        for (let dy = 0; dy < ph; dy++) {
          for (let dx = 0; dx < pw; dx++) {
            const x = bx + dx;
            const y = by + dy;
            const o = (y * width + x) * 3;
            const v = [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!];
            const lit = v.filter((c) => c > 0).length;
            if (lit !== 1) continue;
            const c = v.findIndex((c) => c > 0);
            const k = (y % ph) * pw + (x % pw);
            if (colour[k] === -1) colour[k] = c;
            else if (colour[k] !== c) throw new Error('The colour filter pattern of this file could not be read.');
            const b = at(x, y) - v[c]!;
            blacks[k]!.set(b, (blacks[k]!.get(b) ?? 0) + 1);
          }
        }
      }
    }
    if (colour.some((c) => c < 0)) throw new Error('The colour filter pattern of this file could not be read (image too dark?).');
    const black = blacks.map((counts) => {
      let best = 0;
      let n = -1;
      for (const [b, c] of counts) if (c > n) [best, n] = [b, c];
      return best;
    });
    // Copy out the visible area.
    const data = new Uint16Array(width * height);
    for (let y = 0; y < height; y++) {
      const start = (sensor.top_margin + y) * sensor.raw_width + sensor.left_margin;
      data.set(sensor.data.subarray(start, start + width), y * width);
    }
    return {
      width,
      height,
      data,
      patternWidth: pw,
      patternHeight: ph,
      pattern: colour,
      black,
      white: m.color_data?.maximum ?? 65535,
      meta,
      ...extraMeta(m, width, height),
    };
  } finally {
    raw.dispose();
  }
}

/** Default crop, lens make and body serial without decoding the image. */
export async function readExtraMeta(bytes: Uint8Array): Promise<Pick<SensorData, 'defaultCrop' | 'lensMake' | 'bodySerial'>> {
  const raw = await takeLibRaw();
  try {
    await raw.open(bytes.slice(), { ...BASE_SETTINGS, halfSize: true } as never);
    const m = (await raw.metadata(true)) as unknown as FullMeta;
    return extraMeta(m, m.width, m.height);
  } finally {
    raw.dispose();
  }
}

/**
 * Best-quality demosaic for a lossy DNG of an X-Trans file (3-pass Markesteijn): the result
 * is kept for good, so it's worth the extra time. Same normalisation as full(). (Bayer
 * files use the editor's AHD decode: DHT needs ~1.7 GB at 61 MP, too close to the 2 GB
 * limit of the WebAssembly build.)
 */
export async function decodeBest(bytes: Uint8Array): Promise<{ image: LinearImage } & Pick<SensorData, 'defaultCrop' | 'lensMake' | 'bodySerial'>> {
  const { img, meta } = await decode(bytes, { ...BASE_SETTINGS, userQual: 3 }, true, 'best decode');
  return { image: { ...img, halfSize: false }, ...extraMeta(meta as FullMeta, img.width, img.height) };
}

/** 2x2 box downscale of an RGB16 image. */
function halve(img: { width: number; height: number; data: Uint16Array }): LinearImage {
  const w = Math.max(1, img.width >> 1);
  const h = Math.max(1, img.height >> 1);
  const out = new Uint16Array(w * h * 3);
  const src = img.data;
  const W = img.width;
  for (let y = 0; y < h; y++) {
    const r0 = 2 * y * W;
    const r1 = Math.min(2 * y + 1, img.height - 1) * W;
    for (let x = 0; x < w; x++) {
      const a = (r0 + 2 * x) * 3;
      const b = a + (2 * x + 1 < W ? 3 : 0);
      const c = (r1 + 2 * x) * 3;
      const d = c + (2 * x + 1 < W ? 3 : 0);
      const o = (y * w + x) * 3;
      for (let k = 0; k < 3; k++) out[o + k] = (src[a + k]! + src[b + k]! + src[c + k]! + src[d + k]! + 2) >> 2;
    }
  }
  return { width: w, height: h, data: out, halfSize: true };
}

export class RawSession {
  readonly meta: RawMeta;
  readonly half: LinearImage;
  readonly decoder: DecoderInfo;
  private bytes: Uint8Array | null;
  private fullPromise: Promise<LinearImage> | null = null;

  private constructor(bytes: Uint8Array, meta: RawMeta, half: LinearImage) {
    this.bytes = bytes;
    this.meta = meta;
    this.half = half;
    this.decoder = { ...DECODER, demosaic: demosaicFor(meta.isXTrans).name };
  }

  /** Decodes at half size (no demosaic, ~2 s) so editing can start right away. */
  static async open(bytes: Uint8Array): Promise<RawSession> {
    const { meta, img } = await decode(bytes, { ...BASE_SETTINGS, halfSize: true }, true, 'half decode');
    const m = toMeta(meta!);
    // LibRaw only shrinks mosaic images; a demosaiced (linear, e.g. lossy) DNG comes back at
    // full size. Keep it as the full image and halve it for editing.
    if (img.width > m.width * 0.75) {
      const session = new RawSession(bytes, m, halve(img));
      session.fullPromise = Promise.resolve({ ...img, halfSize: false });
      return session;
    }
    return new RawSession(bytes, m, { ...img, halfSize: true });
  }

  /** Full-resolution decode (5-10 s, X-Trans ~17 s). Started once, shared by all callers. */
  full(): Promise<LinearImage> {
    if (!this.fullPromise) {
      const bytes = this.bytes;
      if (!bytes) return Promise.reject(new Error('Session closed'));
      const { userQual } = demosaicFor(this.meta.isXTrans);
      this.fullPromise = decode(bytes, { ...BASE_SETTINGS, userQual }, false, 'full decode').then(({ img }) => ({ ...img, halfSize: false }));
      this.fullPromise.catch(() => (this.fullPromise = null));
    }
    return this.fullPromise;
  }

  get fullStarted(): boolean {
    return this.fullPromise !== null;
  }

  /** Drops the file bytes; the half image stays usable. */
  close(): void {
    this.bytes = null;
  }
}
