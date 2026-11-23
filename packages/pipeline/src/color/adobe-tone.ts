// How the Adobe profiles shape tone, fitted to Lightroom.
//
// Adobe's base tone curve is in Lightroom's engine, not in a camera profile, so it can't be read from
// a file. It was measured instead: Fujifilm X-T30 photos exported from Lightroom with Adobe Color and with
// Adobe Standard (every Basic slider at 0), and the editor's own render of the same photo, compared
// pixel by pixel (the two agree on lightness to a correlation of 0.99). Binned by brightness, the
// editor's display lightness maps onto Lightroom's as the knots in adobe-fit-data.ts. The numbers are
// kept there so a refit only changes that file.
//
// Two photos went into it: a dark DR400 scene (a monkey, with one more export at Exposure +1.27 that brings
// the highlights into range) and a daylight portrait at DR100. They do not share one curve: the DR100 photo
// has deeper shadows and a longer highlight roll-off. Lightroom exposes a DR400 raw 2 EV brighter before the
// curve, and the editor's matching exposure leaves the two curves apart, so there are two curves per profile,
// at a baseline exposure of 0 EV and of +2 EV, and the photo's own baseline exposure picks the mix. Canon's
// highlight tone priority and Nikon's Active D-Lighting come out in between, which is a guess.
//
// So this is a fit to two photos, a rough stand-in for Adobe's curve rather than the curve itself.
// Standard is Color with its shadows lifted and its top end a little lower. The chroma gain by lightness is
// the other half: Lightroom's colours are a third more saturated than the editor's in the shadows to
// midtones, and less saturated in the highlights.
import { FIT_DATA } from './adobe-fit-data.ts';

/** Which Adobe profile a tone curve belongs to. */
export type AdobeTone = 'color' | 'standard';

type Knots = readonly (readonly [number, number])[];

const zip = (xs: readonly number[], ys: readonly number[]): Knots => xs.map((x, i) => [x, ys[i]!] as const);

/** The Color base curve of a photo at +2 EV baseline exposure: [editor display lightness, Lightroom display lightness], OKLab L, increasing. */
export const ADOBE_BASE_KNOTS: Knots = zip(FIT_DATA.baseX, FIT_DATA.baseY.color.protectedHighlights);

/** The base curve's knots for a profile and a photo's baseline exposure (EV: 0 plain, 2 Fuji DR400, mixed in between). */
export function adobeBaseKnots(kind: AdobeTone, baselineEv: number): Knots {
  const t = Math.min(1, Math.max(0, baselineEv / 2));
  const { plain, protectedHighlights } = FIT_DATA.baseY[kind];
  return FIT_DATA.baseX.map((x, i) => [x, plain[i]! * (1 - t) + protectedHighlights[i]! * t] as const);
}

const baseCache = new Map<string, Float32Array>();

/** The knots as the shader's vec2 array (uBaseKnots), cached per profile and baseline exposure (to 0.05 EV). */
export function adobeBaseKnotUniform(kind: AdobeTone, baselineEv: number): Float32Array {
  const ev = Math.round(Math.min(2, Math.max(0, baselineEv)) * 20) / 20;
  const key = `${kind}@${ev}`;
  let u = baseCache.get(key);
  if (!u) {
    u = Float32Array.from(adobeBaseKnots(kind, ev).flat());
    baseCache.set(key, u);
  }
  return u;
}

/**
 * The base correction for one display lightness (OKLab L, 0..1). Below the first knot it runs down
 * to black, above the last it runs up to white, so black and white stay put. The shader does the same.
 */
export function adobeBaseLightness(x: number, kind: AdobeTone = 'color', baselineEv = 2): number {
  const knots = adobeBaseKnots(kind, baselineEv);
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

/** How much more (or less) colourful Lightroom's neutral render is than the editor's, by lightness (OKLab L after the correction above): [lightness, chroma gain], increasing. */
export function adobeChromaKnots(kind: AdobeTone): Knots {
  return zip(FIT_DATA.chromaX, FIT_DATA.chromaY[kind]);
}

const chromaCache = new Map<AdobeTone, Float32Array>();

/** The chroma knots as the shader's vec2 array (uChromaKnots). */
export function adobeChromaKnotUniform(kind: AdobeTone): Float32Array {
  let u = chromaCache.get(kind);
  if (!u) {
    u = Float32Array.from(adobeChromaKnots(kind).flat());
    chromaCache.set(kind, u);
  }
  return u;
}

/**
 * The chroma gain at one display lightness: held at the first knot below it, and easing back to 1
 * (white has no colour to scale) above the last.
 */
export function adobeChromaGain(x: number, kind: AdobeTone = 'color'): number {
  const knots = adobeChromaKnots(kind);
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
