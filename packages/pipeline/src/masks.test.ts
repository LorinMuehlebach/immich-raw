import { defaultRecipe, newComponent, newMask, type LinearComponent, type LuminanceComponent, type RadialComponent } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { componentWeight, maskFrameScale, maskUniforms, maskWeight } from './masks.ts';

const linear = (o: Partial<LinearComponent> = {}): LinearComponent => ({ ...(newComponent('linear') as LinearComponent), x0: 0.5, y0: 0, x1: 0.5, y1: 0.4, ...o });
const radial = (o: Partial<RadialComponent> = {}): RadialComponent => ({ ...(newComponent('radial') as RadialComponent), cx: 0.5, cy: 0.3, rx: 0.2, ry: 0.1, angle: 0, feather: 50, ...o });
const lumRange = (o: Partial<LuminanceComponent> = {}): LuminanceComponent => ({ ...(newComponent('luminance') as LuminanceComponent), lo: 50, hi: 100, smooth: 20, ...o });

describe('mask components', () => {
  it('linear gradient: full at the start, half in the middle, none past the end', () => {
    const c = linear();
    expect(componentWeight(c, [0.2, -0.1])).toBe(1);
    expect(componentWeight(c, [0.9, 0.2])).toBeCloseTo(0.5, 6);
    expect(componentWeight(c, [0.5, 0.5])).toBe(0);
    expect(componentWeight({ ...c, invert: true }, [0.5, 0.5])).toBe(1);
  });

  it('radial gradient: full inside, feathered edge, rotated with the angle', () => {
    const c = radial();
    expect(componentWeight(c, [0.5, 0.3])).toBe(1);
    expect(componentWeight(c, [0.5 + 0.2 * 0.4, 0.3])).toBe(1); // inside the unfeathered core
    const edge = componentWeight(c, [0.5 + 0.2 * 0.75, 0.3]);
    expect(edge).toBeGreaterThan(0.1);
    expect(edge).toBeLessThan(0.9);
    expect(componentWeight(c, [0.5 + 0.21, 0.3])).toBe(0);
    // 0.15 along y is outside a 0.1 tall ellipse, but inside once the long axis points down.
    expect(componentWeight(c, [0.5, 0.42])).toBe(0);
    expect(componentWeight({ ...c, angle: 90 }, [0.5, 0.42])).toBeGreaterThan(0.2);
  });

  it('radial gradient with no feather has a hard edge', () => {
    const c = radial({ feather: 0 });
    expect(componentWeight(c, [0.5 + 0.199, 0.3])).toBe(1);
    expect(componentWeight(c, [0.5 + 0.2005, 0.3])).toBe(0);
  });

  it('luminance range selects bright or dark tones with soft edges', () => {
    const c = lumRange();
    expect(componentWeight(c, [0, 0], 0.8)).toBe(1);
    expect(componentWeight(c, [0, 0], 0.2)).toBe(0);
    const soft = componentWeight(c, [0, 0], 0.46);
    expect(soft).toBeGreaterThan(0);
    expect(soft).toBeLessThan(1);
    expect(componentWeight(lumRange({ lo: 0, hi: 30 }), [0, 0], 0)).toBe(1);
  });

  it('combines components: add (max), subtract, intersect', () => {
    const a = radial({ cx: 0.3 });
    const b = radial({ cx: 0.7, mode: 'add' });
    const m = { components: [a, b] };
    expect(maskWeight(m, [0.3, 0.3])).toBe(1);
    expect(maskWeight(m, [0.7, 0.3])).toBe(1);
    expect(maskWeight({ components: [a, radial({ cx: 0.3, rx: 0.05, ry: 0.05, feather: 0, mode: 'subtract' })] }, [0.3, 0.3])).toBe(0);
    expect(maskWeight({ components: [a, lumRange({ mode: 'intersect' })] }, [0.3, 0.3], 0.1)).toBe(0);
    expect(maskWeight({ components: [a, lumRange({ mode: 'intersect' })] }, [0.3, 0.3], 0.9)).toBe(1);
  });
});

describe('maskUniforms', () => {
  it('packs active masks with the amount folded in, and skips idle ones', () => {
    const r = defaultRecipe();
    const sky = newMask('Sky', linear());
    sky.adjust.exposure = -1;
    sky.adjust.clarity = 40;
    sky.amount = 50;
    const idle = newMask('Idle', radial());
    const off = newMask('Off', radial());
    off.adjust.dehaze = 30;
    off.visible = false;
    r.masks = [idle, sky, off];
    const u = maskUniforms(r, [1, 0.66]);
    expect(u.uMaskCount).toBe(1);
    expect(u.uCompCount).toBe(1);
    expect([...u.uCompInfo.slice(0, 4)]).toEqual([1, 0, 0, 0]);
    expect(u.uMaskE[0]).toBeCloseTo(-0.5);
    expect(u.uMaskE[2]).toBeCloseTo(0.2);
    expect(u.uses).toEqual({ detail: true, dehaze: false, sharpness: false });
    expect(u.uOverlay).toBe(-1);
  });

  it('includes the overlay mask even without adjustments', () => {
    const r = defaultRecipe();
    const m = newMask('New', radial());
    r.masks = [m];
    const u = maskUniforms(r, [1, 1], m.id);
    expect(u.uMaskCount).toBe(1);
    expect(u.uOverlay).toBe(0);
    expect([...u.uMaskE.slice(0, 4)]).toEqual([0, 0, 0, 0]);
  });

  it('keeps the mask frame isotropic', () => {
    expect(maskFrameScale(6000, 4000)).toEqual([1, 4000 / 6000]);
    expect(maskFrameScale(4000, 6000)).toEqual([4000 / 6000, 1]);
  });
});
