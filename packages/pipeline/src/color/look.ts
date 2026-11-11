// Color Mixer, Color Grading and Calibration maths, shared by the shader uniforms, the
// targeted-adjustment tool and the tests.
//
// Hues are OKLab hue angles in radians (atan2(b, a)), so the bands and wheels behave the
// same at any exposure. Lightroom's band centres and wheel angles are HSV hues of sRGB
// colours; they are converted here once.
import type { Band, CalibrationParams, ColorGradingParams, Recipe } from '@immich-raw/recipe';
import { BANDS, WHEELS } from '@immich-raw/recipe';
import {
  IDENTITY3,
  OKLAB_M2,
  SRGB_TO_XYZ_D65,
  WHITE_D65_XYZ,
  XYZ_D65_TO_LMS_OKLAB,
  XYZ_D65_TO_SRGB,
  inv3,
  mul3,
  mulVec3,
  rgbToXyzMatrix,
  type Chromaticity,
  type Mat3,
  type Vec3,
} from './matrices.ts';
import { PROPHOTO_TO_SRGB } from './spaces.ts';

const TAU = Math.PI * 2;

/** Linear sRGB -> OKLab LMS (before the cube root), and back. */
export const SRGB_TO_LMS: Mat3 = mul3(XYZ_D65_TO_LMS_OKLAB, SRGB_TO_XYZ_D65);
export const LMS_TO_SRGB: Mat3 = inv3(SRGB_TO_LMS);
export const SRGB_TO_PROPHOTO: Mat3 = inv3(PROPHOTO_TO_SRGB);

export const decodeSrgb = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

export function linearSrgbToOklab(rgb: Vec3): Vec3 {
  const lms = mulVec3(SRGB_TO_LMS, rgb);
  return mulVec3(OKLAB_M2, [Math.cbrt(lms[0]), Math.cbrt(lms[1]), Math.cbrt(lms[2])]);
}

/** OKLab hue (0..2π) of a linear sRGB colour. */
export function oklabHue(rgb: Vec3): number {
  const [, a, b] = linearSrgbToOklab(rgb);
  const h = Math.atan2(b, a);
  return h < 0 ? h + TAU : h;
}

/** Fully saturated sRGB colour (linear) for an HSV hue in degrees. */
export function hsvHueToLinear(deg: number): Vec3 {
  const h = (((deg % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b] = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
  return [decodeSrgb(r), decodeSrgb(g), decodeSrgb(b)];
}

/** Lightroom's band centres as HSV hues: red, orange, yellow, green, aqua, blue, purple, magenta. */
const BAND_HSV = [0, 30, 60, 120, 180, 240, 270, 300];

/** The band centres as OKLab hues (ascending). */
export const BAND_HUES: readonly number[] = BAND_HSV.map((h) => oklabHue(hsvHueToLinear(h)));

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * How much each band applies at OKLab hue `h`: the two neighbouring bands share it,
 * blending smoothly in between (weights sum to 1). The shader's bandValue() matches this.
 */
export function bandWeights(h: number): number[] {
  const w = new Array<number>(8).fill(0);
  const h0 = BAND_HUES[0]!;
  const x = h0 + ((((h - h0) % TAU) + TAU) % TAU);
  for (let i = 0; i < 8; i++) {
    const a = BAND_HUES[i]!;
    const b = i === 7 ? h0 + TAU : BAND_HUES[i + 1]!;
    if (x <= b) {
      const f = smooth(a, b, x);
      w[i] = 1 - f;
      w[(i + 1) % 8]! += f;
      return w;
    }
  }
  w[0] = 1;
  return w;
}

/** Hue of a display colour (sRGB-encoded 0..1), for the targeted adjustment tool. */
export function displayHue(rgb: Vec3): number {
  return oklabHue([decodeSrgb(rgb[0]), decodeSrgb(rgb[1]), decodeSrgb(rgb[2])]);
}

// ------------------------------------------------------------------ Color Mixer

/** A ±100 hue shift moves a band this far towards its neighbour. */
const HUE_REACH = 0.6;

export interface MixerUniforms {
  uMixer: number;
  uBwMix: number;
  uBandHue: Float32Array;
  /** Hue shift per band, radians. */
  uMixHue: Float32Array;
  /** Chroma gain - 1 per band. */
  uMixSat: Float32Array;
  /** Lightness change per band, -1..1. */
  uMixLum: Float32Array;
  /** B&W mix per band, -1..1. */
  uBw: Float32Array;
}

const bandArray = (values: Record<Band, number>, f: (v: number, i: number) => number = (v) => v) =>
  new Float32Array(BANDS.map((b, i) => f(values[b] / 100, i)));

export function mixerUniforms(recipe: Recipe): MixerUniforms {
  const m = recipe.colorMixer;
  const gap = (i: number, j: number) => ((((BAND_HUES[j]! - BAND_HUES[i]!) % TAU) + TAU) % TAU) * HUE_REACH;
  const mono = recipe.profile === 'monochrome';
  const any = (r: Record<Band, number>) => BANDS.some((b) => r[b] !== 0);
  return {
    uMixer: !mono && (any(m.hue) || any(m.saturation) || any(m.luminance)) ? 1 : 0,
    uBwMix: mono && any(recipe.bwMix) ? 1 : 0,
    uBandHue: new Float32Array(BAND_HUES),
    // Positive moves towards the next band (red -> orange), negative towards the previous one.
    uMixHue: bandArray(m.hue, (v, i) => (v >= 0 ? v * gap(i, (i + 1) % 8) : v * gap((i + 7) % 8, i))),
    uMixSat: bandArray(m.saturation),
    uMixLum: bandArray(m.luminance),
    uBw: bandArray(recipe.bwMix),
  };
}

// ------------------------------------------------------------------ Color Grading

/** OKLab chroma a wheel adds at saturation 100 (skin is around 0.08). */
const GRADE_CHROMA = 0.1;
/** OKLab lightness a wheel's luminance ±100 adds. */
const GRADE_LIGHT = 0.2;

/** OKLab (a, b) offset for a wheel position: Lightroom hue in degrees, saturation 0..100. */
export function gradeTint(hue: number, sat: number): [number, number] {
  if (sat <= 0) return [0, 0];
  const [, a, b] = linearSrgbToOklab(hsvHueToLinear(hue));
  const len = Math.hypot(a, b) || 1;
  const k = (Math.min(100, sat) / 100) * GRADE_CHROMA;
  return [(a / len) * k, (b / len) * k];
}

export function isGradingActive(g: ColorGradingParams): boolean {
  return WHEELS.some((w) => g[w].sat > 0 || g[w].lum !== 0);
}

export interface GradingUniforms {
  uGrading: number;
  /** (a, b) offsets: shadows, midtones, highlights, global. */
  uGradeAB: Float32Array;
  /** Lightness offsets: shadows, midtones, highlights, global. */
  uGradeLum: number[];
  /** Tone (OKLab L) where shadows meet highlights, and the weight exponent (from Blending). */
  uGradeShape: number[];
}

export function gradingUniforms(recipe: Recipe): GradingUniforms {
  const g = recipe.colorGrading;
  const ab = new Float32Array(8);
  WHEELS.forEach((w, i) => ab.set(gradeTint(g[w].hue, g[w].sat), i * 2));
  const blend = g.blending / 100;
  return {
    uGrading: isGradingActive(g) ? 1 : 0,
    uGradeAB: ab,
    uGradeLum: WHEELS.map((w) => (g[w].lum / 100) * GRADE_LIGHT),
    // More blending = flatter weights = wider overlap. Positive balance favours highlights.
    uGradeShape: [Math.min(0.85, Math.max(0.15, 0.55 - 0.3 * (g.balance / 100))), 4 - 2.4 * blend],
  };
}

/** Shadow / midtone / highlight weights at OKLab lightness L (same as the shader). */
export function gradingWeights(L: number, shape: readonly number[]): [number, number, number] {
  const y = Math.min(1, Math.max(0, L));
  const p = shape[0]!;
  const t = y < p ? (0.5 * y) / p : 0.5 + (0.5 * (y - p)) / (1 - p);
  const ws = (1 - t) ** shape[1]!;
  const wh = t ** shape[1]!;
  return [ws, Math.max(0, 1 - ws - wh), wh];
}

// ------------------------------------------------------------------ Calibration

/** A ±100 primary hue rotates the primary this far around white (u'v', radians). */
const CAL_HUE = 0.4;
/** A ±100 primary saturation moves the primary this share of its distance from white. */
const CAL_SAT = 0.45;

const SRGB_PRIMARIES: Chromaticity[] = [
  { x: 0.64, y: 0.33 },
  { x: 0.3, y: 0.6 },
  { x: 0.15, y: 0.06 },
];
const D65: Chromaticity = { x: 0.3127, y: 0.329 };

const toUv = ({ x, y }: Chromaticity): [number, number] => {
  const d = -2 * x + 12 * y + 3;
  return [(4 * x) / d, (9 * y) / d];
};
const fromUv = (u: number, v: number): Chromaticity => {
  const d = 6 * u - 16 * v + 12;
  return { x: (9 * u) / d, y: (4 * v) / d };
};

export function isCalibrationNeutral(c: CalibrationParams): boolean {
  return !c.redHue && !c.redSaturation && !c.greenHue && !c.greenSaturation && !c.blueHue && !c.blueSaturation;
}

/**
 * Linear ProPhoto -> linear ProPhoto matrix for the primaries' hue and saturation.
 * The red, green and blue primaries (sRGB's, so it acts the same for every camera) are
 * rotated around white and moved towards or away from it, then the colours are
 * re-expressed with the original primaries. White stays white.
 * Positive hue turns red towards yellow, green towards aqua and blue towards purple.
 */
export function calibrationMatrix(c: CalibrationParams): Mat3 {
  if (isCalibrationNeutral(c)) return IDENTITY3;
  const [wu, wv] = toUv(D65);
  const adj: [number, number][] = [
    [c.redHue, c.redSaturation],
    [c.greenHue, c.greenSaturation],
    [c.blueHue, c.blueSaturation],
  ];
  const moved = SRGB_PRIMARIES.map((p, i) => {
    const [u, v] = toUv(p);
    const a = (adj[i]![0] / 100) * CAL_HUE;
    const s = 1 + (adj[i]![1] / 100) * CAL_SAT;
    const du = u - wu;
    const dv = v - wv;
    return fromUv(wu + (du * Math.cos(a) - dv * Math.sin(a)) * s, wv + (du * Math.sin(a) + dv * Math.cos(a)) * s);
  });
  const modToXyz = rgbToXyzMatrix(moved[0]!, moved[1]!, moved[2]!, WHITE_D65_XYZ);
  const inSrgb = mul3(XYZ_D65_TO_SRGB, modToXyz);
  return mul3(SRGB_TO_PROPHOTO, mul3(inSrgb, PROPHOTO_TO_SRGB));
}
