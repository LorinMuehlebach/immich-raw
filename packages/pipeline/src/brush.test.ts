import type { BrushComponent, BrushStroke } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { BRUSH_RES, BrushRasterizer, brushRadius, packBrushAtlas, packMaskAtlas } from './brush.ts';
import { colorFeature, colorRangeReach } from './masks.ts';

const stroke = (points: number[], patch: Partial<BrushStroke> = {}): BrushStroke => ({ erase: false, size: 0.02, feather: 50, flow: 100, density: 100, points, ...patch });
const comp = (strokes: BrushStroke[]): BrushComponent => ({ id: 'b1', kind: 'brush', mode: 'add', invert: false, strokes });
const at = (map: { width: number; data: Float32Array }, x: number, y: number) => map.data[Math.round(y * BRUSH_RES) * map.width + Math.round(x * BRUSH_RES)]!;

describe('brush masks', () => {
  it('paints along the stroke with a soft edge', () => {
    const map = new BrushRasterizer().rasterize(comp([stroke([0.2, 0.3, 0.6, 0.3])]), 1, 2 / 3);
    expect(map.width).toBe(BRUSH_RES);
    expect(map.height).toBe(Math.round((BRUSH_RES * 2) / 3));
    expect(at(map, 0.4, 0.3)).toBeCloseTo(1, 3);
    expect(at(map, 0.4, 0.3 + 0.017)).toBeGreaterThan(0.05);
    expect(at(map, 0.4, 0.3 + 0.017)).toBeLessThan(0.95);
    expect(at(map, 0.4, 0.36)).toBe(0);
    expect(at(map, 0.7, 0.3)).toBe(0);
  });

  it('density caps the build-up; flow builds up over overlapping dabs', () => {
    const half = new BrushRasterizer().rasterize(comp([stroke([0.2, 0.3, 0.6, 0.3], { density: 50 })]), 1, 1);
    expect(at(half, 0.4, 0.3)).toBeCloseTo(0.5, 2);
    const weak = new BrushRasterizer().rasterize(comp([stroke([0.4, 0.3], { flow: 20 })]), 1, 1);
    expect(at(weak, 0.4, 0.3)).toBeCloseTo(0.2, 3);
    const built = new BrushRasterizer().rasterize(comp([stroke([0.3, 0.3, 0.5, 0.3], { flow: 20 })]), 1, 1);
    expect(at(built, 0.4, 0.3)).toBeGreaterThan(0.8);
  });

  it('erasing strokes take paint away', () => {
    const map = new BrushRasterizer().rasterize(comp([stroke([0.2, 0.3, 0.6, 0.3]), stroke([0.4, 0.2, 0.4, 0.4], { erase: true, feather: 0 })]), 1, 1);
    expect(at(map, 0.4, 0.3)).toBe(0);
    expect(at(map, 0.3, 0.3)).toBeCloseTo(1, 3);
  });

  it('continuing a stroke gives the same map as painting it in one go', () => {
    const r = new BrushRasterizer();
    const pts = [0.1, 0.1, 0.3, 0.2, 0.5, 0.15, 0.7, 0.4];
    r.rasterize(comp([stroke(pts.slice(0, 4))]), 1, 1);
    const step = r.rasterize(comp([stroke(pts)]), 1, 1);
    const once = new BrushRasterizer().rasterize(comp([stroke(pts)]), 1, 1);
    let diff = 0;
    for (let i = 0; i < once.data.length; i++) diff = Math.max(diff, Math.abs(once.data[i]! - step.data[i]!));
    expect(diff).toBeLessThan(0.02);
    // Undo (fewer points) starts over.
    const undone = r.rasterize(comp([stroke(pts.slice(0, 4))]), 1, 1);
    expect(at(undone, 0.7, 0.4)).toBe(0);
  });

  it('packs maps two per row and tells the shader where each is', () => {
    const r = new BrushRasterizer();
    const maps = ['a', 'b', 'c'].map((id) => ({ id, map: r.rasterize({ ...comp([stroke([0.5, 0.5])]), id }, 1, 0.5) }));
    const atlas = packBrushAtlas(maps)!;
    expect([atlas.width, atlas.height]).toEqual([2 * BRUSH_RES, 2 * (BRUSH_RES / 2)]);
    expect(atlas.cells.get('c')).toEqual([0, 0.5, 0.5, 0.5]);
    expect(packBrushAtlas([])).toBeNull();
    expect(brushRadius(1)).toBeLessThan(brushRadius(100));
  });
});

describe('colour range feature', () => {
  it('does not change with exposure and separates hues', () => {
    const orange = colorFeature([0.4, 0.2, 0.05]);
    const brighter = colorFeature([0.8, 0.4, 0.1]);
    expect(Math.hypot(orange[0] - brighter[0], orange[1] - brighter[1])).toBeLessThan(1e-6);
    const grey = colorFeature([0.2, 0.2, 0.2]);
    expect(Math.hypot(grey[0], grey[1])).toBeLessThan(0.01);
    expect(Math.hypot(orange[0] - grey[0], orange[1] - grey[1])).toBeGreaterThan(colorRangeReach(100));
  });

  it('packs 8-bit maps and scales cells down to the GPU limit', () => {
    const map = { width: 40, height: 20, data: new Uint8Array(800).fill(200) };
    map.data[0] = 7;
    const maps = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, map }));
    const full = packMaskAtlas(maps)!;
    expect([full.width, full.height]).toEqual([80, 60]);
    expect(full.data[0]).toBe(7);
    expect(full.data[41]).toBe(200);
    // 80 x 60 doesn't fit in 32: every cell shrinks by the same factor (2.5 -> 16 x 8).
    const small = packMaskAtlas(maps, 32)!;
    expect([small.width, small.height]).toEqual([32, 24]);
    expect(small.cells.get('e')).toEqual([0, 16 / 24, 0.5, 8 / 24]);
    expect(small.data[1]).toBe(200);
  });
});
