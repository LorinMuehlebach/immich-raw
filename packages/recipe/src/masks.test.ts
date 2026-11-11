import { describe, expect, it } from 'vitest';
import { MAX_COMPONENTS, MAX_MASKS, isMaskActive, newComponent, newMask, normalizeMasks } from './masks.ts';
import { defaultRecipe, normalizeRecipe } from './recipe.ts';

describe('masks', () => {
  it('round-trips a valid mask', () => {
    const m = newMask('Sky', newComponent('linear'));
    m.adjust.exposure = -0.7;
    m.components.push({ ...newComponent('luminance', 'intersect'), lo: 60, hi: 100 } as never);
    expect(normalizeMasks(JSON.parse(JSON.stringify([m])))).toEqual([m]);
  });

  it('cleans up stored masks', () => {
    const out = normalizeMasks([
      { name: '', components: [{ kind: 'radial', mode: 'subtract', cx: 0.4, rx: -1, angle: 370, feather: 500 }], adjust: { exposure: 9, saturation: 'x' } },
      { name: 'empty', components: [{ kind: 'blob' }] },
      'junk',
    ]);
    expect(out).toHaveLength(1);
    const m = out[0]!;
    expect(m.name).toBe('Mask 1');
    expect(m.visible).toBe(true);
    expect(m.amount).toBe(100);
    expect(m.adjust.exposure).toBe(4);
    expect(m.adjust.saturation).toBe(0);
    const c = m.components[0]!;
    expect(c.mode).toBe('add'); // the first component always adds
    expect(c.kind === 'radial' && [c.rx, c.angle, c.feather]).toEqual([1e-3, 10, 100]);
  });

  it('cleans up brush strokes and colour samples', () => {
    const [m] = normalizeMasks([
      {
        components: [
          { kind: 'brush', strokes: [{ size: 5, flow: 0, points: [0.1234567, 0.2, 'x', 0.3, 0.4] }, { points: [] }, 'junk'] },
          { kind: 'color', mode: 'intersect', refine: 300, samples: [{ x: 0.2, y: 0.3, r: 1 }, ...Array.from({ length: 9 }, () => ({ x: 0.5, y: 0.5 }))] },
        ],
      },
    ]);
    const [brush, color] = m!.components;
    expect(brush!.kind === 'brush' && brush!.strokes).toEqual([{ erase: false, size: 1, feather: 50, flow: 1, density: 100, points: [0.12346, 0.2] }]);
    expect(color!.kind === 'color' && [color!.samples.length, color!.samples[0], color!.refine]).toEqual([5, { x: 0.2, y: 0.3, r: 0.25 }, 100]);
  });

  it('enforces the mask and component limits', () => {
    const many = Array.from({ length: MAX_MASKS + 3 }, (_, i) => ({ name: `m${i}`, components: Array.from({ length: 5 }, () => newComponent('radial')) }));
    const out = normalizeMasks(many);
    expect(out.length).toBeLessThanOrEqual(MAX_MASKS);
    expect(out.reduce((n, m) => n + m.components.length, 0)).toBeLessThanOrEqual(MAX_COMPONENTS);
  });

  it('keeps luminance ranges ordered and gradients non-degenerate', () => {
    const [m] = normalizeMasks([{ components: [{ kind: 'luminance', lo: 80, hi: 20 }, { kind: 'linear', mode: 'add', x0: 0.3, y0: 0.3, x1: 0.3, y1: 0.3 }] }]);
    const [lum, lin] = m!.components;
    expect(lum!.kind === 'luminance' && [lum.lo, lum.hi]).toEqual([20, 80]);
    expect(lin!.kind === 'linear' && Math.hypot(lin.x1 - lin.x0, lin.y1 - lin.y0)).toBeGreaterThan(0);
  });

  it('is active only with a non-zero slider while visible', () => {
    const m = newMask('a', newComponent('radial'));
    expect(isMaskActive(m)).toBe(false);
    m.adjust.colorHue = 200; // a hue without saturation does nothing
    expect(isMaskActive(m)).toBe(false);
    m.adjust.clarity = 20;
    expect(isMaskActive(m)).toBe(true);
    m.visible = false;
    expect(isMaskActive(m)).toBe(false);
  });

  it('is part of the recipe; old recipes get lens corrections off, new ones on', () => {
    expect(defaultRecipe().masks).toEqual([]);
    expect(defaultRecipe().lens.profile).toBe(true);
    const old = normalizeRecipe({ schema: 1, basic: { exposure: 1 } });
    expect(old.lens.profile).toBe(false);
    expect(old.lens.removeCA).toBe(false);
    expect(old.masks).toEqual([]);
    const withLens = normalizeRecipe({ schema: 1, lens: { profile: true, distortion: 30, removeCA: false } });
    expect([withLens.lens.profile, withLens.lens.distortion, withLens.lens.removeCA]).toEqual([true, 30, false]);
  });
});
