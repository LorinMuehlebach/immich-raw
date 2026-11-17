// HDR: range compression of the local tone base layer, for merged brackets and for single RAWs
// with more range than the screen. Like classic HDR tone mapping, it flattens the large-scale
// contrast (the base layer: bright sky against dark ground) and leaves the detail bands
// (clarity, texture, fine detail) alone, so the photo gets less range but keeps its local contrast.
//
// Two steps, in stops relative to middle grey: the whole base layer is scaled towards a pivot
// (this is what makes the slider visible on an ordinary photo), then the far ends bend over
// hyperbolically so no highlight or shadow stays out of reach however extreme it was.
//
// The shader (toneBase in shaders.ts) is built from HDR_GLSL, so both use these constants.

/**
 * pivot: the tone that stays put (about where a photo's typical tone sits after Auto);
 * scale: how much of the range around it is taken away at amount 1 (0.45: 6 stops become 3.3);
 * hi, lo: where the ends start to bend (after scaling), hiK and loK how hard.
 */
export const HDR_TONE = { pivot: -0.5, scale: 0.45, hi: 1.5, hiK: 0.25, lo: -3.5, loK: 0.12 } as const;

/**
 * Base-layer tone x (stops from middle grey) after HDR compression of `amount` (0..1).
 * Increasing in x and continuous; the highlights approach hi + 1/(hiK x amount) however bright.
 */
export function hdrCurve(x: number, amount: number): number {
  if (!(amount > 0)) return x;
  const { pivot, scale, hi, hiK, lo, loK } = HDR_TONE;
  const y = pivot + (x - pivot) * (1 - scale * amount);
  if (y > hi) {
    const d = y - hi;
    return hi + d / (1 + hiK * amount * d);
  }
  if (y < lo) {
    const d = lo - y;
    return lo - d / (1 + loK * amount * d);
  }
  return y;
}

const f = (v: number) => v.toFixed(4);

export const HDR_GLSL = /* glsl */ `
// HDR range compression of the tone base (hdr-tone.ts, hdrCurve).
float hdrCompress(float x, float h) {
  if (h <= 0.0) return x;
  float y = ${f(HDR_TONE.pivot)} + (x - (${f(HDR_TONE.pivot)})) * (1.0 - ${f(HDR_TONE.scale)} * h);
  if (y > ${f(HDR_TONE.hi)}) {
    float d = y - ${f(HDR_TONE.hi)};
    return ${f(HDR_TONE.hi)} + d / (1.0 + ${f(HDR_TONE.hiK)} * h * d);
  }
  if (y < ${f(HDR_TONE.lo)}) {
    float d = ${f(HDR_TONE.lo)} - y;
    return ${f(HDR_TONE.lo)} - d / (1.0 + ${f(HDR_TONE.loK)} * h * d);
  }
  return y;
}
`;
