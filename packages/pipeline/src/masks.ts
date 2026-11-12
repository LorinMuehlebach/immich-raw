// Masks -> shader parameters, and a CPU copy of the shader's mask maths (tests, UI).
import { MAX_COMPONENTS, MAX_MASKS, isMaskActive, type Mask, type MaskComponent, type Recipe } from '@immich-raw/recipe';
import { gradeTint } from './color/look.ts';
import { OKLAB_M2 } from './color/matrices.ts';
import { PROPHOTO_TO_LMS } from './color/spaces.ts';
import { pointInPolygon } from './polygon.ts';

/** Colour samples across all colour range components (shader array size). */
export const MAX_COLOR_SAMPLES_TOTAL = 16;

/** What the shader needs besides the recipe: brush maps and sampled colours (renderer.ts). */
export interface MaskResources {
  /** Brush or polygon component id -> its place in the brush atlas [u0, v0, su, sv]. */
  brushCells: Map<string, [number, number, number, number]>;
  /** Half a texel of the atlas, in uv. */
  brushHalfTexel: [number, number];
  /** Colour component id -> the colour features (OKLab a/L, b/L) of its samples. */
  colors: Map<string, [number, number][]>;
  /** AI component id -> its place in the AI atlas; components without a map yet are left out. */
  aiCells?: Map<string, [number, number, number, number]>;
  /** Half a texel of the AI atlas, in uv. */
  aiHalfTexel?: [number, number];
  /** Component id -> its refined map's place in the refined-part atlas (mask-refine.ts). */
  partCells?: Map<string, [number, number, number, number]>;
  partHalfTexel?: [number, number];
  /** Mask id -> its refined map's place in the refined-mask atlas (mask-refine.ts). */
  maskCells?: Map<string, [number, number, number, number]>;
  maskHalfTexel?: [number, number];
}

/**
 * Colour range feature of a working-space colour: OKLab chroma divided by lightness, so it
 * doesn't depend on exposure (same maths as maskChroma in the shader). Returns [a/L, b/L, L].
 */
export function colorFeature(lin: readonly number[]): [number, number, number] {
  const m = PROPHOTO_TO_LMS;
  const lms = [0, 1, 2].map((r) => Math.cbrt(Math.max(1e-9, m[r * 3]! * lin[0]! + m[r * 3 + 1]! * lin[1]! + m[r * 3 + 2]! * lin[2]!)));
  const lab = [0, 1, 2].map((r) => OKLAB_M2[r * 3]! * lms[0]! + OKLAB_M2[r * 3 + 1]! * lms[1]! + OKLAB_M2[r * 3 + 2]! * lms[2]!);
  const L = Math.max(lab[0]!, 1e-4);
  return [lab[1]! / L, lab[2]! / L, lab[0]!];
}

/** Refine (0..100) -> feature distance at which a colour range has faded out. */
export const colorRangeReach = (refine: number) => 0.015 + Math.pow(refine / 100, 1.5) * 0.2;

// A polygon is filled into the brush atlas and read like a brush.
const KIND = { linear: 1, radial: 2, luminance: 3, brush: 4, polygon: 4, color: 5, ai: 6 } as const;
/** A part read from its refined map (the shader's componentWeight kind 7). */
export const KIND_PART_REFINED = 7;
/** A whole mask read from its refined map (kind 8). */
export const KIND_MASK_REFINED = 8;
const MODE = { add: 0, subtract: 1, intersect: 2 } as const;

export interface MaskUniforms {
  uMaskCount: number;
  uCompCount: number;
  /** Per component: kind, mode, mask slot, invert. */
  uCompInfo: Int32Array;
  uCompA: Float32Array;
  uCompB: Float32Array;
  /** Per mask slot (amount folded in): shadows, highlights, whites, blacks (-1..1). */
  uMaskTone: Float32Array;
  /** Exposure (EV), contrast, clarity, texture. */
  uMaskE: Float32Array;
  /** Temp, tint, saturation (-1..1), hue (radians). */
  uMaskC: Float32Array;
  /** Dehaze, sharpness, colour overlay OKLab a, b. */
  uMaskD: Float32Array;
  /** Normalised source coordinates -> mask frame. */
  uMaskFrame: [number, number];
  /** Slot of the mask whose overlay is shown, -1 for none. */
  uOverlay: number;
  /** Colour range samples (xy = OKLab a/L, b/L). */
  uColorSamples: Float32Array;
  /** Which optional passes the active masks need. */
  uses: { detail: boolean; dehaze: boolean; sharpness: boolean };
}

/** Normalised source coordinates -> mask frame scale for an image of w x h (sensor orientation). */
export function maskFrameScale(w: number, h: number): [number, number] {
  const m = Math.max(w, h, 1);
  return [w / m, h / m];
}

/** Shader parameters of one component; null leaves it out (an AI map that isn't ready yet). */
function encodeComponent(c: MaskComponent, res: MaskResources | undefined, colors: { next: number; data: Float32Array }): { a: number[]; b: number[] } | null {
  switch (c.kind) {
    case 'linear':
      return { a: [c.x0, c.y0, c.x1, c.y1], b: [0, 0, 0, 0] };
    case 'radial': {
      const r = (c.angle * Math.PI) / 180;
      // Feather 0 still gets a hairline of anti-aliasing.
      const inner = Math.min(0.998, 1 - c.feather / 100);
      return { a: [c.cx, c.cy, 1 / c.rx, 1 / c.ry], b: [Math.cos(r), Math.sin(r), inner, 0] };
    }
    case 'luminance':
      return { a: [c.lo / 100, c.hi / 100, Math.max(0.002, c.smooth / 100 * 0.5), 0], b: [0, 0, 0, 0] };
    case 'brush':
    case 'polygon': {
      const cell = res?.brushCells.get(c.id);
      // No map (nothing painted yet): an empty cell selects nothing.
      if (!cell) return { a: [0, 0, 0, 0], b: [1, 1, 0, 0] };
      return { a: [...cell], b: [...(res!.brushHalfTexel), 0, 0] };
    }
    case 'color': {
      const feats = (res?.colors.get(c.id) ?? []).slice(0, MAX_COLOR_SAMPLES_TOTAL - colors.next);
      const start = colors.next;
      for (const f of feats) colors.data.set([f[0], f[1], 0, 0], 4 * colors.next++);
      return { a: [start, feats.length, colorRangeReach(c.refine), 0], b: [0, 0, 0, 0] };
    }
    case 'ai': {
      // Until its map is computed the component is left out (an inverted one would otherwise
      // select everything for a moment).
      const cell = res?.aiCells?.get(c.id);
      if (!cell) return null;
      return { a: [...cell], b: [...(res!.aiHalfTexel ?? [0, 0]), 0, 0] };
    }
  }
}

/**
 * Packs the masks that change the picture (plus the one whose overlay is shown) for the
 * shader. Masks beyond the limits are ignored (normalizeMasks already enforces them).
 */
function emptyUniforms(frame: [number, number]): MaskUniforms {
  return {
    uMaskCount: 0,
    uCompCount: 0,
    uCompInfo: new Int32Array(4 * MAX_COMPONENTS),
    uCompA: new Float32Array(4 * MAX_COMPONENTS),
    uCompB: new Float32Array(4 * MAX_COMPONENTS),
    uMaskTone: new Float32Array(4 * MAX_MASKS),
    uMaskE: new Float32Array(4 * MAX_MASKS),
    uMaskC: new Float32Array(4 * MAX_MASKS),
    uMaskD: new Float32Array(4 * MAX_MASKS),
    uMaskFrame: frame,
    uOverlay: -1,
    uColorSamples: new Float32Array(4 * MAX_COLOR_SAMPLES_TOTAL),
    uses: { detail: false, dehaze: false, sharpness: false },
  };
}

/** Packs the parts of mask `m` into slot `slot`; a refined part is read from its map. */
function packParts(u: MaskUniforms, m: Pick<Mask, 'components'>, slot: number, res: MaskResources | undefined, colors: { next: number; data: Float32Array }): void {
  for (const c of m.components) {
    const cell = res?.partCells?.get(c.id);
    if (cell) {
      // Its map already holds the part inverted (if it is).
      const i = u.uCompCount++;
      u.uCompInfo.set([KIND_PART_REFINED, MODE[c.mode], slot, 0], i * 4);
      u.uCompA.set(cell, i * 4);
      u.uCompB.set([...(res!.partHalfTexel ?? [0, 0]), 0, 0], i * 4);
      continue;
    }
    const enc = encodeComponent(c, res, colors);
    if (!enc) continue;
    const i = u.uCompCount++;
    const { a, b } = enc;
    u.uCompInfo.set([KIND[c.kind], MODE[c.mode], slot, c.invert ? 1 : 0], i * 4);
    u.uCompA.set(a, i * 4);
    u.uCompB.set(b, i * 4);
  }
}

/**
 * The parts of one mask (or one part, as a mask of its own) alone, in slot 0, whether or not
 * it changes the picture: what the refinement renders before it refines the edge
 * (mask-refine.ts).
 */
export function maskPartsUniforms(mask: Pick<Mask, 'components'>, frame: [number, number], res?: MaskResources): MaskUniforms {
  const u = emptyUniforms(frame);
  if (!mask.components.length) return u;
  u.uMaskCount = 1;
  packParts(u, mask, 0, res, { next: 0, data: u.uColorSamples });
  return u;
}

export function maskUniforms(recipe: Recipe, frame: [number, number], overlayId: string | null = null, res?: MaskResources): MaskUniforms {
  const u = emptyUniforms(frame);
  const colors = { next: 0, data: u.uColorSamples };
  for (const m of recipe.masks) {
    const overlay = m.id === overlayId && m.components.length > 0;
    const active = isMaskActive(m);
    if (!active && !overlay) continue;
    // A refined mask is read from its map, as one part.
    const refined = res?.maskCells?.get(m.id);
    if (u.uMaskCount >= MAX_MASKS || u.uCompCount + (refined ? 1 : m.components.length) > MAX_COMPONENTS) break;
    const slot = u.uMaskCount++;
    if (overlay) u.uOverlay = slot;
    if (refined) {
      const i = u.uCompCount++;
      u.uCompInfo.set([KIND_MASK_REFINED, MODE.add, slot, 0], i * 4);
      u.uCompA.set(refined, i * 4);
      u.uCompB.set([...(res!.maskHalfTexel ?? [0, 0]), 0, 0], i * 4);
    } else {
      packParts(u, m, slot, res, colors);
    }
    if (!active) continue; // overlay only: no adjustments
    const k = m.amount / 100;
    const a = m.adjust;
    const tint = gradeTint(a.colorHue, a.colorSat);
    u.uMaskTone.set([a.shadows / 100, a.highlights / 100, a.whites / 100, a.blacks / 100].map((v) => v * k), slot * 4);
    u.uMaskE.set([a.exposure * k, (a.contrast / 100) * k, (a.clarity / 100) * k, (a.texture / 100) * k], slot * 4);
    u.uMaskC.set([(a.temp / 100) * k, (a.tint / 100) * k, (a.saturation / 100) * k, ((a.hue * Math.PI) / 180) * k], slot * 4);
    u.uMaskD.set([(a.dehaze / 100) * k, (a.sharpness / 100) * k, tint[0] * k, tint[1] * k], slot * 4);
    if (a.clarity !== 0 || a.texture !== 0) u.uses.detail = true;
    if (a.dehaze !== 0) u.uses.dehaze = true;
    if (a.sharpness !== 0) u.uses.sharpness = true;
  }
  return u;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** One component's weight at mask-frame point m (same maths as componentWeight in the shader). */
export function componentWeight(c: MaskComponent, m: [number, number], lum = 0.5): number {
  let w = 0;
  if (c.kind === 'linear') {
    const dx = c.x1 - c.x0;
    const dy = c.y1 - c.y0;
    const t = ((m[0] - c.x0) * dx + (m[1] - c.y0) * dy) / Math.max(dx * dx + dy * dy, 1e-12);
    w = 1 - smoothstep(0, 1, t);
  } else if (c.kind === 'radial') {
    const r = (c.angle * Math.PI) / 180;
    const qx = m[0] - c.cx;
    const qy = m[1] - c.cy;
    const x = (qx * Math.cos(r) + qy * Math.sin(r)) / c.rx;
    const y = (-qx * Math.sin(r) + qy * Math.cos(r)) / c.ry;
    const inner = Math.min(0.998, 1 - c.feather / 100);
    w = 1 - smoothstep(inner, Math.max(1, inner + 0.002), Math.hypot(x, y));
  } else if (c.kind === 'luminance') {
    const lo = c.lo / 100;
    const hi = c.hi / 100;
    const s = Math.max(0.002, (c.smooth / 100) * 0.5);
    w = (lo < 0.001 ? 1 : smoothstep(lo - s, lo, lum)) * (hi > 0.999 ? 1 : 1 - smoothstep(hi, hi + s, lum));
  } else if (c.kind === 'polygon') {
    w = pointInPolygon(c.points, m) ? 1 : 0;
  }
  return c.invert ? 1 - w : w;
}

/** A whole mask's weight at mask-frame point m (components added, subtracted, intersected). */
export function maskWeight(mask: Pick<Mask, 'components'>, m: [number, number], lum = 0.5): number {
  let w = 0;
  for (const c of mask.components) {
    const v = componentWeight(c, m, lum);
    if (c.mode === 'add') w = Math.max(w, v);
    else if (c.mode === 'subtract') w *= 1 - v;
    else w *= v;
  }
  return w;
}
