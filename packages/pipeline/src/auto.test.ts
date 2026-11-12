import { PARAMS } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_PARAMS, autoTone, normalizeAutoParams } from './auto.ts';
import { profileWhitePoint } from './color/profiles.ts';

const MID = Math.log2(0.18);
const TARGET = Math.log2(0.16);
const opts = { whitePoint: profileWhitePoint('color') };

/** n log2 luminance samples spread evenly from a to b. */
const spread = (a: number, b: number, n = 2000) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

describe('autoTone', () => {
  it('leaves a well exposed image about where it is', () => {
    const r = autoTone(spread(TARGET - 3, TARGET + 3), opts);
    expect(Math.abs(r.exposure)).toBeLessThan(0.1);
    expect(Math.abs(r.shadows)).toBeLessThan(15);
  });

  it('brightens an underexposed image by the missing stops', () => {
    const r = autoTone(spread(TARGET - 5, TARGET + 1), opts);
    expect(r.exposure).toBeCloseTo(2, 1);
  });

  it('darkens an overexposed image', () => {
    const r = autoTone(spread(TARGET - 1.5, TARGET + 2.5), opts);
    expect(r.exposure).toBeLessThan(-0.3);
  });

  it('recovers highlights and opens shadows in a high-contrast scene', () => {
    const r = autoTone([...spread(MID - 6, MID - 4, 1000), ...spread(MID + 2.5, MID + 4, 1000)], opts);
    expect(r.highlights).toBeLessThan(-10);
    expect(r.shadows).toBeGreaterThan(10);
    expect(r.contrast).toBeLessThanOrEqual(0);
  });

  it('adds contrast to a flat image, and leaves Whites/Blacks where they would not reach', () => {
    const r = autoTone(spread(TARGET - 1, TARGET + 1), opts);
    expect(r.contrast).toBeGreaterThan(10);
    expect(r.blacks).toBe(0);
    expect(r.whites).toBe(0);
  });

  it('sets a black point for deep shadows and eases off crushed ones', () => {
    const deep = autoTone([...spread(MID - 6, MID - 5.6, 50), ...spread(TARGET - 3, TARGET + 2.5, 1950)], opts);
    expect(deep.blacks).toBeLessThan(0);
    const crushed = autoTone([...spread(MID - 13, MID - 11, 300), ...spread(TARGET - 2, TARGET + 3, 1700)], opts);
    expect(crushed.blacks).toBeGreaterThan(0);
  });

  it('lifts a dull top end with Whites and holds clipped whites back', () => {
    const dull = autoTone(spread(TARGET - 3, TARGET + 1.3), opts);
    expect(dull.whites).toBeGreaterThan(0);
    const clipped = autoTone([...spread(TARGET - 3, TARGET + 2, 1980), ...spread(MID + 6, MID + 7, 20)], opts);
    expect(clipped.whites).toBeLessThan(0);
  });

  it('does not push bright highlights far past what Highlights can recover', () => {
    // Mostly dark, with a bright window: exposure is held back.
    const r = autoTone([...spread(MID - 7, MID - 5, 1900), ...spread(MID + 1, MID + 2, 100)], opts);
    expect(r.exposure).toBeLessThan(3.4);
  });

  it('stays inside the slider ranges and returns whole numbers', () => {
    for (const s of [spread(MID - 12, MID - 10), spread(MID + 4, MID + 6), spread(MID - 9, MID + 6)]) {
      const r = autoTone(s, opts);
      for (const k of ['contrast', 'highlights', 'shadows', 'whites', 'blacks'] as const) {
        expect(Number.isInteger(r[k])).toBe(true);
        expect(r[k]).toBeGreaterThanOrEqual(PARAMS[k].min);
        expect(r[k]).toBeLessThanOrEqual(PARAMS[k].max);
      }
      expect(Math.abs(r.exposure)).toBeLessThanOrEqual(4);
    }
  });

  it('follows the brightness setting', () => {
    const base = autoTone(spread(TARGET - 5, TARGET + 1), opts);
    const brighter = autoTone(spread(TARGET - 5, TARGET + 1), { ...opts, params: { brightness: 0.5 } });
    const darker = autoTone(spread(TARGET - 5, TARGET + 1), { ...opts, params: { brightness: -1 } });
    expect(brighter.exposure - base.exposure).toBeCloseTo(0.5, 1);
    expect(darker.exposure - base.exposure).toBeCloseTo(-1, 1);
  });

  it('holds exposure back further with less highlight headroom', () => {
    const scene = [...spread(MID - 7, MID - 5, 1900), ...spread(MID + 1, MID + 2, 100)];
    const loose = autoTone(scene, { ...opts, params: { headroom: 2 } });
    const tight = autoTone(scene, { ...opts, params: { headroom: 0 } });
    expect(tight.exposure).toBeLessThan(loose.exposure - 1);
  });

  it('scales Highlights, Shadows and Whites/Blacks by their strength settings', () => {
    const scene = [...spread(MID - 6, MID - 4, 1000), ...spread(MID + 2.5, MID + 4, 1000)];
    const base = autoTone(scene, opts);
    const off = autoTone(scene, { ...opts, params: { highlights: 0, shadows: 0, whitesBlacks: 0 } });
    expect(off.highlights).toBe(0);
    expect(off.shadows).toBe(0);
    expect(off.whites).toBe(0);
    expect(off.blacks).toBe(0);
    const strong = autoTone(scene, { ...opts, params: { highlights: 200, shadows: 200 } });
    expect(Math.abs(strong.highlights)).toBeGreaterThanOrEqual(Math.min(100, Math.abs(base.highlights) * 1.8));
    expect(strong.shadows).toBeGreaterThanOrEqual(Math.min(100, base.shadows * 1.8));
    expect(strong.shadows).toBeLessThanOrEqual(100);
  });

  it('adds the contrast setting to what Auto picks', () => {
    const base = autoTone(spread(TARGET - 3, TARGET + 3), opts);
    const punchy = autoTone(spread(TARGET - 3, TARGET + 3), { ...opts, params: { contrast: 20 } });
    expect(punchy.contrast - base.contrast).toBe(20);
  });

  it('cleans up stored settings', () => {
    expect(normalizeAutoParams(null)).toEqual(DEFAULT_AUTO_PARAMS);
    expect(normalizeAutoParams({ brightness: 9, shadows: 'x', contrast: -10 })).toEqual({ ...DEFAULT_AUTO_PARAMS, brightness: 1.5, contrast: -10 });
  });

  it('ignores invalid samples and returns zeros without data', () => {
    expect(autoTone([], opts)).toEqual({ exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 });
    const r = autoTone([...spread(TARGET - 3, TARGET + 3), NaN, Infinity, -Infinity], opts);
    expect(Math.abs(r.exposure)).toBeLessThan(0.1);
  });
});
