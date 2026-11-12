// CPU reference for evaluating a LensCorrection, the specification the shader follows.
//
// All points are normalised source coordinates: [0,1]² over the decoded image, sensor
// orientation, y down, (0.5, 0.5) the image centre.
import type { LensCorrection, RadialPoly } from './types.ts';

/** Σ p[i] r^i (Horner). */
export function evalRadial(p: RadialPoly, r: number): number {
  let s = 0;
  for (let i = 6; i >= 0; i--) s = s * r + p[i]!;
  return s;
}

/**
 * Where the ideal (corrected) point (x, y) lies in the decoded image for one channel
 * (0 = R, 1 = G, 2 = B):
 *   d = (s - center) · scale, r = |d|, r_src = r · Σ poly[c][i] r^i,
 *   s_src = center + (s - center) · r_src / r   (s at r = 0).
 */
export function sourcePoint(corr: LensCorrection, x: number, y: number, channel: 0 | 1 | 2): [number, number] {
  const g = corr.geometry;
  if (!g) return [x, y];
  const ox = x - g.center[0];
  const oy = y - g.center[1];
  const r = Math.hypot(ox * g.scale[0], oy * g.scale[1]);
  if (r === 0) return [x, y];
  const f = evalRadial(g.poly[channel], r);
  return [g.center[0] + ox * f, g.center[1] + oy * f];
}

/**
 * Factor to multiply a decoded pixel value by to remove vignetting, for the point (x, y)
 * *in the decoded image* (for a corrected output pixel that is sourcePoint(…, 1), the
 * green source position). g(r) = 1 + k0 r² + k1 r⁴ + … + k4 r¹⁰ in the vignetting frame;
 * the factor is g for 'multiply' and 1 / g for 'divide'.
 */
export function vignetteGain(corr: LensCorrection, x: number, y: number): number {
  const v = corr.vignetting;
  if (!v) return 1;
  const dx = (x - v.center[0]) * v.scale[0];
  const dy = (y - v.center[1]) * v.scale[1];
  const r2 = dx * dx + dy * dy;
  const [k0, k1, k2, k3, k4] = v.k;
  const g = 1 + r2 * (k0 + r2 * (k1 + r2 * (k2 + r2 * (k3 + r2 * k4))));
  return v.mode === 'multiply' ? g : 1 / g;
}

/**
 * An output point is usable when all three channels sample inside the decoded image and
 * the mapping still grows with the radius there: past that fold (strong barrel models
 * extrapolated beyond their calibration) the image would repeat mirrored.
 */
function inside(corr: LensCorrection, x: number, y: number): boolean {
  const g = corr.geometry!;
  const r = Math.hypot((x - g.center[0]) * g.scale[0], (y - g.center[1]) * g.scale[1]);
  for (const c of [0, 1, 2] as const) {
    const [sx, sy] = sourcePoint(corr, x, y, c);
    if (!(sx >= 0 && sx <= 1 && sy >= 0 && sy <= 1)) return false;
    // d(r · P(r)) / dr = Σ (i + 1) p[i] rⁱ
    const p = g.poly[c];
    let slope = 0;
    for (let i = 6; i >= 0; i--) slope = slope * r + (i + 1) * p[i]!;
    if (!(slope > 0)) return false;
  }
  return true;
}

/**
 * Zoom that makes the corrected image just fill the frame, without blank areas, like
 * Lightroom's auto-scaled profile corrections and Lensfun's lfModifier::GetAutoScale.
 *
 * Meaning: the renderer maps output point s (normalised, [0,1]² over the frame) to the
 * ideal point s' = 0.5 + (s - 0.5) / zoom and samples sourcePoint(s'). zoom > 1 crops in
 * (needed when the correction pulls the borders inwards, as for pincushion distortion);
 * zoom < 1 shows more (correcting barrel distortion leaves source pixels outside the
 * frame). The frame is the decoded image; its aspect ratio is implied by geometry.scale.
 *
 * Lensfun checks 8 border points of the green channel and adds 0.1 % for TCA. This walks
 * rays from the centre to 4 × `samples` border points and checks all three channels: for
 * each ray it finds where the source first leaves the image or the mapping folds back
 * (stepping, then bisection) and takes the largest zoom that ray needs.
 */
export function autoScale(corr: LensCorrection, samples = 64): number {
  if (!corr.geometry) return 1;
  const T_MAX = 4;
  const STEPS = 128;
  let zoom = 1 / T_MAX;
  for (let side = 0; side < 4; side++) {
    for (let i = 0; i < samples; i++) {
      const u = i / samples;
      const [bx, by] = side === 0 ? [u, 0] : side === 1 ? [1, u] : side === 2 ? [1 - u, 1] : [0, 1 - u];
      const at = (t: number) => inside(corr, 0.5 + t * (bx - 0.5), 0.5 + t * (by - 0.5));
      let lo = 0;
      let hi = T_MAX;
      for (let k = 1; k <= STEPS; k++) {
        const t = (k / STEPS) * T_MAX;
        if (!at(t)) {
          hi = t;
          break;
        }
        lo = t;
      }
      if (hi === T_MAX && at(T_MAX)) continue;
      for (let k = 0; k < 40; k++) {
        const mid = 0.5 * (lo + hi);
        if (at(mid)) lo = mid;
        else hi = mid;
      }
      zoom = Math.max(zoom, 1 / Math.max(lo, 1e-6));
    }
  }
  return zoom;
}
