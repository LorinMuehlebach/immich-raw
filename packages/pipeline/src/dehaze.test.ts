import { describe, expect, it } from 'vitest';
import { estimateDehaze, guidedFilter } from './dehaze.ts';

/** A scene with a clear dark foreground and a hazy (bright, low-contrast) top half. */
function hazyScene(w: number, h: number): Float32Array {
  const px = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const hazy = y < h / 2;
      const detail = ((x >> 2) + (y >> 2)) % 2 ? 0.05 : 0;
      px[i] = hazy ? 0.7 + detail * 0.2 : 0.08 + detail;
      px[i + 1] = hazy ? 0.75 + detail * 0.2 : 0.1 + detail;
      px[i + 2] = hazy ? 0.8 + detail * 0.2 : 0.05 + detail;
      px[i + 3] = 1;
    }
  }
  return px;
}

describe('estimateDehaze', () => {
  it('finds a bright bluish airlight and low transmission in the haze', () => {
    const w = 64;
    const h = 48;
    const est = estimateDehaze(hazyScene(w, h), w, h, 1, 3);
    expect(est.airlight[2]).toBeGreaterThan(est.airlight[0]);
    expect(est.airlight[1]).toBeGreaterThan(0.7);
    const tHaze = est.transmission[10 * w + 32]!;
    const tClear = est.transmission[40 * w + 32]!;
    expect(tHaze).toBeLessThan(0.5);
    expect(tClear).toBeGreaterThan(0.8);
    for (const t of est.transmission) {
      expect(t).toBeGreaterThanOrEqual(0.1);
      expect(t).toBeLessThanOrEqual(1);
    }
  });

  it('strength 0 leaves transmission at 1', () => {
    const est = estimateDehaze(hazyScene(32, 24), 32, 24, 0, 2);
    expect(Math.min(...est.transmission)).toBeCloseTo(1, 5);
  });
});

describe('guidedFilter', () => {
  it('preserves a step edge in the guide', () => {
    const w = 40;
    const h = 4;
    const I = new Float32Array(w * h).map((_, i) => (i % w < 20 ? 0 : 1));
    const q = guidedFilter(I, I, w, h, 4, 1e-4);
    expect(q[5]).toBeCloseTo(0, 2);
    expect(q[35]).toBeCloseTo(1, 2);
  });
});
