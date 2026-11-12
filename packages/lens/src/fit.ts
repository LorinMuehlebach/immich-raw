// Least-squares helpers for re-expressing radial models that the renderer's polynomial
// cannot hold exactly (Lensfun poly3 TCA composed with distortion, WarpRectilinear2).
import type { RadialPoly } from './types.ts';

/**
 * Solves min |A x - b|² with Householder QR (better conditioned than normal equations).
 * `rows` is A, one array per sample.
 */
export function leastSquares(rows: number[][], b: number[]): number[] {
  const m = rows.length;
  const n = rows[0]?.length ?? 0;
  const a = rows.map((r) => r.slice());
  const y = b.slice();
  for (let k = 0; k < n; k++) {
    let norm = 0;
    for (let i = k; i < m; i++) norm += a[i]![k]! ** 2;
    norm = Math.sqrt(norm);
    if (norm === 0) continue;
    const alpha = a[k]![k]! > 0 ? -norm : norm;
    const v: number[] = new Array(m).fill(0);
    for (let i = k; i < m; i++) v[i] = a[i]![k]!;
    v[k]! -= alpha;
    let vv = 0;
    for (let i = k; i < m; i++) vv += v[i]! ** 2;
    if (vv === 0) continue;
    for (let j = k; j < n; j++) {
      let s = 0;
      for (let i = k; i < m; i++) s += v[i]! * a[i]![j]!;
      s = (2 * s) / vv;
      for (let i = k; i < m; i++) a[i]![j]! -= s * v[i]!;
    }
    let s = 0;
    for (let i = k; i < m; i++) s += v[i]! * y[i]!;
    s = (2 * s) / vv;
    for (let i = k; i < m; i++) y[i]! -= s * v[i]!;
  }
  const x: number[] = new Array(n).fill(0);
  for (let k = n - 1; k >= 0; k--) {
    let s = y[k]!;
    for (let j = k + 1; j < n; j++) s -= a[k]![j]! * x[j]!;
    x[k] = a[k]![k]! === 0 ? 0 : s / a[k]![k]!;
  }
  return x;
}

/**
 * Fits r_src(r) ≈ r · (c0 + c1 r + … + c6 r⁶) on r ∈ [0, range], minimising the error of
 * r_src itself (i.e. in radius units, which is what shows up as pixels). Samples sit on
 * Chebyshev nodes to keep the worst case close to the RMS optimum. The fit runs in
 * t = r / range so the system stays well conditioned for any range.
 */
export function fitRadialPoly(target: (r: number) => number, range: number, samples = 400): RadialPoly {
  const rows: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / samples);
    const row: number[] = [];
    for (let p = 0; p < 7; p++) row.push(t ** (p + 1));
    rows.push(row);
    b.push(target(t * range) / range);
  }
  const d = leastSquares(rows, b);
  return d.map((c, p) => c / range ** p) as RadialPoly;
}
