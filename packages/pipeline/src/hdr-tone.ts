// HDR: range compression of the local tone base layer, for merged brackets and for single RAWs
// with more range than the screen. Above HI and below LO stops (relative to middle grey) the
// base layer bends over hyperbolically, so the brightest and darkest areas move towards the
// midtones while the detail bands (clarity, texture, fine detail) stay as they are.
//
// The shader (toneBase in shaders.ts) is built from HDR_GLSL, so both use these constants.

/** Knees, in stops from middle grey, and how hard each side bends at amount 1. */
export const HDR_TONE = { hi: 0.5, hiK: 0.35, lo: -1.5, loK: 0.15 } as const;

/**
 * Base-layer tone x (stops from middle grey) after HDR compression of `amount` (0..1). Slope 1
 * at the knees, so there is no visible edge where compression starts. At amount 1 the
 * highlights approach hi + 1/hiK (~3.4 stops over grey, just past white) however bright they were.
 */
export function hdrCurve(x: number, amount: number): number {
  if (!(amount > 0)) return x;
  const { hi, hiK, lo, loK } = HDR_TONE;
  if (x > hi) {
    const d = x - hi;
    return hi + d / (1 + hiK * amount * d);
  }
  if (x < lo) {
    const d = lo - x;
    return lo - d / (1 + loK * amount * d);
  }
  return x;
}

export const HDR_GLSL = /* glsl */ `
// HDR range compression of the tone base (hdr-tone.ts, hdrCurve).
float hdrCompress(float x, float h) {
  if (h <= 0.0) return x;
  if (x > ${HDR_TONE.hi.toFixed(4)}) {
    float d = x - ${HDR_TONE.hi.toFixed(4)};
    return ${HDR_TONE.hi.toFixed(4)} + d / (1.0 + ${HDR_TONE.hiK.toFixed(4)} * h * d);
  }
  if (x < ${HDR_TONE.lo.toFixed(4)}) {
    float d = ${HDR_TONE.lo.toFixed(4)} - x;
    return ${HDR_TONE.lo.toFixed(4)} - d / (1.0 + ${HDR_TONE.loK.toFixed(4)} * h * d);
  }
  return x;
}
`;

/** Amount (0..1) at which hdrCurve maps a tone `d` stops past a knee to `target` stops past it. */
export function hdrAmountFor(d: number, target: number, k: number): number {
  if (d <= target || target <= 0) return 0;
  return (d / target - 1) / (k * d);
}
