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
  it('leaves everything alone at amount 0 and the midtones at any amount', () => {
    for (const x of [-12, -3, 0, 2, 8]) expect(hdrCurve(x, 0)).toBe(x);
    for (const x of [HDR_TONE.lo, -1, 0, HDR_TONE.hi]) expect(hdrCurve(x, 1)).toBeCloseTo(x, 12);
  });

  it('is increasing, continuous with slope 1 at the knees, and pulls both ends in', () => {
    for (const a of [0.2, 0.6, 1]) {
      let prev = -Infinity;
      for (let x = -14; x <= 10; x += 0.01) {
        const y = hdrCurve(x, a);
        expect(y).toBeGreaterThan(prev);
        prev = y;
      }
      for (const k of [HDR_TONE.hi, HDR_TONE.lo]) {
        const slope = (hdrCurve(k + 1e-4, a) - hdrCurve(k - 1e-4, a)) / 2e-4;
        expect(slope).toBeCloseTo(1, 3);
      }
      expect(hdrCurve(6, a)).toBeLessThan(6);
      expect(hdrCurve(-10, a)).toBeGreaterThan(-10);
    }
    // More amount, more compression.
    expect(hdrCurve(6, 1)).toBeLessThan(hdrCurve(6, 0.5));
    expect(hdrCurve(-10, 1)).toBeGreaterThan(hdrCurve(-10, 0.5));
  });

  it('keeps any highlight under its ceiling at amount 1', () => {
    const ceiling = HDR_TONE.hi + 1 / HDR_TONE.hiK;
    expect(hdrCurve(40, 1)).toBeLessThan(ceiling);
    expect(hdrCurve(400, 1)).toBeLessThan(ceiling);
    expect(hdrCurve(400, 1)).toBeGreaterThan(ceiling - 0.05);
  });

  it('is the same function in the shader', () => {
    expect(HDR_GLSL).toContain(`if (x > ${HDR_TONE.hi.toFixed(4)})`);
    expect(HDR_GLSL).toContain(`${HDR_TONE.hiK.toFixed(4)} * h * d`);
    expect(HDR_GLSL).toContain(`if (x < ${HDR_TONE.lo.toFixed(4)})`);
    expect(HDR_GLSL).toContain(`${HDR_TONE.loK.toFixed(4)} * h * d`);
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

  it('needs less Highlights once HDR has compressed the range', () => {
    const s = spread(-11, 6);
    const plain = autoTone(s, { whitePoint: 1.5 });
    const hdr = autoTone(s, { whitePoint: 1.5, hdr: 70 });
    expect(Math.abs(hdr.highlights)).toBeLessThan(Math.abs(plain.highlights));
    // The bright end can go higher before it needs pulling back, so exposure doesn't drop as far.
    expect(hdr.exposure).toBeGreaterThanOrEqual(plain.exposure);
  });
});
