import { defaultRecipe, type EffectsParams } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { NR_REACH, effectsUniforms, grainCellSize, nrPlan, vignetteWeight } from './effects.ts';

const detail = (o: Partial<ReturnType<typeof defaultRecipe>['detail']> = {}) => ({ ...defaultRecipe().detail, ...o });

describe('noise reduction plan', () => {
  it('is off only when both luminance and color are 0', () => {
    expect(nrPlan(detail({ nrLuminance: 0, nrColor: 0 }), 1)).toBeNull();
    const def = nrPlan(detail(), 1)!;
    expect(def.luminance).toBe(false);
    expect(def.color).toBe(true);
    expect(def.levels.every((l) => l.lumT === 0)).toBe(true);
  });

  it('works in full-resolution units: a downscaled render skips the levels finer than its pixels', () => {
    const d = detail({ nrLuminance: 40 });
    const full = nrPlan(d, 1)!;
    const proxy = nrPlan(d, 0.4)!;
    expect(full.levels.map((l) => l.dilation)).toEqual([1, 2, 4, 8, 16, 32]);
    expect(proxy.levels[0]!.dilation).toBeCloseTo(0.8, 9);
    // The same physical level gets the same threshold at any scale.
    expect(proxy.levels[0]!.lumT).toBe(full.levels[1]!.lumT);
  });

  it('expects more noise at high ISO and after an exposure push', () => {
    const d = detail({ nrLuminance: 40 });
    const base = nrPlan(d, 1)!.noiseGain;
    expect(base).toBe(1);
    expect(nrPlan(d, 1, 0, 6400)!.noiseGain).toBeGreaterThan(2);
    expect(nrPlan(d, 1, 3, 100)!.noiseGain).toBeGreaterThan(base);
    expect(nrPlan(d, 1, -2, 100)!.noiseGain).toBeLessThan(base);
  });

  it('fits the export apron', () => {
    expect(NR_REACH).toBeLessThanOrEqual(128);
  });

  it('Detail keeps fine detail, Contrast keeps coarse detail', () => {
    const base = nrPlan(detail({ nrLuminance: 50 }), 1)!;
    const moreDetail = nrPlan(detail({ nrLuminance: 50, nrLuminanceDetail: 90 }), 1)!;
    const moreContrast = nrPlan(detail({ nrLuminance: 50, nrLuminanceContrast: 80 }), 1)!;
    expect(moreDetail.levels[0]!.lumT).toBeLessThan(base.levels[0]!.lumT);
    expect(moreDetail.levels[4]!.lumT).toBe(base.levels[4]!.lumT);
    expect(moreContrast.levels[4]!.lumT).toBeLessThan(base.levels[4]!.lumT);
    expect(moreContrast.levels[0]!.lumT).toBe(base.levels[0]!.lumT);
  });

  it('Color sets the chroma radius, Smoothness the coarse mottling levels', () => {
    const gains = (o: Partial<ReturnType<typeof detail>>) => nrPlan(detail(o), 1)!.levels.map((l) => l.colorGain);
    const low = gains({ nrColor: 10, nrColorSmoothness: 0 });
    const high = gains({ nrColor: 80, nrColorSmoothness: 0 });
    expect(low[0]).toBe(1);
    expect(high[3]!).toBeGreaterThan(low[3] ?? 0);
    const smooth = gains({ nrColor: 10, nrColorSmoothness: 100 });
    expect(smooth[smooth.length - 1]!).toBeGreaterThan(0.5);
    const sharpEdges = nrPlan(detail({ nrColorDetail: 100 }), 1)!.colorRange;
    const soft = nrPlan(detail({ nrColorDetail: 0 }), 1)!.colorRange;
    expect(sharpEdges[1]).toBeLessThan(soft[1]);
  });
});

describe('post-crop vignette', () => {
  const e = (o: Partial<EffectsParams> = {}) => ({ ...defaultRecipe().effects, ...o });

  it('leaves the centre alone and is complete in the corners', () => {
    const size: [number, number] = [6000, 4000];
    expect(vignetteWeight([0.5, 0.5], size, e())).toBe(0);
    expect(vignetteWeight([0, 0], size, e())).toBe(1);
    expect(vignetteWeight([1, 1], size, e())).toBe(1);
  });

  it('follows the crop aspect at roundness 0 and is a circle at +100', () => {
    const size: [number, number] = [6000, 3000];
    const flat = e({ vignetteFeather: 30 });
    // Edge midpoints are at the same distance in frame units at roundness 0.
    expect(vignetteWeight([0, 0.5], size, flat)).toBeCloseTo(vignetteWeight([0.5, 0], size, flat), 9);
    // A circle reaches the long side's midpoint later than the short side's.
    const round = { ...flat, vignetteRoundness: 100 };
    expect(vignetteWeight([0.5, 0], size, round)).toBeLessThan(vignetteWeight([0, 0.5], size, round));
    // Equal pixel distances from the centre get equal weights.
    expect(vignetteWeight([0.5 + 1200 / 6000, 0.5], size, round)).toBeCloseTo(vignetteWeight([0.5, 0.5 + 1200 / 3000], size, round), 9);
  });

  it('Midpoint moves it outwards, Feather 0 gives a hard edge', () => {
    const size: [number, number] = [4000, 4000];
    const p: [number, number] = [0.15, 0.5];
    expect(vignetteWeight(p, size, e({ vignetteMidpoint: 90 }))).toBeLessThan(vignetteWeight(p, size, e({ vignetteMidpoint: 10 })));
    const hard = e({ vignetteFeather: 0 });
    const ws = Array.from({ length: 50 }, (_, i) => vignetteWeight([0.5 - i / 100, 0.5], size, hard));
    expect(ws.filter((w) => w > 0.01 && w < 0.99).length).toBeLessThanOrEqual(1);
  });
});

describe('effects uniforms', () => {
  it('are off in the crop view and when nothing is set', () => {
    const r = defaultRecipe();
    expect(effectsUniforms(r.effects, [6000, 4000]).uOutPx).toEqual([0, 0]);
    r.effects.grainAmount = 20;
    expect(effectsUniforms(r.effects, [6000, 4000]).uOutPx).toEqual([6000, 4000]);
    expect(effectsUniforms(r.effects, null).uOutPx).toEqual([0, 0]);
  });

  it('maps the vignette style and grain size', () => {
    const r = defaultRecipe();
    r.effects.vignetteStyle = 'paint';
    expect(effectsUniforms(r.effects, null).uVigOpt[0]).toBe(3);
    expect(grainCellSize(0)).toBeLessThan(grainCellSize(25));
    expect(grainCellSize(100)).toBeGreaterThan(5);
  });
});
