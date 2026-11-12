import { describe, expect, it } from 'vitest';
import { resample16, resampleWeights } from './resample.ts';

const solid = (w: number, h: number, rgb: [number, number, number]) => {
  const data = new Uint16Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 65535], i * 4);
  return { data, width: w, height: h };
};

describe('resampleWeights', () => {
  it('sum to 1 for every output position, and widen when shrinking', () => {
    for (const [src, dst] of [
      [100, 37],
      [37, 100],
      [6000, 1000],
    ] as const) {
      const { taps, weights } = resampleWeights(src, dst);
      for (let i = 0; i < dst; i++) {
        let s = 0;
        for (let t = 0; t < taps; t++) s += weights[i * taps + t]!;
        expect(s).toBeCloseTo(1, 5);
      }
    }
    expect(resampleWeights(6000, 1000).taps).toBeGreaterThan(resampleWeights(100, 100).taps);
  });
});

describe('resample16', () => {
  it('keeps a constant colour exactly, at any size', () => {
    const out = resample16(solid(64, 40, [1000, 40000, 65535]), 17, 11);
    expect([out.width, out.height]).toEqual([17, 11]);
    for (let i = 0; i < 17 * 11; i++) expect([...out.data.subarray(i * 4, i * 4 + 4)]).toEqual([1000, 40000, 65535, 65535]);
  });

  it('returns the input at the same size', () => {
    const img = solid(3, 3, [1, 2, 3]);
    expect(resample16(img, 3, 3)).toBe(img);
  });

  it('keeps a horizontal ramp a ramp, without leaving the 16-bit range', () => {
    const w = 400;
    const img = solid(w, 2, [0, 0, 0]);
    for (let x = 0; x < w; x++) for (let y = 0; y < 2; y++) img.data[(y * w + x) * 4] = Math.round((x / (w - 1)) * 65535);
    const out = resample16(img, 100, 2);
    const reds = Array.from({ length: 100 }, (_, x) => out.data[x * 4]!);
    for (let x = 1; x < 100; x++) expect(reds[x]!).toBeGreaterThanOrEqual(reds[x - 1]!);
    // The middle of the ramp lands in the middle of the range.
    expect(reds[50]! / 65535).toBeCloseTo(0.505, 2);
    expect(Math.min(...reds)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...reds)).toBeLessThanOrEqual(65535);
  });

  it('clamps the ringing of a hard edge to the range', () => {
    const w = 50;
    const img = solid(w, 1, [0, 0, 0]);
    for (let x = w / 2; x < w; x++) img.data.set([65535, 65535, 65535], x * 4);
    const out = resample16(img, 120, 1); // enlarging rings most
    for (let i = 0; i < out.data.length; i++) {
      expect(out.data[i]).toBeGreaterThanOrEqual(0);
      expect(out.data[i]).toBeLessThanOrEqual(65535);
    }
  });
});
