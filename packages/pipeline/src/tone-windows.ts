// Where the tone sliders (Shadows, Highlights, Whites, Blacks) act.
//
// Each one works on a band of the photo's own tones: Whites and Highlights near its white point,
// Blacks and Shadows near its black point, the way Lightroom's do. That is what lets Whites +50 change
// a dark photo as much as a bright one: the windows follow the photo's range instead of sitting at
// fixed brightness. The black and white point are the photo's darkest and brightest tones
// (quantiles of its brightness) at the current Exposure, and every slider moves them along with
// the tones it moves, so the next one works on what the last one left.
//
// The amounts and windows are fitted to Lightroom exports of two photos (X-T30): on a dark DR400 scene
// single-slider exports at 20, 50 and 80 and a combined edit, on a daylight DR100 portrait one combined
// edit (the windows searched by coordinate descent on the mean OKLab difference, the portrait counted
// four times). With the monkey alone the windows came out too wide for a bright photo.
// toneBase() in shaders.ts does the same maths per pixel
// (its constants come from here), and Auto uses the functions below to find the slider values.
import { hdrCurve } from './hdr-tone.ts';

/** Middle grey, in stops (log2 of its linear value). The tone stage works in stops from it. */
export const MID = Math.log2(0.18);

export const TONE_WINDOWS = {
  /** The photo's black and white point: these quantiles of its brightness. */
  blackQuantile: 0.001,
  whiteQuantile: 0.995,
  /**
   * `gain`: stops a slider at ±100 would move a tone at full weight if the amount grew linearly. The
   * amount is shaped as 0.5 * (|v| / 0.5) ^ exponent, so ±50 is half the gain for every exponent and
   * a larger exponent makes the slider gentler below ±50 and stronger above. The windows are in stops
   * from the point they follow: Shadows between `start` and `end` above the black point, Highlights
   * from `width` below the white point to `lead` above it, Whites the same, Blacks from `lead` below
   * the black point (negative: above) to `width` above it.
   */
  shadows: { gain: 0.66, exponent: 0.46, start: 0.77, end: 6.15 },
  highlights: { gain: 0.8, exponent: 0.94, width: 3.98, lead: 0.96 },
  whites: { gain: 2.53, exponent: 3.59, width: 4, lead: 2.24 },
  blacks: { gain: 2.46, exponent: 3.14, lead: -0.25, width: 7 },
} as const;

/** A photo's black and white point, in stops from middle grey (at Exposure 0, before HDR and Contrast). */
export interface ToneAnchors {
  black: number;
  white: number;
}

/** Used when a photo's range isn't known: a normally exposed photo. */
export const DEFAULT_ANCHORS: ToneAnchors = { black: -6.5, white: 0.5 };

/** The points are kept at least this far apart, so a flat photo doesn't squeeze the windows. */
const MIN_RANGE = 3;

/** Black and white point of a photo from its log2 luminance samples (as `toneSamples` returns); null without usable samples. */
export function toneAnchors(samples: ArrayLike<number>): ToneAnchors | null {
  const v = Float64Array.from(samples).filter(Number.isFinite).sort();
  if (v.length < 16) return null;
  const at = (q: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))))]! - MID;
  let black = at(TONE_WINDOWS.blackQuantile);
  let white = at(TONE_WINDOWS.whiteQuantile);
  if (white - black < MIN_RANGE) {
    const mid = (white + black) / 2;
    black = mid - MIN_RANGE / 2;
    white = mid + MIN_RANGE / 2;
  }
  return { black, white };
}

export interface ToneAmounts {
  shadows: number;
  highlights: number;
  whites: number;
  blacks: number;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** How far a slider (-1..1) moves a tone at full weight, in stops (the shader does the same). */
export function toneStops(amount: number, w: { gain: number; exponent: number }): number {
  return Math.sign(amount) * 0.5 * (Math.abs(amount) / 0.5) ** w.exponent * w.gain;
}

type Stage = 'shadows' | 'highlights' | 'whites' | 'blacks';

/** The weight of one slider at tone x, given the photo's current black and white point. */
export function toneWeight(stage: Stage, x: number, black: number, white: number): number {
  const w = TONE_WINDOWS;
  switch (stage) {
    case 'shadows':
      return 1 - smooth(black + w.shadows.start, black + w.shadows.end, x);
    case 'highlights':
      return smooth(white - w.highlights.width, white + w.highlights.lead, x);
    case 'whites':
      return smooth(white - w.whites.width, white + w.whites.lead, x);
    case 'blacks':
      return 1 - smooth(black - w.blacks.lead, black + w.blacks.width, x);
  }
}

const ORDER: Stage[] = ['shadows', 'highlights', 'whites', 'blacks'];

/**
 * Moves tones (stops from middle grey, after HDR) through the four sliders, in the shader's order,
 * and returns them with the black and white point as they end up. `upTo` stops after that stage.
 */
export function applyTone(tones: readonly number[], anchors: ToneAnchors, amounts: ToneAmounts, upTo: Stage = 'blacks'): { tones: number[]; anchors: ToneAnchors } {
  let v = [...tones];
  let black = anchors.black;
  let white = anchors.white;
  for (const stage of ORDER) {
    const stops = toneStops(amounts[stage], TONE_WINDOWS[stage]);
    if (stops) {
      const b = black;
      const w = white;
      v = v.map((x) => x + stops * toneWeight(stage, x, b, w));
      black += stops * toneWeight(stage, b, b, w);
      white += stops * toneWeight(stage, w, b, w);
    }
    if (stage === upTo) break;
  }
  return { tones: v, anchors: { black, white } };
}

/** The anchors of a photo as the tone stage sees them at this Exposure and HDR amount (0..1). */
export function bentAnchors(anchors: ToneAnchors, exposure: number, hdr: number): ToneAnchors {
  return { black: hdrCurve(anchors.black + exposure, hdr), white: hdrCurve(anchors.white + exposure, hdr) };
}

/** The windows above as the shader's uniforms (toneBase() in shaders.ts): gain and exponent of the four sliders, then each window. */
export function toneWindowUniforms(w: typeof TONE_WINDOWS = TONE_WINDOWS) {
  return {
    uToneGain: [w.shadows.gain, w.highlights.gain, w.whites.gain, w.blacks.gain],
    uToneExp: [w.shadows.exponent, w.highlights.exponent, w.whites.exponent, w.blacks.exponent],
    uToneShadows: [w.shadows.start, w.shadows.end],
    uToneHighlights: [w.highlights.width, w.highlights.lead],
    uToneWhites: [w.whites.width, w.whites.lead],
    uToneBlacks: [w.blacks.lead, w.blacks.width],
  };
}
