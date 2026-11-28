import { describe, expect, it } from 'vitest';
import { packPixels, shuffle, unpackPixels, unshuffle } from './pixel-pack.ts';

describe('pixel-pack', () => {
  it('puts the low bytes first, then the high bytes', () => {
    expect(Array.from(shuffle(new Uint16Array([0x0102, 0x0304])))).toEqual([0x02, 0x04, 0x01, 0x03]);
    expect(Array.from(unshuffle(new Uint8Array([0x02, 0x04, 0x01, 0x03])))).toEqual([0x0102, 0x0304]);
  });

  it('gets the pixels back unchanged', async () => {
    const values = Uint16Array.from({ length: 30_000 }, (_, i) => (i * 7919 + (i >> 3) * 13) & 0xffff);
    const packed = await packPixels(values);
    expect(Array.from(await unpackPixels(packed as Uint8Array<ArrayBuffer>, values.length))).toEqual(Array.from(values));
  });

  it('shrinks smooth 16-bit data', async () => {
    // A gradient with noise in the low bits, like a linear photo.
    const values = Uint16Array.from({ length: 60_000 }, (_, i) => ((i / 60) * 40 + ((i * 2654435761) >>> 28)) & 0xffff);
    const packed = await packPixels(values);
    expect(packed.length).toBeLessThan(values.byteLength / 1.5);
  });

  it('refuses data for another number of pixels', async () => {
    const packed = await packPixels(new Uint16Array(100));
    await expect(unpackPixels(packed as Uint8Array<ArrayBuffer>, 99)).rejects.toThrow('wrong size');
  });
});
