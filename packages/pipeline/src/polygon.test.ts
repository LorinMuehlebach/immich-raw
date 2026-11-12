import { newComponent, newMask, type PolygonComponent } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { componentWeight, maskPartsUniforms } from './masks.ts';
import { PolygonRasterizer, pointInPolygon, polygonKey, rasterizePolygon, simplifyPolygon } from './polygon.ts';

const sum = (a: Float32Array) => a.reduce((s, v) => s + v, 0);
const at = (m: { width: number; data: Float32Array }, x: number, y: number) => m.data[y * m.width + x]!;

describe('rasterizePolygon', () => {
  it('a texel-aligned square: exact area, full inside, empty outside', () => {
    const m = rasterizePolygon([0.25, 0.25, 0.75, 0.25, 0.75, 0.75, 0.25, 0.75], 1, 1, 64);
    expect(m.width).toBe(64);
    expect(sum(m.data)).toBeCloseTo(32 * 32, 6);
    expect(at(m, 32, 32)).toBeCloseTo(1, 6);
    expect(at(m, 10, 10)).toBe(0);
    expect(at(m, 16, 16)).toBeCloseTo(1, 6);
    expect(at(m, 15, 16)).toBe(0);
  });

  it('an unaligned triangle: area within 1 %', () => {
    // Right triangle with legs of 40.3 and 30.7 texels. Slanted edges are exact (the
    // sub-scanlines sample a linear function at midpoints); a horizontal edge part-way through
    // a row is off by up to an eighth of that row.
    const k = 1 / 64;
    const m = rasterizePolygon([3.2 * k, 5.1 * k, 43.5 * k, 5.1 * k, 3.2 * k, 35.8 * k], 1, 1, 64);
    const area = (40.3 * 30.7) / 2;
    expect(Math.abs(sum(m.data) - area) / area).toBeLessThan(0.01);
    for (const v of m.data) expect(v).toBeLessThanOrEqual(1 + 1e-6);
  });

  it('partly covered edge texels get partial coverage', () => {
    const k = 1 / 16;
    const m = rasterizePolygon([2.5 * k, 2 * k, 8 * k, 2 * k, 8 * k, 6 * k, 2.5 * k, 6 * k], 1, 1, 16);
    expect(at(m, 2, 3)).toBeCloseTo(0.5, 6);
    expect(at(m, 3, 3)).toBeCloseTo(1, 6);
    expect(at(m, 8, 3)).toBe(0);
  });

  it('even-odd: a ring drawn as one shape leaves the hole empty', () => {
    // Outer square, then back along a cut into the inner square, the other way round.
    const pts = [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9, 0.1, 0.1, 0.3, 0.3, 0.3, 0.7, 0.7, 0.7, 0.7, 0.3, 0.3, 0.3];
    const m = rasterizePolygon(pts, 1, 1, 100);
    expect(at(m, 50, 50)).toBe(0);
    expect(at(m, 20, 50)).toBeCloseTo(1, 6);
  });

  it('a wide frame gets a wide map; corners outside the frame are clipped', () => {
    const m = rasterizePolygon([-0.5, -0.5, 2, -0.5, 2, 2, -0.5, 2], 1, 0.5, 32);
    expect([m.width, m.height]).toEqual([32, 16]);
    expect(sum(m.data)).toBeCloseTo(32 * 16, 4);
  });

  it('fewer than three corners: empty', () => {
    expect(sum(rasterizePolygon([0.1, 0.1, 0.5, 0.5], 1, 1, 16).data)).toBe(0);
  });
});

describe('pointInPolygon and the CPU mask weight', () => {
  const tri = [0.1, 0.1, 0.9, 0.1, 0.1, 0.9];
  it('inside and outside', () => {
    expect(pointInPolygon(tri, [0.2, 0.2])).toBe(true);
    expect(pointInPolygon(tri, [0.8, 0.8])).toBe(false);
  });

  it('componentWeight follows it, inverted too', () => {
    const c: PolygonComponent = { ...(newComponent('polygon') as PolygonComponent), points: tri };
    expect(componentWeight(c, [0.2, 0.2])).toBe(1);
    expect(componentWeight(c, [0.8, 0.8])).toBe(0);
    expect(componentWeight({ ...c, invert: true }, [0.8, 0.8])).toBe(1);
  });

  it('the shader reads a polygon from the brush atlas, like a brush', () => {
    const c: PolygonComponent = { ...(newComponent('polygon') as PolygonComponent), points: tri };
    const u = maskPartsUniforms(newMask('m', c), [1, 1], { brushCells: new Map([[c.id, [0, 0, 0.5, 1]]]), brushHalfTexel: [0.001, 0.002], colors: new Map() });
    expect(u.uCompCount).toBe(1);
    expect(u.uCompInfo[0]).toBe(4);
    expect(Array.from(u.uCompA.slice(0, 4))).toEqual([0, 0, 0.5, 1]);
  });
});

describe('simplifyPolygon', () => {
  it('drops corners on straight lines, keeps the real ones', () => {
    // A square with many points along each side.
    const pts: number[] = [];
    for (let i = 0; i < 10; i++) pts.push(i / 10, 0);
    for (let i = 0; i < 10; i++) pts.push(1, i / 10);
    for (let i = 0; i < 10; i++) pts.push(1 - i / 10, 1);
    for (let i = 0; i < 10; i++) pts.push(0, 1 - i / 10);
    const s = simplifyPolygon(pts, 1e-4);
    expect(s).toHaveLength(8);
    for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1]]) expect(pointInPolygon(s, [x! * 0.98 + 0.01, y! * 0.98 + 0.01])).toBe(true);
  });

  it('stays under the corner limit by raising the tolerance', () => {
    const circle: number[] = [];
    for (let i = 0; i < 2000; i++) circle.push(0.5 + 0.4 * Math.cos((i / 2000) * 2 * Math.PI), 0.5 + 0.4 * Math.sin((i / 2000) * 2 * Math.PI));
    const s = simplifyPolygon(circle, 1e-7, 100);
    expect(s.length / 2).toBeLessThanOrEqual(100);
    expect(s.length / 2).toBeGreaterThan(12);
    // Still close to the circle's area.
    const m = rasterizePolygon(s, 1, 1, 200);
    expect(sum(m.data) / (200 * 200)).toBeCloseTo(Math.PI * 0.16, 1);
  });
});

describe('PolygonRasterizer', () => {
  it('re-uses the map until the corners change', () => {
    const r = new PolygonRasterizer();
    const c: PolygonComponent = { ...(newComponent('polygon') as PolygonComponent), points: [0.1, 0.1, 0.5, 0.1, 0.3, 0.4] };
    const a = r.rasterize(c, 1, 1);
    expect(r.rasterize({ ...c, points: [...c.points] }, 1, 1)).toBe(a);
    expect(r.rasterize({ ...c, points: [0.1, 0.1, 0.6, 0.1, 0.3, 0.4] }, 1, 1)).not.toBe(a);
    expect(polygonKey([0.1, 0.2, 0.3])).not.toBe(polygonKey([0.1, 0.2, 0.30001]));
  });
});
