import { describe, expect, it } from 'vitest';
import { MASK_FEATHER, MASK_OFFSET, MAX_COMPONENTS, MAX_MASKS, MAX_OBJECT_POINTS, aiComponents, aiCount, aiLabel, isMaskActive, isMaskRefined, isPartRefined, newAiComponent, newComponent, newMask, normalizeMasks } from './masks.ts';
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

  it('refines the whole mask edge: defaults, clamping, and old masks without it', () => {
    const fresh = newMask('a', newComponent('radial'));
    expect(fresh.edge).toEqual({ offset: 0, feather: 0, smooth: 0 });
    expect(isMaskRefined(fresh)).toBe(false);
    // Stored before refinement existed: nothing changes.
    const [old] = normalizeMasks([{ name: 'old', components: [newComponent('radial')] }]);
    expect(old!.edge).toEqual({ offset: 0, feather: 0, smooth: 0 });
    const [m] = normalizeMasks([{ components: [newComponent('radial')], edge: { offset: -500, feather: 12.4, smooth: 'x' } }]);
    expect(m!.edge).toEqual({ offset: MASK_OFFSET.min, feather: 12, smooth: 0 });
    expect(isMaskRefined(m!)).toBe(true);
    const round = { ...fresh, edge: { offset: 8, feather: 30, smooth: 5 } };
    expect(normalizeMasks(JSON.parse(JSON.stringify([round])))).toEqual([round]);
    // A refinement alone doesn't make a mask change the picture.
    expect(isMaskActive(round)).toBe(false);
    expect(isMaskRefined({ edge: undefined as never })).toBe(false);
  });

  it('refines the edge of a part, kept only while it does something', () => {
    const [m] = normalizeMasks([
      {
        components: [
          { ...newComponent('radial'), edge: { offset: 0, feather: 0, smooth: 0 } },
          { ...newComponent('color', 'subtract'), refine: 70, edge: { offset: 12, feather: 400, smooth: 3 } },
        ],
      },
    ]);
    const [radial, color] = m!.components;
    expect('edge' in radial!).toBe(false);
    expect(isPartRefined(radial!)).toBe(false);
    // A colour range keeps its own Refine slider next to the edge.
    expect(color!.kind === 'color' && color!.refine).toBe(70);
    expect(color!.edge).toEqual({ offset: 12, feather: MASK_FEATHER.max, smooth: 3 });
    expect(isPartRefined(color!)).toBe(true);
    expect(normalizeMasks(JSON.parse(JSON.stringify([m])))).toEqual([m]);
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
  it('round-trips AI components and keeps no pixels', () => {
    const m = newMask('People', newAiComponent('people', 'add', { parts: ['lips', 'faceSkin'], person: { x: 0.3, y: 0.2 } }));
    m.components.push(newAiComponent('landscape', 'subtract', { classes: ['water', 'sky'] }));
    m.components.push(newAiComponent('object', 'intersect', { box: [0.1, 0.2, 0.4, 0.5] }));
    m.components.push(newAiComponent('subject'));
    const back = normalizeMasks(JSON.parse(JSON.stringify([m])));
    // Lists come back in Lightroom's order, so the same selection always has the same JSON.
    expect(back[0]!.components[0]).toMatchObject({ kind: 'ai', target: 'people', parts: ['faceSkin', 'lips'], person: { x: 0.3, y: 0.2 } });
    expect(back[0]!.components[1]).toMatchObject({ target: 'landscape', classes: ['sky', 'water'] });
    expect(back[0]!.components[2]).toMatchObject({ target: 'object', box: [0.1, 0.2, 0.4, 0.5] });
    expect(back[0]!.components[3]).toEqual({ id: m.components[3]!.id, mode: 'add', invert: false, kind: 'ai', target: 'subject' });
    expect(aiCount(back)).toBe(4);
    expect(aiComponents(back).map((c) => c.target)).toEqual(['people', 'landscape', 'object', 'subject']);
  });

  it('cleans up AI components', () => {
    const out = normalizeMasks([
      {
        components: [
          { kind: 'ai', target: 'people', parts: ['nose', 'hair', 'hair'], person: 'x' },
          { kind: 'ai', target: 'unicorns' },
          { kind: 'ai', target: 'landscape', classes: ['lava'] },
          { kind: 'ai', target: 'object' },
          { kind: 'ai', target: 'object', box: [0.6, 0.6, 0.2, 0.1], points: Array.from({ length: 400 }, (_, i) => i / 400) },
          { kind: 'ai', target: 'sky', parts: ['hair'], classes: ['sky'] },
        ],
      },
    ]);
    const cs = out[0]!.components;
    expect(cs).toHaveLength(3);
    expect(cs[0]).toMatchObject({ target: 'people', parts: ['hair'], person: null });
    expect(cs[1]).toMatchObject({ target: 'object', box: [0.2, 0.1, 0.6, 0.6] });
    expect(cs[1]!.kind === 'ai' && cs[1]!.points!.length).toBe(MAX_OBJECT_POINTS * 2);
    // Fields that don't belong to the target are dropped.
    expect(cs[2]).toEqual({ id: expect.any(String), mode: 'add', invert: false, kind: 'ai', target: 'sky' });
  });

  it('names AI selections like Lightroom', () => {
    expect(aiLabel({ target: 'subject' })).toBe('Subject');
    expect(aiLabel({ target: 'people', parts: ['person'] })).toBe('People');
    expect(aiLabel({ target: 'people', parts: ['faceSkin'], person: { x: 0, y: 0 } })).toBe('Person – Face Skin');
    expect(aiLabel({ target: 'people', parts: ['faceSkin', 'lips', 'teeth'] })).toBe('People – Face Skin + Lips + …');
    expect(aiLabel({ target: 'landscape', classes: ['sky', 'water'] })).toBe('Landscape – Sky + Water');
  });
});
