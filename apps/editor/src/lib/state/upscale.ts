// AI Upscale, editor side: what may run in this browser (result size, time without a GPU), the
// time estimate, and file names. Pure, so it can be tested.
import { tileSide, upscaler, type BackendInfo, type UpscaleScale, type UpscaleStyle } from '@immich-raw/ai';

export type UpscaleFormat = 'jpeg' | 'tiff';

export interface UpscaleSettings {
  style: UpscaleStyle;
  scale: UpscaleScale;
  /** For Download; Save to Immich is always JPEG. */
  format: UpscaleFormat;
}

export const DEFAULT_UPSCALE: UpscaleSettings = { style: 'sharp', scale: 2, format: 'jpeg' };

export const STYLE_LABELS: Record<UpscaleStyle, { name: string; hint: string }> = {
  sharp: { name: 'Sharp', hint: 'Real-ESRGAN: crisp edges, smooths fine texture; fast' },
  natural: { name: 'Natural', hint: 'RealPLKSR: keeps texture, softer edges; about 5× slower' },
};

/** JPEG quality of the upscaled file. */
export const UPSCALE_QUALITY = 95;

/**
 * Largest result this browser is trusted with, in pixels: it is held as RGBA (4 bytes a pixel)
 * and copied once more by the encoder. 2x of a 45 MP photo (183 MP) was checked in Edge on a
 * 32 GB laptop; phones and small-memory devices get less.
 */
export function maxOutputPixels(o: { compact: boolean; deviceMemory?: number }): number {
  return o.compact || (o.deviceMemory !== undefined && o.deviceMemory < 8) ? 50e6 : 200e6;
}

/**
 * Seconds per megapixel of model input, measured on a Ryzen 7 7840U with Radeon 780M graphics
 * (docs/spike-results.md); used until a preview has been timed in this browser.
 */
const PRIOR_SECONDS_PER_MP: Record<UpscaleStyle, { gpu: number; cpu1: number; cpuN: number }> = {
  sharp: { gpu: 6, cpu1: 80, cpuN: 25 },
  natural: { gpu: 30, cpu1: 700, cpuN: 240 },
};

export function priorRate(style: UpscaleStyle, backend: BackendInfo): number {
  const p = PRIOR_SECONDS_PER_MP[style];
  return backend.gpu ? p.gpu : backend.threads > 1 ? p.cpuN : p.cpu1;
}

/**
 * Seconds to upscale width x height at `rate` seconds per megapixel of model input. Tiles overlap
 * by their padding, so the model sees more pixels than the image has.
 */
export function estimateSeconds(width: number, height: number, style: UpscaleStyle, scale: UpscaleScale, gpu: boolean, rate: number): number {
  const u = upscaler(style, scale);
  const side = tileSide(u, gpu);
  const core = side - 2 * u.pad;
  const tiles = Math.ceil(width / core) * Math.ceil(height / core);
  return (tiles * side * side * rate) / 1e6;
}

/** Longest a whole-photo upscale may take on the CPU before the buttons refuse (seconds). */
export const CPU_LIMIT_S = 10 * 60;

export interface UpscaleCheck {
  width: number;
  height: number;
  /** Estimated time; null while it isn't known where the model runs. */
  seconds: number | null;
  /** Why it can't run here, or null. */
  blocked: string | null;
}

const mp = (px: number) => `${Math.round(px / 1e6)} MP`;

/**
 * Whether `scale` of a width x height photo can run in this browser, and how long it takes.
 * `backend` null: not known yet (only the size is checked).
 */
export function checkUpscale(o: {
  width: number;
  height: number;
  style: UpscaleStyle;
  scale: UpscaleScale;
  backend: BackendInfo | null;
  rate: number;
  maxPixels: number;
}): UpscaleCheck {
  const width = o.width * o.scale;
  const height = o.height * o.scale;
  const seconds = o.backend ? estimateSeconds(o.width, o.height, o.style, o.scale, o.backend.gpu, o.rate) : null;
  let blocked: string | null = null;
  if (width * height > o.maxPixels) {
    blocked = `${o.scale}× would make ${mp(width * height)}; this browser can take up to ${mp(o.maxPixels)}. Crop the photo first.`;
  } else if (o.backend && !o.backend.gpu && seconds !== null && seconds > CPU_LIMIT_S) {
    blocked = `Without a GPU this would take ${formatDuration(seconds)}. Full photos need WebGPU: open the editor over HTTPS or on localhost, or crop the photo.`;
  }
  return { width, height, seconds, blocked };
}

/** 'under a minute', 'about 3 min', 'about 1 h 20 min'. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const m = Math.round(seconds / 60);
  return m < 60 ? `about ${m} min` : `about ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** 'DSC01234.ARW', 2, 'jpeg' -> 'DSC01234-upscaled-2x.jpg'. */
export function upscaledDownloadName(rawName: string, scale: UpscaleScale, format: UpscaleFormat): string {
  const dot = rawName.lastIndexOf('.');
  return `${dot > 0 ? rawName.slice(0, dot) : rawName}-upscaled-${scale}x.${format === 'tiff' ? 'tif' : 'jpg'}`;
}
