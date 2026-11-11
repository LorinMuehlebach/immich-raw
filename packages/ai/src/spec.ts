// From a recipe's AI component to what the worker computes, and cache keys for both.
import { defaultRecipe, type AiComponent, type Recipe } from '@immich-raw/recipe';
import type { AiSpec } from './types.ts';

/** Rounds to 1/1000 (a few pixels at most): tiny changes don't recompute anything. */
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * The component as the worker sees it. toImage maps a mask-frame point to the upright
 * analysis image (0..1), through the lens corrections and the photo's orientation.
 */
export function specFor(c: AiComponent, toImage: (mx: number, my: number) => [number, number]): AiSpec {
  const s: AiSpec = { target: c.target };
  if (c.target === 'people') {
    s.parts = [...(c.parts ?? ['person'])];
    s.person = c.person ? toImage(c.person.x, c.person.y).map(r3) as [number, number] : null;
  }
  if (c.target === 'landscape') s.classes = [...(c.classes ?? [])];
  if (c.target === 'object') {
    if (c.box) {
      const a = toImage(c.box[0], c.box[1]);
      const b = toImage(c.box[2], c.box[3]);
      // The box may turn with the photo: keep it ordered.
      s.box = [r3(Math.min(a[0], b[0])), r3(Math.min(a[1], b[1])), r3(Math.max(a[0], b[0])), r3(Math.max(a[1], b[1]))];
    } else if (c.points) {
      const pts: number[] = [];
      for (let i = 0; i + 1 < c.points.length; i += 2) pts.push(...toImage(c.points[i]!, c.points[i + 1]!).map(r3));
      s.points = pts;
    }
  }
  return s;
}

/** Same key = same map. */
export const specKey = (s: AiSpec): string => JSON.stringify([s.target, s.parts ?? null, s.classes ?? null, s.person ?? null, s.box ?? null, s.points ?? null]);

/** Key of an object prompt (box or points). */
export const objectKey = (s: AiSpec): string => JSON.stringify(s.box ?? s.points ?? null);

/**
 * The recipe the analysis image is rendered with: the camera's own look, no crop and no lens
 * corrections, so the models see the whole photo and their maps line up with the decoded image.
 */
export function analysisRecipe(): Recipe {
  const r = defaultRecipe();
  r.lens.profile = false;
  r.lens.removeCA = false;
  return r;
}

/** Bump with any change to analysisRecipe() or the analysis image size (part of the photo key). */
export const ANALYSIS_IMAGE_VERSION = 1;
