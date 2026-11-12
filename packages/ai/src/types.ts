import type { AiTarget, LandscapeClass, PersonPart } from '@immich-raw/recipe';

/** 8-bit RGBA pixels, top row first (like ImageData). */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A single-channel map, 0..255. */
export interface ByteMap {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Row-major 3x3 acting on (x, y, 1), as in the pipeline's geometry. */
export type Affine = [number, number, number, number, number, number, number, number, number];

/**
 * An AI component as the worker sees it: points in the upright analysis image (0..1), the
 * image the models look at.
 */
export interface AiSpec {
  target: AiTarget;
  parts?: PersonPart[];
  classes?: LandscapeClass[];
  person?: [number, number] | null;
  box?: [number, number, number, number];
  points?: number[];
}

/** What the scene model found, per Lightroom landscape category (and people). */
export type SceneClass = LandscapeClass | 'person';

export interface SceneMaps {
  width: number;
  height: number;
  /** Probability 0..255 per category; snow has no class of its own (see compose.ts). */
  maps: Partial<Record<SceneClass, Uint8Array>>;
}

export interface PeopleMaps {
  width: number;
  height: number;
  /** Segmenter confidence 0..255 for each part, and for "any part of a person". */
  hair: Uint8Array;
  bodySkin: Uint8Array;
  faceSkin: Uint8Array;
  clothes: Uint8Array;
  anyone: Uint8Array;
  /** Which group of people (1..n) a pixel belongs to, 0 = nobody. */
  labels: Uint8Array;
  /** Box of each group, normalised (x0, y0, x1, y1). */
  groups: [number, number, number, number][];
  /** Face landmarks (MediaPipe's 478 points), normalised x, y pairs. */
  faces: Float32Array[];
}

/** A detected person, for the People picker. */
export interface PersonInfo {
  /** Where to point to pick this person (normalised, upright analysis image). */
  at: [number, number];
  /** The face, or the person's box when no face was found (normalised). */
  box: [number, number, number, number];
}

/** A finished map for one component. */
export interface RasterResult {
  width: number;
  height: number;
  data: Uint8Array;
  /** Nothing found (e.g. no sky): the map is all zero. */
  empty: boolean;
}

export type Progress =
  | { kind: 'download'; label: string; loaded: number; total: number }
  | { kind: 'detect'; label: string }
  /** A long job in steps (AI Upscale: tiles). */
  | { kind: 'work'; label: string; done: number; total: number };

/** An AI Upscale result: RGBA pixels. */
export interface UpscaleResult {
  width: number;
  height: number;
  data: ArrayBuffer;
}

/** Where the models run. */
export interface BackendInfo {
  /** WebGPU on a real GPU; else the CPU. */
  gpu: boolean;
  /** CPU threads (1 without cross-origin isolation, e.g. on plain HTTP). */
  threads: number;
}
