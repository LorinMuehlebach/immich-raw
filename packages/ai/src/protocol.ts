// Messages between the editor and the AI worker.
import type { ModelId, UpscaleScale, UpscaleStyle } from './models.ts';
import type { RuntimeConfig } from './runtime.ts';
import type { Affine, AiSpec, BackendInfo, PersonInfo, Progress, RasterResult, UpscaleResult } from './types.ts';

export type Request =
  | { type: 'init'; cfg: RuntimeConfig }
  /** The image the models look at for photo `key` (upright RGBA, any size). */
  | { type: 'photo'; key: string; width: number; height: number; data: ArrayBuffer }
  | { type: 'raster'; id: number; key: string; spec: AiSpec; width: number; height: number; sToT: Affine }
  | { type: 'people'; id: number; key: string }
  | { type: 'missing'; id: number; models: ModelId[] }
  /** AI Upscale of an RGBA image; `side`: input tile size (null: the best for the backend). */
  | { type: 'upscale'; id: number; style: UpscaleStyle; scale: UpscaleScale; side: number | null; width: number; height: number; data: ArrayBuffer }
  /** Stops request `id` (an upscale) before its next tile. */
  | { type: 'cancel'; id: number }
  | { type: 'backend'; id: number };

export type Response =
  | { type: 'result'; id: number; value: RasterResult | PersonInfo[] | number | UpscaleResult | BackendInfo }
  | { type: 'error'; id: number; message: string }
  /** `id`: the request it belongs to, when it belongs to one (an upscale). */
  | { type: 'progress'; progress: Progress; id?: number };
