import { describe, expect, it } from 'vitest';
import { HDR_AUTO_MIN, autoHdr, autoTone } from './auto.ts';
import { HDR_GLSL, HDR_TONE, hdrCurve } from './hdr-tone.ts';

const MID = Math.log2(0.18);

/** log2 luminance samples spread evenly between two tones (stops from middle grey). */
function spread(lo: number, hi: number, n = 2000): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = MID + lo + ((hi - lo) * i) / (n - 1);
  return out;
}

describe('hdrCurve', () => {
  it('leaves everything alone at amount 0', () => {
    for (const x of [-12, -3, 0, 2, 8]) expect(hdrCurve(x, 0)).toBe(x);
  });

  it('keeps the pivot, takes range away around it, and is increasing', () => {
    const { pivot, scale } = HDR_TONE;
    for (const a of [0.2, 0.6, 1]) {
      expect(hdrCurve(pivot, a)).toBeCloseTo(pivot, 12);
      // In the middle of the range (no end bending yet) the slope is 1 - scale x amount.
      const slope = (hdrCurve(pivot + 0.5, a) - hdrCurve(pivot - 0.5, a)) / 1;
      expect(slope).toBeCloseTo(1 - scale * a, 6);
      let prev = -Infinity;
      for (let x = -14; x <= 12; x += 0.01) {
        const y = hdrCurve(x, a);
        expect(y).toBeGreaterThan(prev);
        prev = y;
      }
      expect(hdrCurve(6, a)).toBeLessThan(6);
      expect(hdrCurve(-10, a)).toBeGreaterThan(-10);
    }
    expect(hdrCurve(6, 1)).toBeLessThan(hdrCurve(6, 0.5));
    expect(hdrCurve(-10, 1)).toBeGreaterThan(hdrCurve(-10, 0.5));
  });

  it('visibly changes an ordinary photo: a 6 stop spread loses about 2 stops', () => {
    const before = 3 - -3;
    const after = hdrCurve(3, 1) - hdrCurve(-3, 1);
    expect(before - after).toBeGreaterThan(1.8);
    // Half the slider, about half of that.
    expect(before - (hdrCurve(3, 0.5) - hdrCurve(-3, 0.5))).toBeGreaterThan(0.9);
  });

  it('keeps any highlight under its ceiling at amount 1', () => {
    const ceiling = HDR_TONE.hi + 1 / HDR_TONE.hiK;
    expect(hdrCurve(40, 1)).toBeLessThan(ceiling);
    expect(hdrCurve(400, 1)).toBeLessThan(ceiling);
    expect(hdrCurve(400, 1)).toBeGreaterThan(ceiling - 0.1);
  });

  it('is the same function in the shader', () => {
    for (const v of [HDR_TONE.pivot, HDR_TONE.scale, HDR_TONE.hi, HDR_TONE.hiK, HDR_TONE.lo, HDR_TONE.loK]) expect(HDR_GLSL).toContain(v.toFixed(4));
  });
});

describe('autoHdr', () => {
  it('stays at the minimum for an ordinary range and rises with the range', () => {
    const narrow = autoHdr(spread(-4, 2), { whitePoint: 1.5 });
    const wide = autoHdr(spread(-9, 6), { whitePoint: 1.5 });
    const huge = autoHdr(spread(-12, 9), { whitePoint: 1.5 });
    expect(narrow).toBe(HDR_AUTO_MIN);
    expect(wide).toBeGreaterThan(narrow);
    expect(huge).toBeGreaterThan(wide);
    expect(huge).toBeLessThanOrEqual(100);
  });

  it('brings the brightest 0.5 % to just over white', () => {
    // Centred on Auto's target key, so Auto's exposure is ~0.
    const samples = spread(-6 + Math.log2(0.16 / 0.18), 6 + Math.log2(0.16 / 0.18));
    const amount = autoHdr(samples, { whitePoint: 1.5 });
    const top = samples[Math.round(0.995 * (samples.length - 1))]! - MID;
    const W = Math.log2(1.5 / 0.18);
    expect(hdrCurve(top, amount / 100)).toBeCloseTo(W + 0.6, 1);
  });
});

describe('autoTone with HDR', () => {
  it('matches plain Auto at HDR 0', () => {
    const s = spread(-8, 5);
    expect(autoTone(s, { whitePoint: 1.5, hdr: 0 })).toEqual(autoTone(s, { whitePoint: 1.5 }));
  });

  it('can expose brighter once HDR holds the highlights', () => {
    const s = spread(-11, 6);
    const plain = autoTone(s, { whitePoint: 1.5 });
    const hdr = autoTone(s, { whitePoint: 1.5, hdr: 70 });
    // The bright end is compressed, so more exposure fits before it needs pulling back, and it
    // never needs more pulling back than without HDR.
    expect(hdr.exposure).toBeGreaterThan(plain.exposure);
    expect(Math.abs(hdr.highlights)).toBeLessThanOrEqual(Math.abs(plain.highlights));
  });
});
