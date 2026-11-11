import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha1Base64, sha1Js } from './upload.ts';

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let at = 0; at < n; at += 65536) crypto.getRandomValues(out.subarray(at, Math.min(n, at + 65536)));
  return out;
}

describe('upload checksum (SHA-1)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('matches the SHA-1 test vectors', async () => {
    expect(base64(await sha1Js(new Blob([])))).toBe('2jmj7l5rSw0yVb/vlWAYkK/YBwk=');
    expect(base64(await sha1Js(new Blob(['abc'])))).toBe('qZk+NkcGgWq6PiVxeFDCbJzQ2J0=');
  });

  it('equals WebCrypto on random data, across chunk borders', async () => {
    for (const size of [1, 63, 64, 1000, 300_001]) {
      const blob = new Blob([randomBytes(size)]);
      const expected = await sha1Base64(blob); // WebCrypto
      expect(base64(await sha1Js(blob, 4096))).toBe(expected);
      expect(base64(await sha1Js(blob, 100_000))).toBe(expected);
    }
  });

  it('falls back to the JS hash without WebCrypto (plain HTTP pages)', async () => {
    const blob = new Blob([randomBytes(5_000_000)]);
    const expected = await sha1Base64(blob);
    vi.stubGlobal('crypto', undefined);
    expect(globalThis.crypto).toBeUndefined();
    expect(await sha1Base64(blob)).toBe(expected);
  });
});
