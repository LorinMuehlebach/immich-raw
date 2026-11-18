// The colour of the Color profile, built from scratch: no Adobe data in it.
//
// It is a smooth function of OKLab hue: how much more (or less) colourful, and how far turned, the
// colours of a Lightroom "Adobe Color" render are than the editor's own base render of the same
// photo (after the tone correction in adobe-tone.ts). It was measured on Lightroom exports of one
// photo, pixel by pixel, so it only knows the hues that photo has (browns and oranges, greys with a
// violet cast, olive greens, a white flower); the other hues keep the average of what was
// measured. It is written as a look table, the same kind the in-house looks use.
import { dngHsvToRgb, dngRgbToHsv, type HueSatTable } from './dcp.ts';
import { decodeSrgb } from './look.ts';
import { mulVec3, type Vec3 } from './matrices.ts';
import { LMS_TO_PROPHOTO, PROPHOTO_TO_LMS } from './spaces.ts';

/** Hue bins of 15 degrees, bin i centred on i * 15 (OKLab hue, degrees from the a axis towards b). */
export const COLOR_FIT_BINS = 24;

export const COLOR_FIT = {
  /** Chroma gain per hue bin (1 = as the base render). */
  gain: [1.25, 1.25, 1.25, 1.25, 1.25, 1.169, 1.111, 1.11, 1.095, 1.064, 1.05, 1.05, 1.05, 1.05, 1.05, 1.05, 1.05, 1.057, 1.063, 1.045, 1.024, 1.052, 1.154, 1.25],
  /** Hue turn per bin, degrees (positive = towards +b). */
  turn: [3.025, 0.406, -3.176, -7.277, -8, -8, -8, -6.215, -2.14, -0.259, 0, 0, 0, 0, 0, 0, 0, -0.541, -1.564, -1.117, 1.251, 3.36, 4.079, 4.035],
};

/** Periodic linear interpolation of per-bin values at a hue in degrees. */
export function atHue(values: readonly number[], hue: number): number {
  const n = values.length;
  const x = (((hue % 360) + 360) % 360) / (360 / n);
  const i = Math.floor(x);
  const f = x - i;
  return values[i % n]! * (1 - f) + values[(i + 1) % n]! * f;
}

const HUES = 72;
const SATS = 12;
const VALS = 16;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const encodeSrgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

const cbrt3 = (v: Vec3): Vec3 => [Math.cbrt(v[0]), Math.cbrt(v[1]), Math.cbrt(v[2])];

function toLab(rgb: Vec3): Vec3 {
  const [l, m, s] = cbrt3(mulVec3(PROPHOTO_TO_LMS, rgb));
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function fromLab([L, a, b]: Vec3): Vec3 {
  const l = L + 0.3963377774 * a + 0.2158037573 * b;
  const m = L - 0.1055613458 * a - 0.0638541728 * b;
  const s = L - 0.0894841775 * a - 1.2914855480 * b;
  return mulVec3(LMS_TO_PROPHOTO, [l * l * l, m * m * m, s * s * s]);
}

/** The colour at a table node (DNG hue in degrees, saturation, sRGB-encoded value) after the fit, as a node's [hue shift, saturation scale, value scale]. */
export function fittedNode(hueDeg: number, s: number, vEnc: number, fit: { gain: readonly number[]; turn: readonly number[] } = COLOR_FIT): Vec3 {
  if (!(s > 0) || !(vEnc > 0)) return [0, 1, 1];
  const v = decodeSrgb(vEnc);
  const rgb = dngHsvToRgb([hueDeg / 60, s, v]);
  const [L, a, b] = toLab(rgb);
  const C = Math.hypot(a, b);
  if (C < 1e-5) return [0, 1, 1];
  const hue = (Math.atan2(b, a) * 180) / Math.PI;
  // Greys stay grey: the change fades in over the first bit of saturation.
  const w = smoothstep(0.02, 0.3, s);
  const gain = 1 + (atHue(fit.gain, hue) - 1) * w;
  const turn = (atHue(fit.turn, hue) * w * Math.PI) / 180;
  const out = fromLab([L, gain * C * Math.cos(Math.atan2(b, a) + turn), gain * C * Math.sin(Math.atan2(b, a) + turn)]);
  const [h2, s2, v2] = dngRgbToHsv([Math.max(out[0], 0), Math.max(out[1], 0), Math.max(out[2], 0)]);
  if (!(v2 > 0)) return [0, 1, 1];
  let dh = (h2 - hueDeg / 60) * 60;
  dh -= 360 * Math.round(dh / 360);
  return [dh, Math.min(s2, 1) / s, encodeSrgb(Math.min(v2, 1)) / vEnc];
}

let cache: { key: string; table: HueSatTable } | null = null;

/** The look table of the fitted Color. */
export function fittedColorLook(fit: { gain: readonly number[]; turn: readonly number[] } = COLOR_FIT): HueSatTable {
  const key = JSON.stringify(fit);
  if (cache?.key === key) return cache.table;
  const data = new Float32Array(HUES * SATS * VALS * 3);
  for (let vi = 0; vi < VALS; vi++) {
    for (let hi = 0; hi < HUES; hi++) {
      for (let si = 0; si < SATS; si++) {
        const i = ((vi * HUES + hi) * SATS + si) * 3;
        const [dh, ds, dv] = fittedNode((hi * 360) / HUES, si / (SATS - 1), vi / (VALS - 1), fit);
        data[i] = dh || 0;
        data[i + 1] = ds;
        data[i + 2] = dv;
      }
    }
  }
  const table: HueSatTable = { hueDivisions: HUES, satDivisions: SATS, valDivisions: VALS, srgbValues: true, data };
  cache = { key, table };
  return table;
}
