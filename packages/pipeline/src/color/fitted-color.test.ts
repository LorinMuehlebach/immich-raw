import { describe, expect, it } from 'vitest';
import { applyLookCpu, dngHsvToRgb } from './dcp.ts';
import { COLOR_FIT, COLOR_FIT_BINS, STANDARD_FIT, atHue, fittedColorLook, fittedNode } from './fitted-color.ts';
import { mulVec3, type Vec3 } from './matrices.ts';
import { PROPHOTO_TO_LMS } from './spaces.ts';

function chromaAndHue(rgb: Vec3): [number, number] {
  const [l, m, s] = mulVec3(PROPHOTO_TO_LMS, rgb).map(Math.cbrt) as [number, number, number];
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [Math.hypot(a, b), (Math.atan2(b, a) * 180) / Math.PI];
}

describe('the fitted colour of Color and Standard', () => {
  it('has one gain and turn per hue bin, kept within what is safe for hues that were measured thinly', () => {
    for (const fit of [COLOR_FIT, STANDARD_FIT]) {
      expect(fit.gain).toHaveLength(COLOR_FIT_BINS);
      expect(fit.turn).toHaveLength(COLOR_FIT_BINS);
      for (const g of fit.gain) {
        expect(g).toBeGreaterThanOrEqual(0.5);
        expect(g).toBeLessThanOrEqual(2.2);
      }
      for (const t of fit.turn) expect(Math.abs(t)).toBeLessThanOrEqual(25);
    }
  });

  it('interpolates per-bin values around the hue circle', () => {
    const v = Array.from({ length: 24 }, (_, i) => i);
    expect(atHue(v, 0)).toBe(0);
    expect(atHue(v, 7.5)).toBeCloseTo(0.5, 9);
    expect(atHue(v, 360 - 7.5)).toBeCloseTo(11.5, 9);
    expect(atHue(v, -15)).toBe(23);
    expect(atHue(v, 360 + 15)).toBe(1);
  });

  it('leaves greys, black and unsaturated colours alone', () => {
    expect(fittedNode(30, 0, 0.5)).toEqual([0, 1, 1]);
    expect(fittedNode(30, 0.5, 0)).toEqual([0, 1, 1]);
    const [dh, ds, dv] = fittedNode(40, 0.01, 0.5);
    expect(Math.abs(dh)).toBeLessThan(0.5);
    expect(ds).toBeCloseTo(1, 1);
    expect(dv).toBeCloseTo(1, 1);
  });

  it('makes oranges and greens more colourful, turns oranges towards red, and barely touches blues, as Lightroom\'s Color does', () => {
    const t = fittedColorLook();
    const orange = dngHsvToRgb([0.8, 0.5, 0.2]);
    const [c0, h0] = chromaAndHue(orange);
    const [c1, h1] = chromaAndHue(applyLookCpu(t, orange));
    expect(c1 / c0).toBeGreaterThan(1.1);
    expect(h1 - h0).toBeLessThan(-3);
    const green = dngHsvToRgb([2.5, 0.5, 0.2]);
    const [cg0] = chromaAndHue(green);
    const [cg1] = chromaAndHue(applyLookCpu(t, green));
    expect(cg1 / cg0).toBeGreaterThan(1.2);
    const blue = dngHsvToRgb([4.0, 0.5, 0.3]);
    const [cb0] = chromaAndHue(blue);
    const [cb1] = chromaAndHue(applyLookCpu(t, blue));
    expect(Math.abs(cb1 / cb0 - 1)).toBeLessThan(0.1);
  });

  it('is less colourful for Standard than for Color', () => {
    const green = dngHsvToRgb([2.5, 0.5, 0.2]);
    const [c0] = chromaAndHue(green);
    const [cc] = chromaAndHue(applyLookCpu(fittedColorLook(COLOR_FIT), green));
    const [cs] = chromaAndHue(applyLookCpu(fittedColorLook(STANDARD_FIT), green));
    expect(cs / c0).toBeGreaterThan(1.1);
    expect(cs).toBeLessThan(cc);
  });

  it('is a table the shader can use, built once', () => {
    const t = fittedColorLook();
    expect(t).toMatchObject({ hueDivisions: 72, satDivisions: 12, valDivisions: 16, srgbValues: true });
    expect(t.data).toHaveLength(72 * 12 * 16 * 3);
    expect(t.data.every(Number.isFinite)).toBe(true);
    expect(fittedColorLook()).toBe(t);
    expect(fittedColorLook(STANDARD_FIT)).not.toBe(t);
    expect(fittedColorLook(STANDARD_FIT)).toBe(fittedColorLook(STANDARD_FIT));
  });
});
