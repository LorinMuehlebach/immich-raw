import { describe, expect, it } from 'vitest';
import { crc32 } from './crc32.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('continues over chunks', () => {
    expect(crc32(bytes('6789'), crc32(bytes('12345')))).toBe(0xcbf43926);
  });
});
