import { describe, expect, it } from 'vitest';
import { ADOBE_BASE_KNOTS, adobeBaseKnotUniform, adobeBaseKnots, adobeBaseLightness, adobeChromaGain, adobeChromaKnotUniform, adobeChromaKnots, type AdobeTone } from './adobe-tone.ts';
import { FIT_DATA } from './adobe-fit-data.ts';
import { profileUniforms, resolveProfile } from './profiles.ts';

const KINDS: AdobeTone[] = ['color', 'standard'];

describe('the Adobe base curve', () => {
  it('has increasing knots for every profile and baseline exposure, as many as the shader reads', () => {
    for (const kind of KINDS) {
      for (const ev of [0, 0.7, 1, 2]) {
        const knots = adobeBaseKnots(kind, ev);
        expect(knots).toHaveLength(33); // the shader's uBaseKnots[33]
        for (let i = 1; i < knots.length; i++) {
          expect(knots[i]![0]).toBeGreaterThan(knots[i - 1]![0]);
          expect(knots[i]![1]).toBeGreaterThan(knots[i - 1]![1]);
        }
        expect(adobeBaseKnotUniform(kind, ev)).toHaveLength(66);
      }
    }
  });

  it('passes through its knots, and keeps black and white where they are', () => {
    for (const [x, y] of ADOBE_BASE_KNOTS) expect(adobeBaseLightness(x)).toBeCloseTo(y, 9);
    for (const kind of KINDS) {
      expect(adobeBaseLightness(0, kind, 0)).toBe(0);
      expect(adobeBaseLightness(1, kind, 0)).toBe(1);
      expect(adobeBaseLightness(-0.1, kind, 2)).toBe(0);
      expect(adobeBaseLightness(1.2, kind, 2)).toBe(1);
    }
  });

  it('never goes down as the input goes up', () => {
    for (const kind of KINDS) {
      for (const ev of [0, 2]) {
        let last = -1;
        for (let i = 0; i <= 1000; i++) {
          const y = adobeBaseLightness(i / 1000, kind, ev);
          expect(y).toBeGreaterThanOrEqual(last);
          expect(y).toBeLessThanOrEqual(1);
          last = y;
        }
      }
    }
  });

  it('is steeper than the identity around the middle, and crosses it where the fit did', () => {
    expect((adobeBaseLightness(0.35) - adobeBaseLightness(0.25)) / 0.1).toBeGreaterThan(1.3);
    expect(adobeBaseLightness(0.2)).toBeLessThan(0.2); // darker in the shadows
    expect(adobeBaseLightness(0.45)).toBeGreaterThan(0.45); // brighter above the middle
    expect(adobeBaseLightness(0.3)).toBeCloseTo(0.3, 1);
  });

  it('rolls off into white instead of overshooting above the last knot', () => {
    for (const kind of KINDS) {
      const above = adobeBaseLightness(0.97, kind, 1);
      expect(above).toBeGreaterThan(0.97);
      expect(above).toBeLessThan(1);
    }
  });

  it('lifts the highlights, steeply just below the shoulder, as Lightroom does', () => {
    expect(adobeBaseLightness(0.6213)).toBeCloseTo(0.7894, 4);
    expect(adobeBaseLightness(0.7)).toBeGreaterThan(0.87);
    expect((adobeBaseLightness(0.6213) - adobeBaseLightness(0.5702)) / (0.6213 - 0.5702)).toBeGreaterThan(0.8);
  });

  it('is a mix of the two measured curves by the baseline exposure of the photo', () => {
    const lo = adobeBaseKnots('color', 0);
    const hi = adobeBaseKnots('color', 2);
    const mid = adobeBaseKnots('color', 1);
    mid.forEach((k, i) => expect(k[1]).toBeCloseTo((lo[i]![1] + hi[i]![1]) / 2, 9));
    expect(adobeBaseKnots('color', -1)).toEqual(lo); // never extrapolated
    expect(adobeBaseKnots('color', 5)).toEqual(hi);
    // the DR100 photo has the longer highlight roll-off, the DR400 one the lower shadows
    expect(lo[lo.length - 1]![1]).toBeLessThan(hi[hi.length - 1]![1]);
    expect(adobeBaseKnotUniform('color', 1.02)).toBe(adobeBaseKnotUniform('color', 1)); // cached to 0.05 EV
  });

  it('lifts the shadows more for Standard than for Color, and ends a little lower', () => {
    const color = adobeBaseKnots('color', 0);
    const standard = adobeBaseKnots('standard', 0);
    expect(standard[4]![1]).toBeGreaterThan(color[4]![1] + 0.015);
    expect(standard[standard.length - 1]![1]).toBeLessThan(color[color.length - 1]![1]);
    for (let i = 20; i < 24; i++) expect(Math.abs(standard[i]![1] - color[i]![1])).toBeLessThan(0.02); // the middle is the same
  });
});

describe('the Adobe chroma curve', () => {
  it('has increasing knots, as many as the shader reads', () => {
    for (const kind of KINDS) {
      const knots = adobeChromaKnots(kind);
      for (let i = 1; i < knots.length; i++) expect(knots[i]![0]).toBeGreaterThan(knots[i - 1]![0]);
      expect(knots).toHaveLength(10); // uChromaKnots[10]
      expect(adobeChromaKnotUniform(kind)).toHaveLength(20);
    }
  });

  it('passes through its knots and is held in the darkest tones', () => {
    for (const kind of KINDS) {
      for (const [x, g] of adobeChromaKnots(kind)) expect(adobeChromaGain(x, kind)).toBeCloseTo(g, 9);
      expect(adobeChromaGain(0, kind)).toBe(adobeChromaKnots(kind)[0]![1]);
      expect(adobeChromaGain(1, kind)).toBe(1);
    }
  });

  it('adds colour in the shadows and middle tones and takes some from the highlights', () => {
    for (const kind of KINDS) {
      expect(adobeChromaGain(0.22, kind)).toBeGreaterThan(1.25);
      expect(adobeChromaGain(0.85, kind)).toBeLessThan(0.9);
      expect(adobeChromaGain(0.99, kind)).toBeGreaterThan(adobeChromaGain(0.9, kind));
    }
    // Color is the more colourful of the two
    expect(adobeChromaGain(0.28, 'color')).toBeGreaterThan(adobeChromaGain(0.28, 'standard'));
  });
});

describe('the fitted numbers', () => {
  it('have the sizes the code and the shader expect', () => {
    expect(FIT_DATA.baseX).toHaveLength(33);
    for (const kind of KINDS) {
      expect(FIT_DATA.baseY[kind].plain).toHaveLength(33);
      expect(FIT_DATA.baseY[kind].protectedHighlights).toHaveLength(33);
      expect(FIT_DATA.chromaY[kind]).toHaveLength(FIT_DATA.chromaX.length);
      expect(FIT_DATA.hue[kind].gain).toHaveLength(24);
      expect(FIT_DATA.hue[kind].turn).toHaveLength(24);
    }
  });
});

describe('the tone correction in the shader uniforms', () => {
  it('is on in full for Color and Standard, which have no Amount', () => {
    for (const id of ['color', 'standard'] as const) {
      const p = resolveProfile(id);
      expect(profileUniforms(p, 100).uBaseFix).toBe(1);
      expect(profileUniforms(p, 30).uBaseFix).toBe(1);
      expect(profileUniforms(p, 0).uBaseFix).toBe(1);
    }
  });

  it('hands the shader the curve of the profile and the baseline exposure of the photo', () => {
    expect(profileUniforms(resolveProfile('color'), 100, 2).uBaseKnots).toBe(adobeBaseKnotUniform('color', 2));
    expect(profileUniforms(resolveProfile('standard'), 100, 0).uBaseKnots).toBe(adobeBaseKnotUniform('standard', 0));
    expect(profileUniforms(resolveProfile('standard'), 100).uBaseKnots).not.toBe(profileUniforms(resolveProfile('color'), 100).uBaseKnots);
    expect(profileUniforms(resolveProfile('standard'), 100).uChromaKnots).toBe(adobeChromaKnotUniform('standard'));
  });

  it('is off for the other profiles', () => {
    for (const id of ['vivid', 'neutral', 'monochrome', 'linear'] as const) expect(profileUniforms(resolveProfile(id), 100).uBaseFix).toBe(0);
  });
});
