import { defaultRecipe } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import {
  BAND_HUES,
  SRGB_TO_PROPHOTO,
  bandWeights,
  calibrationMatrix,
  displayHue,
  gradeTint,
  gradingUniforms,
  gradingWeights,
  linearSrgbToOklab,
  mixerUniforms,
  oklabHue,
} from './look.ts';
import { IDENTITY3, mulVec3, type Vec3 } from './matrices.ts';
import { PROPHOTO_TO_SRGB } from './spaces.ts';

const deg = (r: number) => (r * 180) / Math.PI;

describe('band centres', () => {
  it('are ascending OKLab hues of the HSV band colours', () => {
    for (let i = 1; i < 8; i++) expect(BAND_HUES[i]!).toBeGreaterThan(BAND_HUES[i - 1]!);
    expect(deg(BAND_HUES[0]!)).toBeCloseTo(29.2, 0); // sRGB red
    expect(deg(BAND_HUES[2]!)).toBeCloseTo(109.8, 0); // yellow
    expect(deg(BAND_HUES[5]!)).toBeCloseTo(264.1, 0); // blue
    expect(deg(BAND_HUES[7]!)).toBeLessThan(360);
  });
});

describe('bandWeights', () => {
  it('gives a band full weight at its centre', () => {
    BAND_HUES.forEach((h, i) => {
      const w = bandWeights(h);
      expect(w[i]).toBeCloseTo(1, 6);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    });
  });

  it('splits evenly halfway between neighbours, including across magenta -> red', () => {
    const mid = (BAND_HUES[2]! + BAND_HUES[3]!) / 2;
    const w = bandWeights(mid);
    expect(w[2]).toBeCloseTo(0.5, 6);
    expect(w[3]).toBeCloseTo(0.5, 6);
    const wrap = (BAND_HUES[7]! + BAND_HUES[0]! + Math.PI * 2) / 2;
    const w2 = bandWeights(wrap);
    expect(w2[7]).toBeCloseTo(0.5, 6);
    expect(w2[0]).toBeCloseTo(0.5, 6);
    bandWeights(wrap - Math.PI * 2).forEach((x, i) => expect(x).toBeCloseTo(w2[i]!, 9));
  });

  it('sums to 1 everywhere', () => {
    for (let h = -7; h < 7; h += 0.137) expect(bandWeights(h).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });
});

describe('mixerUniforms', () => {
  it('is off for a default recipe', () => {
    const u = mixerUniforms(defaultRecipe());
    expect(u.uMixer).toBe(0);
    expect(u.uBwMix).toBe(0);
  });

  it('shifts red towards orange for + and towards magenta for -', () => {
    const r = defaultRecipe();
    r.colorMixer.hue.red = 100;
    const up = mixerUniforms(r);
    expect(up.uMixer).toBe(1);
    expect(up.uMixHue[0]).toBeCloseTo((BAND_HUES[1]! - BAND_HUES[0]!) * 0.6, 5);
    r.colorMixer.hue.red = -100;
    const down = mixerUniforms(r);
    expect(down.uMixHue[0]).toBeCloseTo(-(BAND_HUES[0]! + Math.PI * 2 - BAND_HUES[7]!) * 0.6, 5);
  });

  it('uses the B&W mix only in monochrome', () => {
    const r = defaultRecipe();
    r.colorMixer.saturation.blue = 50;
    r.bwMix.blue = -40;
    expect(mixerUniforms(r)).toMatchObject({ uMixer: 1, uBwMix: 0 });
    r.profile = 'monochrome';
    const u = mixerUniforms(r);
    expect(u).toMatchObject({ uMixer: 0, uBwMix: 1 });
    expect(u.uBw[5]).toBeCloseTo(-0.4, 6);
  });
});

describe('color grading', () => {
  it('points the tint in the wheel colour direction', () => {
    const [a, b] = gradeTint(0, 100);
    expect(Math.hypot(a, b)).toBeCloseTo(0.1, 6);
    expect(a).toBeGreaterThan(0); // red: +a
    const [, bb] = gradeTint(240, 50);
    expect(bb).toBeLessThan(0); // blue: -b
    expect(gradeTint(120, 0)).toEqual([0, 0]);
  });

  it('weights shadows, midtones and highlights by lightness', () => {
    const shape = gradingUniforms(defaultRecipe()).uGradeShape;
    const dark = gradingWeights(0, shape);
    const light = gradingWeights(1, shape);
    expect(dark[0]).toBeCloseTo(1, 6);
    expect(light[2]).toBeCloseTo(1, 6);
    const mid = gradingWeights(shape[0]!, shape);
    expect(mid[1]).toBeGreaterThan(mid[0]);
    expect(mid[1]).toBeGreaterThan(mid[2]);
    for (let y = 0; y <= 1; y += 0.05) expect(gradingWeights(y, shape).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it('moves the split with Balance and widens the overlap with Blending', () => {
    const r = defaultRecipe();
    r.colorGrading.balance = 100;
    const hi = gradingUniforms(r).uGradeShape;
    expect(hi[0]).toBeLessThan(0.55);
    r.colorGrading.blending = 100;
    const wide = gradingUniforms(r).uGradeShape;
    expect(wide[1]).toBeLessThan(hi[1]!);
    expect(gradingUniforms(defaultRecipe()).uGrading).toBe(0);
    r.colorGrading.shadows.sat = 30;
    expect(gradingUniforms(r).uGrading).toBe(1);
  });
});

describe('calibrationMatrix', () => {
  const srgbRedInWork = mulVec3(SRGB_TO_PROPHOTO, [1, 0, 0]);
  const hueOfWork = (v: Vec3) => oklabHue(mulVec3(PROPHOTO_TO_SRGB, v));
  const chromaOfWork = (v: Vec3) => {
    const [, a, b] = linearSrgbToOklab(mulVec3(PROPHOTO_TO_SRGB, v));
    return Math.hypot(a, b);
  };

  it('is the identity when neutral', () => {
    expect(calibrationMatrix(defaultRecipe().calibration)).toEqual(IDENTITY3);
  });

  it('keeps white white', () => {
    const c = { ...defaultRecipe().calibration, redHue: 60, greenSaturation: -40, blueHue: -80, blueSaturation: 70 };
    const w = mulVec3(calibrationMatrix(c), [1, 1, 1]);
    w.forEach((x) => expect(x).toBeCloseTo(1, 6));
  });

  it('turns red towards yellow for + hue and saturates it for + saturation', () => {
    const base = defaultRecipe().calibration;
    const before = hueOfWork(srgbRedInWork);
    const turned = hueOfWork(mulVec3(calibrationMatrix({ ...base, redHue: 50 }), srgbRedInWork));
    expect(turned).toBeGreaterThan(before);
    const sat = chromaOfWork(mulVec3(calibrationMatrix({ ...base, redSaturation: 50 }), srgbRedInWork));
    expect(sat).toBeGreaterThan(chromaOfWork(srgbRedInWork));
  });
});

describe('displayHue', () => {
  it('reads the hue of an encoded sRGB colour', () => {
    expect(deg(displayHue([1, 0, 0]))).toBeCloseTo(29.2, 0);
    expect(deg(displayHue([0, 0, 1]))).toBeCloseTo(264.1, 0);
  });
});
