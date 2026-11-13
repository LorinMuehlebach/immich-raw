import { describe, expect, it } from 'vitest';
import { canPrefetch, decodedBytesGuess } from './prefetch.ts';

const nav = (extra: Record<string, unknown> = {}) => ({ storage: { getDirectory: () => Promise.resolve() }, ...extra }) as unknown as Navigator;

describe('canPrefetch', () => {
  it('prefetches on a secure page with storage', () => {
    expect(canPrefetch(nav(), true)).toBe(true);
    expect(canPrefetch(nav({ deviceMemory: 8, connection: { type: 'wifi' } }), true)).toBe(true);
  });

  it('needs the caches', () => {
    expect(canPrefetch(nav(), false)).toBe(false);
    expect(canPrefetch({} as Navigator, true)).toBe(false);
  });

  it("spares a phone's data and memory", () => {
    expect(canPrefetch(nav({ connection: { saveData: true } }), true)).toBe(false);
    expect(canPrefetch(nav({ connection: { type: 'cellular' } }), true)).toBe(false);
    expect(canPrefetch(nav({ deviceMemory: 2 }), true)).toBe(false);
  });
});

describe('decodedBytesGuess', () => {
  it('counts a quarter of the pixels at 6 bytes each', () => {
    expect(decodedBytesGuess(8192, 5464, 41e6)).toBe(8192 * 5464 * 1.5);
  });

  it('guesses from the file size without the sensor size', () => {
    expect(decodedBytesGuess(null, undefined, 40e6)).toBe(68e6);
    expect(decodedBytesGuess(160, 120, 40e6)).toBe(68e6);
  });
});
