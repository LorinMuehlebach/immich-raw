import { describe, expect, it } from 'vitest';
import { PARAMS } from './params.ts';
import { canonicalJson, defaultRecipe, isDefaultRecipe, normalizeRecipe, recipeHash } from './recipe.ts';

describe('defaultRecipe', () => {
  it('uses Lightroom defaults for sharpening and color noise reduction', () => {
    const r = defaultRecipe();
    expect(r.detail.sharpenAmount).toBe(40);
    expect(r.detail.sharpenRadius).toBe(1);
    expect(r.detail.sharpenDetail).toBe(25);
    expect(r.detail.nrColor).toBe(25);
    expect(r.basic.exposure).toBe(0);
    expect(r.wb.mode).toBe('asShot');
  });
});

describe('normalizeRecipe', () => {
  it('fills missing fields and clamps out-of-range numbers', () => {
    const r = normalizeRecipe({ basic: { exposure: 9, shadows: -40 }, profile: 'nope', crop: { w: 2, rotate90: 5 } });
    expect(r.basic.exposure).toBe(PARAMS.exposure.max);
    expect(r.basic.shadows).toBe(-40);
    expect(r.basic.contrast).toBe(0);
    expect(r.profile).toBe('color');
    expect(r.crop.w).toBe(1);
    expect(r.crop.rotate90).toBe(0);
  });

  it('keeps render and pending references', () => {
    const r = normalizeRecipe({ render: { assetId: 'a', recipeHash: 'h', checksum: 'c', renderedAt: 't' }, pending: { recipeHash: 'h2', startedAt: 's' } });
    expect(r.render?.assetId).toBe('a');
    expect(r.pending?.recipeHash).toBe('h2');
  });

  it('gives older recipes Lightroom defaults for noise reduction and effects, and checks the vignette style', () => {
    const r = normalizeRecipe({ detail: { nrLuminance: 20 } });
    expect(r.detail).toMatchObject({ nrLuminance: 20, nrLuminanceDetail: 50, nrLuminanceContrast: 0, nrColor: 25, nrColorDetail: 50, nrColorSmoothness: 50 });
    expect(r.effects).toEqual({ vignetteStyle: 'highlight', vignetteAmount: 0, vignetteMidpoint: 50, vignetteRoundness: 0, vignetteFeather: 50, vignetteHighlights: 0, grainAmount: 0, grainSize: 25, grainRoughness: 50 });
    expect(normalizeRecipe({ effects: { vignetteStyle: 'paint', vignetteAmount: -300 } }).effects).toMatchObject({ vignetteStyle: 'paint', vignetteAmount: -100 });
    expect(normalizeRecipe({ effects: { vignetteStyle: 'sepia' } }).effects.vignetteStyle).toBe('highlight');
  });

  it('survives garbage', () => {
    expect(normalizeRecipe(null)).toEqual(defaultRecipe());
    expect(normalizeRecipe('x')).toEqual(defaultRecipe());
  });
});

describe('recipeHash', () => {
  it('ignores key order and the render/pending bookkeeping', async () => {
    const a = defaultRecipe();
    const b = normalizeRecipe(JSON.parse(JSON.stringify(a)));
    b.render = { assetId: 'x', recipeHash: '', checksum: '', renderedAt: '' };
    expect(await recipeHash(a)).toBe(await recipeHash(b));
  });

  it('changes when a slider changes', async () => {
    const a = defaultRecipe();
    const b = defaultRecipe();
    b.basic.exposure = 0.5;
    expect(await recipeHash(a)).not.toBe(await recipeHash(b));
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } })).toBe('{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}');
  });
});

describe('isDefaultRecipe', () => {
  it('is true for a fresh recipe and false after an edit', () => {
    const r = defaultRecipe();
    expect(isDefaultRecipe(r)).toBe(true);
    r.basic.shadows = 10;
    expect(isDefaultRecipe(r)).toBe(false);
  });
});

describe('tone curve', () => {
  it('defaults to linear curves and sanitises stored points', () => {
    const r = normalizeRecipe({ toneCurve: { point: { master: [[255, 240], [0, 10], [128, 128], [128, 140], ['x', 3]] } } });
    expect(r.toneCurve.point.master).toEqual([[0, 10], [128, 128], [255, 240]]);
    expect(r.toneCurve.point.red).toEqual([[0, 0], [255, 255]]);
    expect(r.toneCurve.parametric.midtoneSplit).toBe(50);
  });
});
