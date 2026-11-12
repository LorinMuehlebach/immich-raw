// Tone curves (Lightroom's Tone Curve panel), baked into a lookup table.
// Both curves work on display-encoded values 0..1, per RGB channel, like Lightroom:
//   out_c = point_c( point_master( parametric(in_c) ) )
import { isLinearCurve, type CurvePoint, type ToneCurveParams } from '@immich-raw/recipe';

export const LUT_SIZE = 4096;

/**
 * Monotone cubic interpolation (Fritsch-Carlson) through points sorted by x.
 * Never overshoots, so a curve through increasing points stays increasing.
 */
export function monotoneCubic(xs: readonly number[], ys: readonly number[]): (x: number) => number {
  const n = xs.length;
  if (n === 0) return (x) => x;
  if (n === 1) return () => ys[0]!;
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1]! - ys[i]!) / Math.max(1e-9, xs[i + 1]! - xs[i]!));
  const m: number[] = new Array(n);
  m[0] = d[0]!;
  m[n - 1] = d[n - 2]!;
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i]!;
      m[i + 1] = t * b * d[i]!;
    }
  }
  return (x: number) => {
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[n - 1]!) return ys[n - 1]!;
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]!) i++;
    const h = xs[i + 1]! - xs[i]!;
    const t = (x - xs[i]!) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i]! + (t3 - 2 * t2 + t) * h * m[i]! + (-2 * t3 + 3 * t2) * ys[i + 1]! + (t3 - t2) * h * m[i + 1]!
    );
  };
}

export function pointCurve(points: readonly CurvePoint[]): (x: number) => number {
  const f = monotoneCubic(
    points.map((p) => p[0] / 255),
    points.map((p) => p[1] / 255),
  );
  return (x) => Math.min(1, Math.max(0, f(x)));
}

/** How far a parametric slider at ±100 moves its region (display units). */
const PARAMETRIC_REACH = 0.18;

/**
 * Lightroom-style parametric curve: four regions split at shadowSplit / midtoneSplit /
 * highlightSplit; each slider lifts or lowers its region, ends stay fixed.
 */
export function parametricCurve(p: ToneCurveParams['parametric']): (x: number) => number {
  const s1 = p.shadowSplit / 100;
  const s2 = p.midtoneSplit / 100;
  const s3 = p.highlightSplit / 100;
  const xs = [0, s1 / 2, (s1 + s2) / 2, (s2 + s3) / 2, (s3 + 1) / 2, 1];
  const offsets = [0, p.shadows, p.darks, p.lights, p.highlights, 0].map((v) => (v / 100) * PARAMETRIC_REACH);
  const off = monotoneCubic(xs, offsets);
  return (x) => Math.min(1, Math.max(0, x + off(x)));
}

export function isParametricNeutral(p: ToneCurveParams['parametric']): boolean {
  return p.highlights === 0 && p.lights === 0 && p.darks === 0 && p.shadows === 0;
}

export function isCurveNeutral(c: ToneCurveParams): boolean {
  return isParametricNeutral(c.parametric) && Object.values(c.point).every(isLinearCurve);
}

/** RGBA float LUT (A unused), monotone per channel. */
export function buildCurveLut(c: ToneCurveParams, size = LUT_SIZE): Float32Array {
  const param = parametricCurve(c.parametric);
  const master = pointCurve(c.point.master);
  const ch = [pointCurve(c.point.red), pointCurve(c.point.green), pointCurve(c.point.blue)];
  const lut = new Float32Array(size * 4);
  const prev = [0, 0, 0];
  for (let i = 0; i < size; i++) {
    const m = master(param(i / (size - 1)));
    for (let k = 0; k < 3; k++) {
      // parametric offsets can bend a curve slightly backwards; keep it monotone
      const v = Math.max(prev[k]!, ch[k]!(m));
      prev[k] = v;
      lut[i * 4 + k] = v;
    }
    lut[i * 4 + 3] = 1;
  }
  return lut;
}
