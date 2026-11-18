import { describe, expect, it } from 'vitest';
import { ADOBE_BASE_KNOTS, ADOBE_BASE_KNOT_UNIFORM, ADOBE_CHROMA_KNOTS, ADOBE_CHROMA_KNOT_UNIFORM, adobeBaseLightness, adobeChromaGain } from './adobe-tone.ts';
import type { HueSatTable } from './dcp.ts';
import { profileUniforms, resolveProfile } from './profiles.ts';

const table: HueSatTable = { hueDivisions: 4, satDivisions: 3, valDivisions: 1, srgbValues: false, data: new Float32Array(4 * 3 * 3).fill(1) };
const cameraColor = () => resolveProfile('color', { color: { key: 'color@4500', lookTable: table } });
const cameraStandard = () => resolveProfile('standard', { standard: { key: 'standard@4500', lookTable: table } });

describe('the Adobe base curve', () => {
  it('has increasing knots', () => {
    for (let i = 1; i < ADOBE_BASE_KNOTS.length; i++) {
      expect(ADOBE_BASE_KNOTS[i]![0]).toBeGreaterThan(ADOBE_BASE_KNOTS[i - 1]![0]);
      expect(ADOBE_BASE_KNOTS[i]![1]).toBeGreaterThan(ADOBE_BASE_KNOTS[i - 1]![1]);
    }
    expect(ADOBE_BASE_KNOT_UNIFORM).toHaveLength(ADOBE_BASE_KNOTS.length * 2);
    expect(ADOBE_BASE_KNOTS).toHaveLength(33); // the shader's uBaseKnots[33]
  });

  it('passes through its knots, and keeps black and white where they are', () => {
    for (const [x, y] of ADOBE_BASE_KNOTS) expect(adobeBaseLightness(x)).toBeCloseTo(y, 9);
    expect(adobeBaseLightness(0)).toBe(0);
    expect(adobeBaseLightness(1)).toBe(1);
    expect(adobeBaseLightness(-0.1)).toBe(0);
    expect(adobeBaseLightness(1.2)).toBe(1);
  });

  it('never goes down as the input goes up', () => {
    let last = -1;
    for (let i = 0; i <= 1000; i++) {
      const y = adobeBaseLightness(i / 1000);
      expect(y).toBeGreaterThanOrEqual(last);
      expect(y).toBeLessThanOrEqual(1);
      last = y;
    }
  });

  it('is steeper than the identity around the middle, and crosses it where the fit did', () => {
    expect((adobeBaseLightness(0.35) - adobeBaseLightness(0.25)) / 0.1).toBeGreaterThan(1.3);
    expect(adobeBaseLightness(0.2)).toBeLessThan(0.2); // darker in the shadows
    expect(adobeBaseLightness(0.45)).toBeGreaterThan(0.45); // brighter above the middle
    expect(adobeBaseLightness(0.3)).toBeCloseTo(0.3, 1);
  });

  it('rolls off into white instead of overshooting above the last knot', () => {
    const above = adobeBaseLightness(0.97);
    expect(above).toBeGreaterThan(0.97);
    expect(above).toBeLessThan(1);
  });

  it('lifts the highlights, steeply just below the shoulder, as Lightroom does', () => {
    expect(adobeBaseLightness(0.6213)).toBeCloseTo(0.7894, 4);
    expect(adobeBaseLightness(0.7)).toBeGreaterThan(0.87);
    expect((adobeBaseLightness(0.6213) - adobeBaseLightness(0.5702)) / (0.6213 - 0.5702)).toBeGreaterThan(0.8);
  });
});

describe('the Adobe chroma curve', () => {
  it('has increasing knots, as many as the shader reads', () => {
    for (let i = 1; i < ADOBE_CHROMA_KNOTS.length; i++) expect(ADOBE_CHROMA_KNOTS[i]![0]).toBeGreaterThan(ADOBE_CHROMA_KNOTS[i - 1]![0]);
    expect(ADOBE_CHROMA_KNOTS).toHaveLength(10); // uChromaKnots[10]
    expect(ADOBE_CHROMA_KNOT_UNIFORM).toHaveLength(20);
  });

  it('passes through its knots, is held in the darkest tones and is 1 in the bright ones', () => {
    for (const [x, g] of ADOBE_CHROMA_KNOTS) expect(adobeChromaGain(x)).toBeCloseTo(g, 9);
    expect(adobeChromaGain(0)).toBe(ADOBE_CHROMA_KNOTS[0]![1]);
    for (const x of [0.45, 0.6, 0.9, 1]) expect(adobeChromaGain(x)).toBe(1);
  });

  it('adds colour in the middle tones and none in the bright ones', () => {
    expect(adobeChromaGain(0.22)).toBeGreaterThan(1.25);
    expect(adobeChromaGain(0.5)).toBe(1);
  });
});

describe('the camera-profile tone correction in the shader uniforms', () => {
  it('fades in with the Amount for Standard; Color has no Amount and always has it in full', () => {
    const p = cameraStandard();
    expect(profileUniforms(p, 100)).toMatchObject({ uBaseFix: 1 });
    expect(profileUniforms(p, 60).uBaseFix).toBeCloseTo(0.6, 9);
    expect(profileUniforms(p, 0).uBaseFix).toBe(0);
    expect(profileUniforms(p, 150).uBaseFix).toBe(1); // above 100 % only the colour grows
    expect(profileUniforms(p, 100).uBaseKnots).toBe(ADOBE_BASE_KNOT_UNIFORM);
    expect(profileUniforms(cameraColor(), 30).uBaseFix).toBe(1);
  });

  it('is off for the in-house profiles and the other looks', () => {
    for (const id of ['color', 'vivid', 'neutral', 'monochrome', 'linear'] as const) expect(profileUniforms(resolveProfile(id), 100).uBaseFix).toBe(0);
  });

  it('is off without the camera profile: Standard is then just Color', () => {
    expect(profileUniforms(resolveProfile('standard'), 100)).toEqual(profileUniforms(resolveProfile('color'), 100));
  });
});
