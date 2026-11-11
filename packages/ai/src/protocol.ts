// Messages between the editor and the AI worker.
import type { ModelId } from './models.ts';
import type { RuntimeConfig } from './runtime.ts';
import type { Affine, AiSpec, PersonInfo, Progress, RasterResult } from './types.ts';

export type Request =
  | { type: 'init'; cfg: RuntimeConfig }
  /** The image the models look at for photo `key` (upright RGBA, any size). */
  | { type: 'photo'; key: string; width: number; height: number; data: ArrayBuffer }
  | { type: 'raster'; id: number; key: string; spec: AiSpec; width: number; height: number; sToT: Affine }
  | { type: 'people'; id: number; key: string }
  | { type: 'missing'; id: number; models: ModelId[] };

export type Response =
  | { type: 'result'; id: number; value: RasterResult | PersonInfo[] | number }
  | { type: 'error'; id: number; message: string }
  | { type: 'progress'; progress: Progress };
