import { defaultRecipe, newAiComponent, newComponent, newMask, type LinearComponent, type LuminanceComponent, type RadialComponent } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { refineLayout, refineSteps } from './mask-refine.ts';
import { KIND_MASK_REFINED, KIND_PART_REFINED, componentWeight, maskFrameScale, maskPartsUniforms, maskUniforms, maskWeight } from './masks.ts';

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

  it('leaves AI parts out until their map is ready', () => {
    const r = defaultRecipe();
    const m = newMask('Sky', newAiComponent('sky'));
    m.components.push({ ...newAiComponent('subject', 'subtract'), invert: true });
    m.adjust.exposure = -1;
    r.masks = [m];
    const none = maskUniforms(r, [1, 1]);
    expect([none.uMaskCount, none.uCompCount]).toEqual([1, 0]);
    const ready = maskUniforms(r, [1, 1], null, {
      brushCells: new Map(),
      brushHalfTexel: [0, 0],
      colors: new Map(),
      aiCells: new Map([[m.components[1]!.id, [0.5, 0, 0.5, 1]]]),
      aiHalfTexel: [0.01, 0.02],
    });
    expect(ready.uCompCount).toBe(1);
    expect([...ready.uCompInfo.slice(0, 4)]).toEqual([6, 1, 0, 1]);
    expect([...ready.uCompA.slice(0, 4)]).toEqual([0.5, 0, 0.5, 1]);
    expect([...ready.uCompB.slice(0, 2)].map((v) => Math.round(v * 100) / 100)).toEqual([0.01, 0.02]);
    // The CPU copy has no map to read: an AI part selects nothing there.
    expect(maskWeight(m, [0.5, 0.5])).toBe(0);
  });

  const noRes = { brushCells: new Map(), brushHalfTexel: [0, 0] as [number, number], colors: new Map() };

  it('reads a refined mask from its map as one part, and its parts until the map exists', () => {
    const r = defaultRecipe();
    const plain = newMask('Plain', linear());
    plain.adjust.exposure = 1;
    const sky = newMask('Sky', radial());
    sky.components.push(lumRange({ mode: 'intersect' }));
    sky.adjust.exposure = -1;
    sky.edge = { offset: 10, feather: 0, smooth: 0 };
    r.masks = [plain, sky];
    // No map (yet): the parts, as before.
    expect(maskUniforms(r, [1, 1], null, noRes).uCompCount).toBe(3);
    const u = maskUniforms(r, [1, 1], sky.id, { ...noRes, maskCells: new Map([[sky.id, [0, 0.5, 1, 0.5]]]), maskHalfTexel: [0.25, 0.5] });
    expect([u.uMaskCount, u.uCompCount, u.uOverlay]).toEqual([2, 2, 1]);
    expect([...u.uCompInfo.slice(0, 4)]).toEqual([1, 0, 0, 0]);
    expect([...u.uCompInfo.slice(4, 8)]).toEqual([KIND_MASK_REFINED, 0, 1, 0]);
    expect([...u.uCompA.slice(4, 8)]).toEqual([0, 0.5, 1, 0.5]);
    expect([...u.uCompB.slice(4, 6)]).toEqual([0.25, 0.5]);
    expect(u.uMaskE[4]).toBeCloseTo(-1);
  });

  it('reads a refined part from its map, keeping its mode; the map holds the inversion', () => {
    const r = defaultRecipe();
    const m = newMask('Sky', radial());
    const lum = lumRange({ mode: 'subtract', invert: true, edge: { offset: 0, feather: 20, smooth: 0 } });
    m.components.push(lum);
    m.adjust.exposure = -1;
    r.masks = [m];
    const u = maskUniforms(r, [1, 1], null, { ...noRes, partCells: new Map([[lum.id, [0.5, 0, 0.5, 1]]]), partHalfTexel: [0.1, 0.2] });
    expect(u.uCompCount).toBe(2);
    expect([...u.uCompInfo.slice(0, 4)]).toEqual([2, 0, 0, 0]);
    expect([...u.uCompInfo.slice(4, 8)]).toEqual([KIND_PART_REFINED, 1, 0, 0]);
    expect([...u.uCompA.slice(4, 8)]).toEqual([0.5, 0, 0.5, 1]);
    // The whole mask, refined too, reads its own map instead (made from the refined part).
    m.edge = { offset: 5, feather: 0, smooth: 0 };
    const both = maskUniforms(r, [1, 1], null, { ...noRes, partCells: new Map([[lum.id, [0.5, 0, 0.5, 1]]]), maskCells: new Map([[m.id, [0, 0, 1, 1]]]) });
    expect([both.uCompCount, both.uCompInfo[0]]).toEqual([1, KIND_MASK_REFINED]);
    // Rendering the whole mask's map: the refined part comes from its map.
    const parts = maskPartsUniforms(m, [1, 1], { ...noRes, partCells: new Map([[lum.id, [0.5, 0, 0.5, 1]]]) });
    expect([...parts.uCompInfo.slice(4, 8)]).toEqual([KIND_PART_REFINED, 1, 0, 0]);
  });

  it('packs one mask alone into slot 0 for the refinement, adjusted or not', () => {
    const m = newMask('Idle', radial());
    m.components.push(lumRange({ mode: 'subtract', invert: true }));
    const u = maskPartsUniforms(m, [1, 0.5], noRes);
    expect([u.uMaskCount, u.uCompCount, u.uOverlay]).toEqual([1, 2, -1]);
    expect([...u.uCompInfo.slice(0, 8)]).toEqual([2, 0, 0, 0, 3, 1, 0, 1]);
    expect(u.uMaskFrame).toEqual([1, 0.5]);
  });
});

describe('mask refinement', () => {
  it('runs only the steps that are set, in texels of the map', () => {
    expect(refineSteps({ offset: 0, feather: 0, smooth: 0 }, 0.5)).toEqual([]);
    const grow = refineSteps({ offset: 20, feather: 0, smooth: 0 }, 0.5);
    expect(grow.map((s) => [s.kind, s.dir, s.mode])).toEqual([
      ['morph', [1, 0], 1],
      ['morph', [0, 1], 1],
      ['morph', [1, 1], 1],
      ['morph', [1, -1], 1],
    ]);
    // An octagon of inradius 10 texels: along the axes and along the diagonals.
    const [h, , d] = grow;
    expect(h!.radius! + 2 * d!.radius!).toBeCloseTo(10);
    expect(h!.radius! * Math.SQRT2 + d!.radius! * Math.SQRT2).toBeCloseTo(10);
    expect(refineSteps({ offset: -20, feather: 0, smooth: 0 }, 0.5).every((s) => s.mode === -1)).toBe(true);
    const all = refineSteps({ offset: 4, feather: 25, smooth: 10 }, 1);
    expect(all.map((s) => s.kind)).toEqual(['blur', 'blur', 'morph', 'morph', 'morph', 'morph', 'blur', 'blur']);
    // Smooth: sigma = radius / 2, crisp again on the second pass; feather: sigma = width / 2.5.
    expect([all[0]!.sigma, all[0]!.sharpen]).toEqual([5, undefined]);
    expect(all[1]!.sharpen).toBeCloseTo(0.12);
    expect([all[6]!.sigma, all[7]!.sharpen]).toEqual([10, undefined]);
  });

  it('lays out the maps with the least scaling that fits the GPU limit', () => {
    expect(refineLayout(1, 2048, 1365, 8192)).toEqual({ cols: 1, w: 2048, h: 1365, W: 2048, H: 1365 });
    const l = refineLayout(5, 2048, 1365, 4096);
    expect(l.cols).toBe(2);
    expect(l.W).toBeLessThanOrEqual(4096);
    expect(l.H).toBeLessThanOrEqual(4096);
    expect(l.H).toBe(3 * l.h);
    // Every part of every mask refined: still full size on a desktop GPU.
    const many = refineLayout(24, 2048, 1365, 16384);
    expect([many.w, many.h]).toEqual([2048, 1365]);
    expect(Math.max(many.W, many.H)).toBeLessThanOrEqual(16384);
  });
});
