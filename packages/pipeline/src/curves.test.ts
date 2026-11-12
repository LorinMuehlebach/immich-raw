import { defaultRecipe } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { buildCurveLut, isCurveNeutral, monotoneCubic, parametricCurve, pointCurve } from './curves.ts';

describe('monotoneCubic', () => {
  it('passes through the points and never overshoots', () => {
    const f = monotoneCubic([0, 0.3, 0.31, 1], [0, 0.5, 0.52, 1]);
    expect(f(0.3)).toBeCloseTo(0.5, 9);
    let prev = -1;
    for (let x = 0; x <= 1; x += 0.001) {
      const y = f(x);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(y).toBeLessThanOrEqual(1 + 1e-12);
      prev = y;
    }
  });
});

describe('curves', () => {
  it('default curve is the identity', () => {
    const c = defaultRecipe().toneCurve;
    expect(isCurveNeutral(c)).toBe(true);
    const lut = buildCurveLut(c, 256);
    for (let i = 0; i < 256; i++) expect(lut[i * 4]).toBeCloseTo(i / 255, 6);
  });

  it('an S point curve darkens shadows and brightens highlights', () => {
    const f = pointCurve([
      [0, 0],
      [64, 50],
      [192, 206],
      [255, 255],
    ]);
    expect(f(64 / 255)).toBeCloseTo(50 / 255, 6);
    expect(f(0.9)).toBeGreaterThan(0.9);
  });

  it('parametric shadows lifts the shadow region and keeps the ends fixed', () => {
    const p = { ...defaultRecipe().toneCurve.parametric, shadows: 100 };
    const f = parametricCurve(p);
    expect(f(0)).toBe(0);
    expect(f(1)).toBe(1);
    expect(f(0.125)).toBeGreaterThan(0.25);
    expect(f(0.8)).toBeCloseTo(0.8, 1);
  });

  it('LUT stays monotone with extreme parametric settings', () => {
    const c = defaultRecipe().toneCurve;
    c.parametric = { ...c.parametric, shadows: -100, darks: 100, lights: -100, highlights: 100 };
    const lut = buildCurveLut(c, 1024);
    for (let i = 1; i < 1024; i++) expect(lut[i * 4]!).toBeGreaterThanOrEqual(lut[(i - 1) * 4]!);
  });
});
