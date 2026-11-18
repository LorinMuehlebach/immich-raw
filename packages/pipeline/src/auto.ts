// Lightroom-style "Auto" tone: picks Exposure, then Contrast, Highlights, Shadows, Whites
// and Blacks from the photo's brightness distribution.
//
// Input: log2 luminance samples of the (cropped) frame with the current white balance at
// Exposure 0, as the tone stage sees them. All maths is in stops relative to middle grey.
// The slider effects come from tone-windows.ts, the same maths as toneBase() in shaders.ts.
import type { BasicParams, ParamSpec } from '@immich-raw/recipe';
import { hdrCurve } from './hdr-tone.ts';
import { MID, TONE_WINDOWS, applyTone, bentAnchors, toneAnchors, toneWeight, type ToneAmounts, type ToneAnchors } from './tone-windows.ts';

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

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Stage = keyof ToneAmounts;

/**
 * Slider value (-100..100) that moves tone x by `stops`, limited to ±cap, given the photo's black
 * and white point at that stage. 0 where the slider barely reaches that tone: maxing it out there
 * would change almost nothing.
 */
function sliderFor(stage: Stage, stops: number, x: number, anchors: ToneAnchors, cap: number): number {
  const weight = toneWeight(stage, x, anchors.black, anchors.white);
  if (Math.abs(stops) < 1e-6 || weight < 0.3) return 0;
  const w = TONE_WINDOWS[stage];
  // Invert toneStops(): stops = sign * 0.5 * (|a| / 0.5) ^ exponent * gain, for the weight-scaled move.
  const amount = Math.sign(stops) * 0.5 * (Math.abs(stops) / weight / (0.5 * w.gain)) ** (1 / w.exponent);
  return clamp(amount * 100, -cap, cap);
}

/** Key of the photo (its typical tone, log2): half median, half trimmed mean, robust to small bright or dark areas. */
function keyOf(v: Float64Array, pct: (p: number) => number): number {
  const lo = Math.round(v.length * 0.02);
  const hi = Math.max(lo + 1, Math.round(v.length * 0.98));
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += v[i]!;
  return 0.5 * pct(0.5) + 0.5 * (sum / (hi - lo));
}

/** Where the HDR auto amount aims: the brightest 0.5 % this far over white, the darkest 1 % no lower than this. */
const HDR_TOP_OVER_WHITE = 0.6;
const HDR_BOTTOM = -6.5;
/** Below this the result hardly looks different; "HDR from this photo" should be visible. */
export const HDR_AUTO_MIN = 30;

/**
 * HDR amount (0..100) that brings the photo's range within reach of the other tone sliders,
 * measured at the exposure Auto aims for (same samples as autoTone).
 */
export function autoHdr(samples: ArrayLike<number>, opts: { whitePoint: number; params?: Partial<AutoParams> }): number {
  const P = { ...DEFAULT_AUTO_PARAMS, ...opts.params };
  const v = Float64Array.from(samples).filter(Number.isFinite).sort();
  if (v.length < 16) return HDR_AUTO_MIN;
  const pct = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))]!;
  const ev = clamp(TARGET_KEY + P.brightness - keyOf(v, pct), -4, 4);
  const top = pct(0.995) + ev - MID;
  const bottom = pct(0.01) + ev - MID;
  const W = Math.log2(opts.whitePoint / 0.18);
  // The smallest amount that brings both ends within reach (the curve only ever pulls them in).
  const fits = (a: number) => hdrCurve(top, a) <= W + HDR_TOP_OVER_WHITE && hdrCurve(bottom, a) >= HDR_BOTTOM;
  let lo = 0;
  let hi = 1;
  if (!fits(1)) return 100;
  for (let i = 0; i < 20; i++) {
    const m = (lo + hi) / 2;
    if (fits(m)) hi = m;
    else lo = m;
  }
  return Math.round(clamp(hi * 100, HDR_AUTO_MIN, 100));
}

/**
 * `hdr`: the photo's HDR amount (0..100). The tone stage compresses the base layer by it before
 * the other sliders act, so Auto measures the photo as compressed.
 */
export function autoTone(samples: ArrayLike<number>, opts: { whitePoint: number; params?: Partial<AutoParams>; hdr?: number }): AutoTone {
  const P = { ...DEFAULT_AUTO_PARAMS, ...opts.params };
  const v = Float64Array.from(samples).filter(Number.isFinite).sort();
  const none: AutoTone = { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 };
  if (v.length < 16) return none;
  const pct = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))]!;

  const key = keyOf(v, pct);

  // White, in stops above middle grey.
  const W = Math.log2(opts.whitePoint / 0.18);

  // Exposure brings the key to the target, but never pushes the bright end more than
  // Highlights can pull back (by default 1.2 stops over white).
  const hdr = clamp((opts.hdr ?? 0) / 100, 0, 1);
  const bend = (x: number) => hdrCurve(x, hdr);
  let ev = TARGET_KEY + P.brightness - key;
  // The top end after HDR rises with ev and never faster, so the largest ev that keeps it
  // within reach is found by halving.
  const fits = (e: number) => bend(pct(0.995) + e - MID) <= W + P.headroom;
  if (hdr === 0) ev = Math.min(ev, W + P.headroom - (pct(0.995) - MID));
  else if (!fits(ev)) {
    let lo = -8;
    let hi = ev;
    if (fits(lo)) {
      for (let i = 0; i < 30; i++) {
        const m = (lo + hi) / 2;
        if (fits(m)) lo = m;
        else hi = m;
      }
    }
    ev = lo;
  }
  ev = clamp(Math.round(ev * 20) / 20, -4, 4);
  const q = (p: number) => bend(pct(p) + ev - MID);

  // The sliders work in the shader's order (Shadows, Highlights, Whites, Blacks), each on the tones
  // and the black and white point the one before left, so each is chosen from that state.
  const photo = toneAnchors(samples);
  if (!photo) return none;
  const state = {
    anchors: bentAnchors(photo, ev, hdr),
    top: q(0.995),
    near: q(0.999),
    dark: q(0.1),
    bottom: q(0.005),
    low: q(0.05),
  };
  const apply = (stage: Stage, slider: number) => {
    if (!slider) return;
    const amounts: ToneAmounts = { shadows: 0, highlights: 0, whites: 0, blacks: 0, [stage]: slider / 100 };
    const r = applyTone([state.top, state.near, state.dark, state.bottom, state.low], state.anchors, amounts, stage);
    [state.top, state.near, state.dark, state.bottom, state.low] = r.tones as [number, number, number, number, number];
    state.anchors = r.anchors;
  };
  const wbScale = P.whitesBlacks / 100;

  // Shadows: open up the darkest 10 % when they sit deep in the shadows.
  const shadows = state.dark < -3.5 ? clamp(sliderFor('shadows', -3.5 - state.dark, state.dark, state.anchors, 65) * (P.shadows / 100), -100, 100) : 0;
  apply('shadows', shadows);

  // Highlights: pull the top 0.5 % back under white.
  const hiScale = P.highlights / 100;
  const highlights = state.top > W - 0.4 ? clamp(sliderFor('highlights', W - 0.5 - state.top, state.top, state.anchors, 80) * hiScale, -100, 100) : 0;
  apply('highlights', highlights);

  // Whites: lift a dull top end towards white, or tame what still clips.
  let whites = 0;
  if (state.top < W - 1) whites = sliderFor('whites', W - 0.7 - state.top, state.top, state.anchors, 35);
  else if (state.near > W + 0.4) whites = sliderFor('whites', W + 0.2 - state.near, state.near, state.anchors, 35);
  whites = clamp(whites * wbScale, -100, 100);
  apply('whites', whites);

  // Blacks: give a flat image a real black; ease off where large areas are crushed.
  let blacks = 0;
  if (state.bottom > -6) blacks = sliderFor('blacks', -6.5 - state.bottom, state.bottom, state.anchors, 35);
  else if (state.low < -9.5) blacks = sliderFor('blacks', -9.5 - state.low, state.low, state.anchors, 20);
  blacks = clamp(blacks * wbScale, -100, 100);

  // Contrast: a short tonal range gets more, a very long one a little less.
  const range = q(0.95) - q(0.05);
  const picked = range < 5 ? clamp((5 - range) * 10, 0, 30) : range > 9 ? -clamp((range - 9) * 5, 0, 20) : 0;
  const contrast = clamp(picked + P.contrast, -100, 100);

  const round = (x: number) => Math.round(x) || 0;
  return { exposure: ev || 0, contrast: round(contrast), highlights: round(highlights), shadows: round(shadows), whites: round(whites), blacks: round(blacks) };
}
