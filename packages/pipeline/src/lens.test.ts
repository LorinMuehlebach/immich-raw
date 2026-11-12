import type { LensCorrection, RadialPoly } from '@immich-raw/lens';
import { defaultRecipe, type Recipe } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { defringeUniforms, isLensActive, lensModel, lensSourcePoint, lensUniforms, NO_LENS } from './lens.ts';

const W = 6000;
const H = 4000;
const N = Math.hypot(W, H) / 2;
const frame = { center: [0.5, 0.5] as [number, number], scale: [W / N, H / N] as [number, number] };
const ID: RadialPoly = [1, 0, 0, 0, 0, 0, 0];

function recipe(lens: Partial<Recipe['lens']> = {}): Recipe {
  const r = defaultRecipe();
  Object.assign(r.lens, lens);
  return r;
}

const insideAll = (m: ReturnType<typeof lensModel>) => {
  for (const b of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0, 0.5], [1, 0.5], [0.5, 1]] as const) {
    for (const ch of [0, 1, 2] as const) {
      const p = lensSourcePoint(m, [b[0], b[1]], ch);
      expect(p[0]).toBeGreaterThanOrEqual(-1e-3);
      expect(p[1]).toBeGreaterThanOrEqual(-1e-3);
      expect(p[0]).toBeLessThanOrEqual(1 + 1e-3);
      expect(p[1]).toBeLessThanOrEqual(1 + 1e-3);
    }
  }
};

describe('lens model', () => {
  it('is the identity without corrections', () => {
    const m = lensModel(recipe(), NO_LENS, W, H);
    expect(isLensActive(m)).toBe(false);
    expect(m.zoom).toBe(1);
    expect(lensSourcePoint(m, [0.2, 0.7])).toEqual([0.2, 0.7]);
    expect(lensUniforms(m).uLensOn).toBe(0);
  });

  it('manual Distortion: + takes the corners from further in, without zooming out', () => {
    const m = lensModel(recipe({ distortion: 60 }), NO_LENS, W, H);
    expect(lensSourcePoint(m, [1, 1])[0]).toBeLessThan(1);
    // Zooming out would bring back corners outside the corrected frame (Lightroom doesn't either).
    expect(m.zoom).toBe(1);
    insideAll(m);
  });

  it('manual Distortion: - (pincushion fix) zooms in just enough that no blank corners appear', () => {
    const m = lensModel(recipe({ distortion: -60 }), NO_LENS, W, H);
    expect(m.zoom).toBeGreaterThan(1);
    insideAll(m);
    // Just enough: a slightly smaller zoom would show a gap at the corner.
    const corner = lensSourcePoint({ ...m, zoom: m.zoom * 0.99 }, [1, 1]);
    expect(Math.max(corner[0], corner[1])).toBeGreaterThan(1);
  });

  it('applies the profile with its strength, and leaves its CA terms to measured CA', () => {
    const poly = (k: number): RadialPoly => [1, 0, k, 0, 0, 0, 0];
    const profile: LensCorrection = { source: 'test', geometry: { ...frame, poly: [poly(0.012), poly(0.01), poly(0.008)] }, vignetting: null };
    const ca: LensCorrection = { source: 'ca', geometry: { ...frame, poly: [[1.0004, 0, 0, 0, 0, 0, 0], ID, [0.9997, 0, 0, 0, 0, 0, 0]] }, vignetting: null };
    const full = lensModel(recipe({ removeCA: false }), { profile, ca: null }, W, H);
    expect(full.geo!.poly[0][2]).toBeCloseTo(0.012);
    const half = lensModel(recipe({ removeCA: false, profileDistortion: 50 }), { profile, ca: null }, W, H);
    expect(half.geo!.poly[1][2]).toBeCloseTo(0.005);
    const off = lensModel(recipe({ profile: false }), { profile, ca: null }, W, H);
    expect(off.geo).toBeNull();
    const measured = lensModel(recipe({ removeCA: true }), { profile, ca }, W, H);
    expect(measured.geo!.poly[0]).toEqual(measured.geo!.poly[1]);
    expect(measured.ca).not.toBeNull();
    // Red is sampled further out than green when the lens magnified red.
    const g = lensSourcePoint(measured, [0.95, 0.9], 1);
    const r = lensSourcePoint(measured, [0.95, 0.9], 0);
    expect(r[0]).toBeGreaterThan(g[0]);
    insideAll(measured);
  });

  it('passes vignetting with its strength', () => {
    const profile: LensCorrection = { source: 'v', geometry: null, vignetting: { ...frame, mode: 'divide', k: [-0.3, 0.05, 0, 0, 0] } };
    const m = lensModel(recipe({ profileVignetting: 150 }), { profile, ca: null }, W, H);
    const u = lensUniforms(m);
    expect(u.uLensOn).toBe(1);
    expect(u.uVigDivide).toBe(1);
    expect(u.uVigAmount).toBeCloseTo(1.5);
    expect(m.zoom).toBe(1);
  });

  it('turns Defringe sliders into hue ranges', () => {
    const u = defringeUniforms(recipe({ defringePurple: 10, defringePurpleLo: 30, defringePurpleHi: 70 }));
    expect(u.uDefringe[0]).toBeCloseTo(0.5);
    expect(u.uDefringe[3]).toBe(1);
    expect((u.uDefringeHue[0]! * 180) / Math.PI).toBeCloseTo(296);
    expect((u.uDefringeHue[1]! * 180) / Math.PI).toBeCloseTo(344);
  });
});
