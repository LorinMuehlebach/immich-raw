// Lightroom-style "Auto" tone: picks Exposure, then Contrast, Highlights, Shadows, Whites
// and Blacks from the photo's brightness distribution.
//
// Input: log2 luminance samples of the (cropped) frame with the current white balance at
// Exposure 0, as the tone stage sees them. All maths is in stops relative to middle grey.
// The slider effects mirror toneBase() in shaders.ts.
import type { BasicParams, ParamSpec } from '@immich-raw/recipe';

const MID = Math.log2(0.18);

/** Brightness the image's key (typical tone) is moved to: a little under middle grey. */
const TARGET_KEY = Math.log2(0.16);

export type AutoTone = Pick<BasicParams, 'exposure' | 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks'>;

/** How Auto behaves: the user's taste, not per photo (stored in the browser). */
export interface AutoParams {
  /** EV added to the brightness Auto aims for. */
  brightness: number;
  /** Stops the brightest 0.5 % may end up above white after Exposure, left for Highlights to pull back. */
  headroom: number;
  /** Strength of Auto's Highlights, Shadows and Whites/Blacks, in % of what it would set. */
  highlights: number;
  shadows: number;
  whitesBlacks: number;
  /** Added to the Contrast Auto picks. */
  contrast: number;
}

export const DEFAULT_AUTO_PARAMS: AutoParams = { brightness: 0, headroom: 1.2, highlights: 100, shadows: 100, whitesBlacks: 100, contrast: 0 };

const ap = (key: keyof AutoParams, label: string, min: number, max: number, step: number, decimals: number, signed: boolean): ParamSpec & { key: keyof AutoParams } => ({
  key,
  path: `auto.${key}`,
  label,
  min,
  max,
  default: DEFAULT_AUTO_PARAMS[key],
  step,
  decimals,
  signed,
});

/** Slider specs for the Auto settings (same shape as the recipe's sliders). */
export const AUTO_PARAM_SPECS = [
  ap('brightness', 'Brightness', -1.5, 1.5, 0.05, 2, true),
  ap('headroom', 'Headroom', 0, 2, 0.05, 2, false),
  ap('highlights', 'Highlights %', 0, 200, 5, 0, false),
  ap('shadows', 'Shadows %', 0, 200, 5, 0, false),
  ap('whitesBlacks', 'Whites/Blacks %', 0, 200, 5, 0, false),
  ap('contrast', 'Contrast', -50, 50, 1, 0, true),
];

/** Fills missing or invalid fields with defaults and clamps the rest (stored settings may be old). */
export function normalizeAutoParams(input: unknown): AutoParams {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_AUTO_PARAMS };
  for (const spec of AUTO_PARAM_SPECS) {
    const v = src[spec.key];
    if (typeof v === 'number' && Number.isFinite(v)) out[spec.key] = Math.min(spec.max, Math.max(spec.min, v));
  }
  return out;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Slider weights at x stops from middle grey (same curves as the shader).
const shadowWeight = (x: number) => (1 - smooth(-5, 0.5, x)) * smooth(-11, -6, x);
const highlightWeight = (x: number) => smooth(-0.5, 2.5, x);
const whiteWeight = (x: number) => smooth(0.5, 3, x);
const blackWeight = (x: number) => 1 - smooth(-9, -3.5, x);

/** Stops a slider at ±100 moves a tone with full weight (shader constants). */
const RANGE = { shadows: 1.6, highlights: 1.6, whites: 1, blacks: 1.5 };

/**
 * Slider value (-100..100) that moves tone x by `stops`, limited to ±cap. 0 where the
 * slider barely reaches that tone: maxing it out there would change almost nothing.
 */
function sliderFor(stops: number, range: number, weight: number, cap: number): number {
  if (Math.abs(stops) < 1e-6 || weight < 0.3) return 0;
  return clamp((stops / range / weight) * 100, -cap, cap);
}

export function autoTone(samples: ArrayLike<number>, opts: { whitePoint: number; params?: Partial<AutoParams> }): AutoTone {
  const P = { ...DEFAULT_AUTO_PARAMS, ...opts.params };
  const v = Float64Array.from(samples).filter(Number.isFinite).sort();
  const none: AutoTone = { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 };
  if (v.length < 16) return none;
  const pct = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))]!;

  // Key: half median, half trimmed mean of the log luminance (robust to small bright or dark areas).
  const lo = Math.round(v.length * 0.02);
  const hi = Math.max(lo + 1, Math.round(v.length * 0.98));
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += v[i]!;
  const key = 0.5 * pct(0.5) + 0.5 * (sum / (hi - lo));

  // White, in stops above middle grey.
  const W = Math.log2(opts.whitePoint / 0.18);

  // Exposure brings the key to the target, but never pushes the bright end more than
  // Highlights can pull back (by default 1.2 stops over white).
  let ev = TARGET_KEY + P.brightness - key;
  ev = Math.min(ev, W + P.headroom - (pct(0.995) - MID));
  ev = clamp(Math.round(ev * 20) / 20, -4, 4);
  const q = (p: number) => pct(p) + ev - MID;

  // Highlights: pull the top 0.5 % back under white.
  const top = q(0.995);
  const hiScale = P.highlights / 100;
  const highlights = top > W - 0.4 ? clamp(-sliderFor(top - (W - 0.5), RANGE.highlights, highlightWeight(top), 80) * hiScale, -100, 100) : 0;
  const topAfter = top + (highlights / 100) * RANGE.highlights * highlightWeight(top);

  // Whites: lift a dull top end towards white, or tame what still clips.
  const wbScale = P.whitesBlacks / 100;
  let whites = 0;
  if (topAfter < W - 1) whites = sliderFor(W - 0.7 - topAfter, RANGE.whites, whiteWeight(topAfter), 35);
  else if (q(0.999) > W + 0.4) whites = -sliderFor(q(0.999) - (W + 0.2), RANGE.whites, whiteWeight(q(0.999)), 35);
  whites = clamp(whites * wbScale, -100, 100);

  // Shadows: open up the darkest 10 % when they sit deep in the shadows.
  const dark = q(0.1);
  const shadows = dark < -3.5 ? clamp(sliderFor(-3.5 - dark, RANGE.shadows, shadowWeight(dark), 65) * (P.shadows / 100), -100, 100) : 0;

  // Blacks: give a flat image a real black; ease off where large areas are crushed.
  const bottom = q(0.005);
  let blacks = 0;
  if (bottom > -6) blacks = -sliderFor(bottom + 6.5, RANGE.blacks, blackWeight(bottom), 35);
  else if (q(0.05) < -9.5) blacks = sliderFor(-9.5 - q(0.05), RANGE.blacks, blackWeight(q(0.05)), 20);
  blacks = clamp(blacks * wbScale, -100, 100);

  // Contrast: a short tonal range gets more, a very long one a little less.
  const range = q(0.95) - q(0.05);
  const picked = range < 5 ? clamp((5 - range) * 10, 0, 30) : range > 9 ? -clamp((range - 9) * 5, 0, 20) : 0;
  const contrast = clamp(picked + P.contrast, -100, 100);

  const round = (x: number) => Math.round(x) || 0;
  return { exposure: ev || 0, contrast: round(contrast), highlights: round(highlights), shadows: round(shadows), whites: round(whites), blacks: round(blacks) };
}
