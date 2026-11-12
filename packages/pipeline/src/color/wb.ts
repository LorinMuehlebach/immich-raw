// White balance: camera multipliers <-> Temp/Tint, via the camera's XYZ -> camera matrix
// (LibRaw color_data.cam_xyz). Single-matrix approach; DNG dual-illuminant comes later.
import { type Mat3, type Vec3, inv3, mulVec3, xyToXyz, xyzToXy } from './matrices.ts';
import { type TempTint, tempTintToXy, xyToTempTint } from './temperature.ts';

export const TEMP_MIN = 2000;
export const TEMP_MAX = 50000;
export const TINT_MIN = -150;
export const TINT_MAX = 150;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Multipliers (G = 1) that make a light of the given Temp/Tint neutral. */
export function multipliersForTempTint(camXyz: Mat3, temp: number, tint: number): Vec3 {
  const xyz = xyToXyz(tempTintToXy(temp, tint));
  const neutral = mulVec3(camXyz, xyz).map((v) => Math.max(v, 1e-6)) as unknown as Vec3;
  return [neutral[1] / neutral[0], 1, neutral[1] / neutral[2]];
}

/** Temp/Tint of the light that the given multipliers neutralize. */
export function tempTintForMultipliers(camXyz: Mat3, mul: Vec3): TempTint {
  const neutral: Vec3 = [1 / mul[0], 1 / mul[1], 1 / mul[2]];
  const xyz = mulVec3(inv3(camXyz), neutral);
  const { temp, tint } = xyToTempTint(xyzToXy(xyz));
  return { temp: clamp(temp, TEMP_MIN, TEMP_MAX), tint: clamp(tint, TINT_MIN, TINT_MAX) };
}

const MIRED_MIN = 1e6 / TEMP_MAX;
const MIRED_MAX = 1e6 / TEMP_MIN;

/** 2000..50000 K -> 0..1, linear in mireds (1e6 / T). */
export function tempToSlider(temp: number): number {
  const m = 1e6 / clamp(temp, TEMP_MIN, TEMP_MAX);
  return (MIRED_MAX - m) / (MIRED_MAX - MIRED_MIN);
}

/** 0..1 -> 2000..50000 K, linear in mireds. */
export function sliderToTemp(s: number): number {
  const m = MIRED_MAX - clamp(s, 0, 1) * (MIRED_MAX - MIRED_MIN);
  return 1e6 / m;
}

/** LibRaw cam_mul (R, G, B, G2; any may be 0) -> [R/G, 1, B/G]. */
export function normalizeCamMul(camMul: readonly number[]): Vec3 {
  const pos = (v: number | undefined) => (v !== undefined && Number.isFinite(v) && v > 0 ? v : undefined);
  const g = pos(camMul[1]) ?? pos(camMul[3]) ?? 1;
  const r = pos(camMul[0]) ?? g;
  const b = pos(camMul[2]) ?? g;
  return [r / g, 1, b / g];
}
