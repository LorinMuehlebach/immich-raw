import { describe, expect, it } from 'vitest';
import { EYE_LEFT, IRIS_LEFT, LANDMARKS, LIPS_INNER, LIPS_OUTER, faceParts, fillDisc, fillPolygon } from './faces.ts';
import { regions } from './labels.ts';

const sum = (m: Float32Array) => m.reduce((a, b) => a + b, 0);

/** Landmarks with the given rings placed as circles (normalised centre and radius). */
function face(rings: [readonly number[], number, number, number][]): Float32Array {
  const lm = new Float32Array(LANDMARKS * 2).fill(0.5);
  for (const [idx, cx, cy, r] of rings) {
    idx.forEach((i, k) => {
      const a = (2 * Math.PI * k) / idx.length;
      lm[2 * i] = cx + r * Math.cos(a);
      lm[2 * i + 1] = cy + r * Math.sin(a);
    });
  }
  return lm;
}

describe('face parts', () => {
  it('fills polygons and discs by pixel centre', () => {
    const m = new Float32Array(100);
    fillPolygon(m, 10, 10, [2, 2, 6, 2, 6, 5, 2, 5]);
    expect(sum(m)).toBe(12);
    fillPolygon(m, 10, 10, [2, 2, 4, 2, 4, 5, 2, 5], 1, 'clear');
    expect(sum(m)).toBe(6);
    const d = new Float32Array(100);
    fillDisc(d, 10, 10, 5, 5, 2);
    expect(sum(d)).toBe(12);
  });

  it('makes lips a ring around the mouth and keeps the iris inside the eye', () => {
    const lm = face([
      [LIPS_OUTER, 0.5, 0.7, 0.2],
      [LIPS_INNER, 0.5, 0.7, 0.1],
      [EYE_LEFT, 0.3, 0.3, 0.1],
      [IRIS_LEFT, 0.38, 0.3, 0.05],
    ]);
    const p = faceParts([lm], 100, 100);
    const at = (m: Float32Array, x: number, y: number) => m[y * 100 + x];
    expect([at(p.lips, 50, 70), at(p.mouth, 50, 70), at(p.lips, 50, 85)]).toEqual([0, 1, 1]);
    // Iris pixels outside the eye are dropped.
    expect(at(p.iris, 42, 30)).toBe(0);
    expect(at(p.iris, 37, 30)).toBe(1);
  });

  it('labels connected regions, largest first, dropping small ones', () => {
    const m = new Uint8Array([
      1, 1, 0, 0, 1,
      1, 0, 0, 0, 0,
      0, 0, 1, 1, 1,
      0, 0, 0, 1, 1,
    ]);
    const r = regions(m, 5, 4, 0.5, 2);
    expect(r.boxes).toEqual([[2, 2, 5, 4], [0, 0, 2, 2]]);
    expect([...r.labels]).toEqual([2, 2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1]);
  });
});
