// How the Adobe profiles shape tone, fitted to Lightroom.
//
// Adobe's base tone curve is in Lightroom's engine, not in a camera profile, so it can't be read from
// a file. It was measured instead: a Fujifilm X-T30 photo (DR400, Adobe Color, every Basic slider at 0)
// exported from Lightroom, and the editor's own render of the same photo with the Adobe Color
// profile, compared pixel by pixel (the two agree on lightness to a correlation of 0.99). Binned by
// brightness rank, the editor's display lightness maps onto Lightroom's as the knots below. The top
// of the curve comes from a second export of the same photo with Exposure +1.27 and nothing else,
// which brings the highlights into range (the unexposed photo has almost none); there the editor
// ended 0.02 to 0.08 of lightness short of Lightroom in its brightest 5 %. Where the two exports
// overlap they gave the same curve, so it doesn't depend on the exposure.
//
// So this is a fit to one photo, a rough stand-in for Adobe's curve rather than the curve itself. It
// is only used by the Adobe profiles (new ones, so no earlier edit depends on them), where it
// roughly doubles the contrast around mid-grey: the editor's own curve is flatter than Adobe's.
// Held out from the fit, the full edit of that photo came 33 % closer (mean OKLab difference 0.073
// to 0.049), and with only the exposure raised the render is within 0.02 of Lightroom's.

/** [editor display lightness, Lightroom display lightness], OKLab L, increasing. */
export const ADOBE_BASE_KNOTS: readonly (readonly [number, number])[] = [
  [0.1278, 0.0472],
  [0.1462, 0.0847],
  [0.17, 0.1143],
  [0.1944, 0.1416],
  [0.2077, 0.1573],
  [0.2157, 0.1638],
  [0.222, 0.1713],
  [0.2283, 0.1776],
  [0.2349, 0.1859],
  [0.2426, 0.1977],
  [0.252, 0.2134],
  [0.2629, 0.2324],
  [0.2745, 0.2527],
  [0.2858, 0.2726],
  [0.2981, 0.2938],
  [0.3116, 0.3185],
  [0.3257, 0.3423],
  [0.3428, 0.3672],
  [0.3654, 0.4001],
  [0.388, 0.4301],
  [0.4093, 0.4596],
  [0.4198, 0.4879],
  [0.4583, 0.5503],
  [0.5, 0.615],
  [0.5296, 0.6549],
  [0.551, 0.6837],
  [0.5702, 0.709],
  [0.5914, 0.7458],
  [0.6213, 0.7894],
  [0.662, 0.8339],
  [0.6995, 0.8722],
  [0.7643, 0.9206],
  [0.9507, 0.9886],
];

/** The knots as the shader's vec2 array (uBaseKnots). */
export const ADOBE_BASE_KNOT_UNIFORM = Float32Array.from(ADOBE_BASE_KNOTS.flat());

/**
 * How much more colourful Lightroom's neutral render is than the editor's once the lightness matches,
 * by lightness (OKLab L after the correction above): [lightness, chroma gain], increasing. About a
 * third more in the dark to middle tones. Lightroom's was a little lower in the brightest tones
 * (down to 0.85), but that is the top tenth of a dark photo and made a brighter edit worse, so
 * the gain stays at 1 from 0.4 up.
 */
export const ADOBE_CHROMA_KNOTS: readonly (readonly [number, number])[] = [
  [0.1182, 1.1117],
  [0.1611, 1.2136],
  [0.1747, 1.2694],
  [0.1921, 1.318],
  [0.2234, 1.3356],
  [0.2626, 1.2936],
  [0.3063, 1.1991],
  [0.3536, 1.065],
  [0.4159, 1],
  [0.4985, 1],
];

/** The chroma knots as the shader's vec2 array (uChromaKnots). */
export const ADOBE_CHROMA_KNOT_UNIFORM = Float32Array.from(ADOBE_CHROMA_KNOTS.flat());

/**
 * The chroma gain at one display lightness: held at the first knot below it, and easing back to 1
 * (white has no colour to scale) above the last.
 */
export function adobeChromaGain(x: number): number {
  const knots = ADOBE_CHROMA_KNOTS;
  const first = knots[0]!;
  const last = knots[knots.length - 1]!;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return x >= 1 ? 1 : last[1] + ((1 - last[1]) * (x - last[0])) / (1 - last[0]);
  let i = 1;
  while (knots[i]![0] < x) i++;
  const a = knots[i - 1]!;
  const b = knots[i]!;
  return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
}

/**
 * The base correction for one display lightness (OKLab L, 0..1). Below the first knot it runs down
 * to black, above the last it runs up to white, so black and white stay put. The shader does the same.
 */
export function adobeBaseLightness(x: number): number {
  const knots = ADOBE_BASE_KNOTS;
  const first = knots[0]!;
  const last = knots[knots.length - 1]!;
  if (x <= first[0]) return x <= 0 ? 0 : (first[1] * x) / first[0];
  if (x >= last[0]) return x >= 1 ? 1 : last[1] + ((1 - last[1]) * (x - last[0])) / (1 - last[0]);
  let i = 1;
  while (knots[i]![0] < x) i++;
  const a = knots[i - 1]!;
  const b = knots[i]!;
  return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
}
