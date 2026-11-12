// How each profile renders. Color, Neutral, Linear and Monochrome are today's tone-only
// profiles and render exactly as before. Vivid, Portrait and Landscape add an in-house
// DNG-style look table (built here); the Fujifilm film looks bring a downloaded look table and
// tone curve (fuji-looks.ts), plus a display-space LUT for the three looks that only exist
// as a conversion from Provia.
import { isFujiProfile, profileInfo, type ProfileId } from '@immich-raw/recipe';
import { dngRgbToHsv, type CubeLut, type HueSatTable, type ToneLut } from './dcp.ts';
import { SRGB_TO_PROPHOTO, decodeSrgb } from './look.ts';
import { mulVec3, type Vec3 } from './matrices.ts';

/** Data a profile renders with, beyond its constants. */
export interface ProfileLook {
  lookTable?: HueSatTable;
  toneLut?: ToneLut;
  /** Display-referred sRGB -> sRGB LUT, applied after the tone curve. */
  filmLut?: CubeLut;
}

/** Downloaded profile data (the Fujifilm film looks), by profile. */
export type ProfileLooks = Partial<Record<ProfileId, ProfileLook>>;

export interface ProfileRender {
  /** The profile that renders: the one asked for, or Color when its data is missing. */
  id: ProfileId;
  requested: ProfileId;
  /** A Fujifilm film look was asked for but isn't downloaded: rendering Color instead. */
  missing: boolean;
  /** uProfile: 0 color, 1 neutral, 2 linear, 3 monochrome (base tone and B&W). */
  base: 0 | 1 | 2 | 3;
  /** Exposure added by the profile, EV (at Amount 100 %). */
  baselineEv: number;
  /** Strength of the display S-curve (at Amount 100 %). */
  sCurve: number;
  /** Scene value that renders as white. */
  whitePoint: number;
  /** Blends in and out with the profile Amount. */
  amount: boolean;
  look: ProfileLook | null;
}

/** Color's constants: what every look-based profile fades to at Amount 0. */
const COLOR_EV = 0.35;
const COLOR_S = 0.25;
const COLOR_WHITE = 1.5;

/**
 * Exposure of the Fujifilm looks relative to the scene (their tone curve has its own
 * midtone). Calibrated with e2e/probe-profiles.mjs against an X-T5's own Provia JPEG.
 */
export const FUJI_BASELINE_EV = 0.35;

type Row = Pick<ProfileRender, 'base' | 'baselineEv' | 'sCurve' | 'whitePoint'>;

const BASIC: Record<'color' | 'neutral' | 'linear' | 'monochrome' | 'vivid' | 'portrait' | 'landscape', Row> = {
  color: { base: 0, baselineEv: COLOR_EV, sCurve: COLOR_S, whitePoint: COLOR_WHITE },
  neutral: { base: 1, baselineEv: 0.35, sCurve: 0, whitePoint: 1.8 },
  linear: { base: 2, baselineEv: 0, sCurve: 0, whitePoint: 1 },
  monochrome: { base: 3, baselineEv: 0.35, sCurve: COLOR_S, whitePoint: COLOR_WHITE },
  vivid: { base: 0, baselineEv: COLOR_EV, sCurve: 0.4, whitePoint: COLOR_WHITE },
  portrait: { base: 0, baselineEv: COLOR_EV, sCurve: 0.18, whitePoint: COLOR_WHITE },
  landscape: { base: 0, baselineEv: COLOR_EV, sCurve: 0.32, whitePoint: COLOR_WHITE },
};

/** What renders for a profile, given the downloaded looks. */
export function resolveProfile(id: ProfileId, looks: ProfileLooks = {}): ProfileRender {
  if (isFujiProfile(id)) {
    const look = looks[id];
    if (!look?.lookTable && !look?.toneLut) return { ...resolveProfile('color'), requested: id, missing: true };
    return {
      id,
      requested: id,
      missing: false,
      base: 0,
      baselineEv: FUJI_BASELINE_EV,
      sCurve: 0,
      whitePoint: look.toneLut?.whitePoint ?? COLOR_WHITE,
      amount: true,
      look,
    };
  }
  const row = BASIC[id];
  const inHouse = id === 'vivid' || id === 'portrait' || id === 'landscape';
  return { id, requested: id, missing: false, ...row, amount: profileInfo(id).amount, look: inHouse ? { lookTable: inHouseLook(id) } : null };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Exposure the profile adds at this Amount (%). */
export function profileExposureEv(p: ProfileRender, amountPct: number): number {
  if (!p.amount) return p.baselineEv;
  return COLOR_EV + (p.baselineEv - COLOR_EV) * clamp01(amountPct / 100);
}

/** Scene value that renders as display white (Auto aims the brightest tones below it). */
export function profileWhitePoint(profile: ProfileId | ProfileRender, amountPct = 100): number {
  const p = typeof profile === 'string' ? resolveProfile(profile) : profile;
  if (!p.amount) return p.whitePoint;
  return COLOR_WHITE + (p.whitePoint - COLOR_WHITE) * clamp01(amountPct / 100);
}

export interface ProfileUniforms {
  uProfile: number;
  uLook: number;
  uLookAmount: number;
  uLookSrgb: number;
  uProfileCurve: number;
  uProfileCurveAmount: number;
  uProfileCurveMax: number;
  uSCurveCustom: number;
  uSCurve: number;
  uFilmLut: number;
  uFilmLutAmount: number;
}

/**
 * Tone-pass uniforms. For the four tone-only profiles every new step is off and the S-curve
 * keeps its literal strength, so they render exactly as before.
 */
export function profileUniforms(p: ProfileRender, amountPct: number): ProfileUniforms {
  const a = p.amount ? Math.max(0, amountPct / 100) : 1;
  const on = (has: unknown) => (has && a > 0 ? 1 : 0);
  return {
    uProfile: p.base,
    uLook: on(p.look?.lookTable),
    uLookAmount: a,
    uLookSrgb: p.look?.lookTable?.srgbValues === false ? 0 : 1,
    uProfileCurve: on(p.look?.toneLut),
    uProfileCurveAmount: a,
    uProfileCurveMax: p.look?.toneLut?.max ?? 1,
    uSCurveCustom: p.amount ? 1 : 0,
    uSCurve: p.amount ? Math.max(0, COLOR_S + (p.sCurve - COLOR_S) * a) : COLOR_S,
    uFilmLut: on(p.look?.filmLut),
    uFilmLutAmount: a,
  };
}

// --- In-house looks -------------------------------------------------------------------
// Look tables in the DNG layout (72 hues x 12 saturations x 16 values, sRGB value axis),
// built from smooth functions of hue, saturation and value. Every change fades out toward
// the neutral axis, so greys stay grey and the tone is left to the S-curve.

const HUES = 72;
const SATS = 12;
const VALS = 16;

/** DNG hue (degrees) of an sRGB colour, in linear ProPhoto like the look table. */
function anchorHue(srgb: Vec3): number {
  const lin = srgb.map(decodeSrgb) as unknown as Vec3;
  return dngRgbToHsv(mulVec3(SRGB_TO_PROPHOTO, lin))[0] * 60;
}

const SKIN = anchorHue([0.87, 0.65, 0.53]);
const FOLIAGE = anchorHue([0.35, 0.55, 0.2]);
const SKY = anchorHue([0.35, 0.6, 0.9]);

/** Signed hue distance in degrees, -180..180. */
const hueDist = (h: number, c: number) => ((((h - c + 540) % 360) + 360) % 360) - 180;
const bump = (h: number, c: number, sigma: number) => Math.exp(-0.5 * (hueDist(h, c) / sigma) ** 2);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const chroma = (s: number) => smoothstep(0.02, 0.3, s);
const edge = (s: number) => 1 - 0.6 * smoothstep(0.6, 1, s);
const midtones = (v: number) => 4 * v * (1 - v);

type Node = (h: number, s: number, v: number) => Vec3;

const IN_HOUSE: Record<'vivid' | 'portrait' | 'landscape', Node> = {
  // More saturation everywhere, half as much on skin; a touch brighter in the midtones.
  vivid: (h, s, v) => {
    const c = chroma(s);
    return [0, 1 + 0.25 * c * edge(s) * (1 - 0.5 * bump(h, SKIN, 12)), 1 + 0.03 * c * midtones(v)];
  },
  // Skin hues drawn together (less redness), skin a little less saturated and brighter,
  // other colours a little richer.
  portrait: (h, s, v) => {
    const c = chroma(s);
    const skin = bump(h, SKIN, 25);
    return [-0.3 * hueDist(h, SKIN) * skin * c, 1 + c * (0.05 * (1 - skin) - 0.08 * skin), 1 + 0.04 * c * midtones(v) * skin];
  },
  // Greens toward yellow and blues toward cyan, both richer; skies a little deeper.
  landscape: (h, s, v) => {
    const c = chroma(s);
    const green = bump(h, FOLIAGE, 30);
    const sky = bump(h, SKY, 25);
    return [
      c * (-4 * green - 3 * sky),
      1 + c * edge(s) * (0.08 + 0.22 * green + 0.22 * sky),
      1 - c * midtones(v) * (0.05 * sky + 0.03 * green),
    ];
  },
};

const inHouseCache = new Map<string, HueSatTable>();

/** The look table of Vivid, Portrait or Landscape. */
export function inHouseLook(id: 'vivid' | 'portrait' | 'landscape'): HueSatTable {
  let t = inHouseCache.get(id);
  if (!t) {
    const f = IN_HOUSE[id];
    const data = new Float32Array(HUES * SATS * VALS * 3);
    for (let vi = 0; vi < VALS; vi++) {
      for (let hi = 0; hi < HUES; hi++) {
        for (let si = 0; si < SATS; si++) {
          const i = ((vi * HUES + hi) * SATS + si) * 3;
          const [dh, ds, dv] = f((hi * 360) / HUES, si / (SATS - 1), vi / (VALS - 1));
          data[i] = dh || 0; // no -0
          data[i + 1] = ds;
          data[i + 2] = dv;
        }
      }
    }
    t = { hueDivisions: HUES, satDivisions: SATS, valDivisions: VALS, srgbValues: true, data };
    inHouseCache.set(id, t);
  }
  return t;
}

/** Hue anchors of the in-house looks (degrees, DNG hue in linear ProPhoto); for tests. */
export const LOOK_ANCHORS = { skin: SKIN, foliage: FOLIAGE, sky: SKY } as const;
