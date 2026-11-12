// AI Upscale, editor side: the settings (kept in this browser), where the model runs, how fast it
// was here, and the preview patch. Running it is Editor.upscalePhoto / Editor.upscalePreview.
import type { BackendInfo, UpscaleScale, UpscaleStyle } from '@immich-raw/ai';
import { aiClient } from '../ai.svelte.ts';
import { DEFAULT_UPSCALE, maxOutputPixels, priorRate, type UpscaleFormat, type UpscaleSettings } from './upscale.ts';

const SETTINGS_KEY = 'raw-editor.upscale';

/** Side of the preview patch in pixels of the full-resolution photo. */
export const PATCH = 128;

function loadSettings(): UpscaleSettings {
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<UpscaleSettings> | null;
    return {
      style: v?.style === 'natural' ? 'natural' : DEFAULT_UPSCALE.style,
      scale: v?.scale === 4 ? 4 : DEFAULT_UPSCALE.scale,
      format: v?.format === 'tiff' ? 'tiff' : DEFAULT_UPSCALE.format,
    };
  } catch {
    return { ...DEFAULT_UPSCALE };
  }
}

export interface UpscalePreview {
  /** The patch as rendered, and as upscaled by the model. */
  before: ImageData;
  after: ImageData;
  scale: UpscaleScale;
}

export class UpscaleState {
  settings = $state<UpscaleSettings>(loadSettings());
  /** Where the model runs; null until the worker answered. */
  backend = $state<BackendInfo | null>(null);
  /** Seconds per megapixel of model input measured in this browser, per style. */
  measured = $state<Partial<Record<UpscaleStyle, number>>>({});
  /** Centre of the preview patch (frame coordinates 0..1). */
  patch = $state<[number, number]>([0.5, 0.5]);
  preview = $state<UpscalePreview | null>(null);
  previewStatus = $state<string | null>(null);
  previewError = $state<string | null>(null);
  /** Styles whose model has run once here: the first run includes loading it, so it isn't timed. */
  warm = new Set<UpscaleStyle>();

  set(patch: Partial<{ style: UpscaleStyle; scale: UpscaleScale; format: UpscaleFormat }>): void {
    this.settings = { ...this.settings, ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // Not remembered.
    }
  }

  /** Asks the worker once where the models run. */
  async loadBackend(): Promise<BackendInfo> {
    this.backend ??= await aiClient.backend().catch(() => ({ gpu: false, threads: 1 }));
    return this.backend;
  }

  /** Seconds per megapixel of model input for `style`: measured here, else the benchmark's. */
  rate(style: UpscaleStyle = this.settings.style): number {
    return this.measured[style] ?? priorRate(style, this.backend ?? { gpu: false, threads: 1 });
  }

  /** Largest result this browser is trusted with. */
  maxPixels(): number {
    const nav = navigator as Navigator & { deviceMemory?: number };
    const compact = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    return maxOutputPixels({ compact, deviceMemory: nav.deviceMemory });
  }

  /** Records how long `tiles` model runs of side x side took. */
  record(style: UpscaleStyle, seconds: number, tiles: number, side: number): void {
    if (tiles < 1 || seconds <= 0) return;
    this.measured = { ...this.measured, [style]: seconds / ((tiles * side * side) / 1e6) };
  }
}
