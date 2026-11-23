import { defaultRecipe } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { CAMERAS } from './color/fixtures.ts';
import { DEFAULT_ANCHORS, MID, TONE_WINDOWS, applyTone, bentAnchors, toneAnchors, toneStops, toneWeight, toneWindowUniforms, type ToneAmounts } from './tone-windows.ts';
import { cameraInfo, developUniforms } from './uniforms.ts';

const none: ToneAmounts = { shadows: 0, highlights: 0, whites: 0, blacks: 0 };
const anchors = { black: -6, white: 0 };

/** n samples spread evenly over [a, b] (log2 luminance, as toneSamples returns). */
const spread = (a: number, b: number, n = 2000) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

describe('the photo\'s black and white point', () => {
  it('are quantiles of its brightness, in stops from middle grey', () => {
    const a = toneAnchors(spread(MID - 7, MID + 1))!;
    expect(a.black).toBeCloseTo(-7 + 8 * TONE_WINDOWS.blackQuantile, 1);
    expect(a.white).toBeCloseTo(-7 + 8 * TONE_WINDOWS.whiteQuantile, 1);
  });

  it('follow the photo: a dark photo has its points lower than a bright one', () => {
    const dark = toneAnchors(spread(MID - 9, MID - 2))!;
    const bright = toneAnchors(spread(MID - 5, MID + 3))!;
    expect(dark.white).toBeLessThan(bright.white - 4);
    expect(dark.black).toBeLessThan(bright.black - 3);
  });

  it('are kept 3 stops apart on a flat photo, and are null without samples', () => {
    const flat = toneAnchors(spread(MID - 0.2, MID + 0.2))!;
    expect(flat.white - flat.black).toBeCloseTo(3, 9);
    expect((flat.white + flat.black) / 2).toBeCloseTo(0, 1);
    expect(toneAnchors([])).toBeNull();
    expect(toneAnchors([...spread(MID - 3, MID, 10), NaN])).toBeNull();
    expect(toneAnchors([...spread(MID - 5, MID, 100), NaN, Infinity])).not.toBeNull();
  });

  it('move with Exposure, and are bent by HDR like the tones', () => {
    expect(bentAnchors({ black: -6, white: 0 }, 1.5, 0)).toEqual({ black: -4.5, white: 1.5 });
    const bent = bentAnchors({ black: -6, white: 3 }, 0, 1);
    expect(bent.white).toBeLessThan(3);
    expect(bent.black).toBeGreaterThan(-6);
  });
});

describe('what a slider does', () => {
  it('moves a tone by half the gain at ±50, whatever the exponent, and by more or less above and below', () => {
    for (const k of ['shadows', 'highlights', 'whites', 'blacks'] as const) {
      const w = TONE_WINDOWS[k];
      expect(toneStops(0.5, w)).toBeCloseTo(w.gain / 2, 9);
      expect(toneStops(-0.5, w)).toBeCloseTo(-w.gain / 2, 9);
      expect(toneStops(0, w)).toBe(0);
    }
    // Whites grows much faster than linearly (Lightroom's does).
    expect(toneStops(0.8, TONE_WINDOWS.whites) / toneStops(0.5, TONE_WINDOWS.whites)).toBeGreaterThan(4);
    expect(toneStops(0.2, TONE_WINDOWS.whites) / toneStops(0.5, TONE_WINDOWS.whites)).toBeLessThan(0.1);
  });

  it('works on a band of the photo\'s own range, not on fixed brightness', () => {
    // Highlights and Whites reach the white point, Shadows and Blacks the black point.
    expect(toneWeight('highlights', anchors.white, anchors.black, anchors.white)).toBeGreaterThan(0.8);
    expect(toneWeight('whites', anchors.white, anchors.black, anchors.white)).toBeGreaterThan(0.6);
    expect(toneWeight('shadows', anchors.black, anchors.black, anchors.white)).toBe(1);
    expect(toneWeight('blacks', anchors.black, anchors.black, anchors.white)).toBe(1);
    // and not the other end
    expect(toneWeight('highlights', anchors.black, anchors.black, anchors.white)).toBe(0);
    expect(toneWeight('whites', anchors.black, anchors.black, anchors.white)).toBe(0);
    expect(toneWeight('shadows', anchors.white, anchors.black, anchors.white)).toBeLessThan(0.01);
    expect(toneWeight('blacks', anchors.white, anchors.black, anchors.white)).toBeLessThan(0.1);
    // The same tone is "highlights" in a dark photo and "shadows" in a bright one.
    expect(toneWeight('highlights', -1.5, -9, -1)).toBeGreaterThan(0.5);
    expect(toneWeight('highlights', -2, -6, 3)).toBe(0);
  });

  it('leaves everything alone at 0', () => {
    expect(applyTone([-5, -2, 0], anchors, none)).toEqual({ tones: [-5, -2, 0], anchors });
  });

  it('moves the tones in their band, and the points with them', () => {
    const down = applyTone([anchors.white, anchors.black], anchors, { ...none, highlights: -0.5 });
    expect(down.tones[0]).toBeLessThan(anchors.white - 0.3);
    expect(down.tones[1]).toBe(anchors.black); // nothing happens down there
    expect(down.anchors.white).toBeCloseTo(down.tones[0]!, 9);
    expect(down.anchors.black).toBe(anchors.black);
    const lift = applyTone([anchors.black], anchors, { ...none, shadows: 0.5 });
    expect(lift.tones[0]).toBeGreaterThan(anchors.black + 0.25);
  });

  it('works each stage on what the one before left: Whites follows the white point Highlights moved', () => {
    const w = 0.4;
    const alone = applyTone([anchors.white], anchors, { ...none, whites: w }).tones[0]! - anchors.white;
    const afterHighlights = applyTone([anchors.white], anchors, { ...none, highlights: -0.6, whites: w });
    const pulled = applyTone([anchors.white], anchors, { ...none, highlights: -0.6 }).tones[0]!;
    // Whites moves the tone at the (moved) white point as much as it moves it at the original one.
    expect(afterHighlights.tones[0]! - pulled).toBeCloseTo(alone, 9);
  });

  it('can stop after one stage (Auto picks them one at a time)', () => {
    const all = { shadows: 0.3, highlights: -0.3, whites: 0.3, blacks: -0.3 };
    const upToShadows = applyTone([-5], anchors, all, 'shadows');
    expect(upToShadows.tones[0]).toBeCloseTo(applyTone([-5], anchors, { ...none, shadows: 0.3 }).tones[0]!, 12);
  });
});

describe('the shader uniforms', () => {
  it('come from the same table', () => {
    const u = toneWindowUniforms();
    expect(u.uToneGain).toEqual([TONE_WINDOWS.shadows.gain, TONE_WINDOWS.highlights.gain, TONE_WINDOWS.whites.gain, TONE_WINDOWS.blacks.gain]);
    expect(u.uToneBlacks).toEqual([TONE_WINDOWS.blacks.lead, TONE_WINDOWS.blacks.width]);
    expect(Object.values(u).flat().every(Number.isFinite)).toBe(true);
  });
});

describe('the tone uniforms', () => {
  const fixture = CAMERAS[1]!;
  const camera = cameraInfo({ flip: 0, width: 100, height: 100, camMul: fixture.camMul, camXyz: fixture.camXyz, rgbCam: fixture.rgbCam, baselineExposure: 0 });

  it('hand the shader the raw slider values and the photo\'s points moved by Exposure', () => {
    const r = defaultRecipe();
    Object.assign(r.basic, { shadows: 20, highlights: -30, whites: 40, blacks: -50, exposure: 1.5 });
    const u = developUniforms(r, camera, undefined, { black: -6, white: 0.5 });
    expect(u.uTone).toEqual([0.2, -0.3, 0.4, -0.5]);
    expect(u.uToneAnchor).toEqual([-4.5, 2]);
  });

  it('use the default points when none are given, and shape no slider by profile', () => {
    const r = defaultRecipe();
    r.basic.shadows = 50;
    for (const profile of ['color', 'standard', 'vivid'] as const) {
      expect(developUniforms({ ...r, profile }, camera).uTone[0]).toBe(0.5);
    }
    expect(developUniforms(r, camera).uToneAnchor).toEqual([DEFAULT_ANCHORS.black, DEFAULT_ANCHORS.white]);
  });
});
