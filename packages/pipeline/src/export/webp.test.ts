import { describe, expect, it } from 'vitest';
import { addWebpMetadata } from './webp.ts';

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function riff(chunks: [string, Uint8Array][]): Uint8Array {
  const body = chunks.reduce((s, [, d]) => s + 8 + d.length + (d.length & 1), 0);
  const out = new Uint8Array(12 + body);
  const dv = new DataView(out.buffer);
  out.set(ascii('RIFF'));
  dv.setUint32(4, 4 + body, true);
  out.set(ascii('WEBP'), 8);
  let p = 12;
  for (const [type, d] of chunks) {
    out.set(ascii(type), p);
    dv.setUint32(p + 4, d.length, true);
    out.set(d, p + 8);
    p += 8 + d.length + (d.length & 1);
  }
  return out;
}

function chunksOf(webp: Uint8Array): { type: string; data: Uint8Array; at: number }[] {
  const dv = new DataView(webp.buffer, webp.byteOffset, webp.byteLength);
  expect(String.fromCharCode(...webp.subarray(0, 4))).toBe('RIFF');
  expect(dv.getUint32(4, true)).toBe(webp.length - 8);
  const out = [];
  let p = 12;
  while (p < webp.length) {
    const size = dv.getUint32(p + 4, true);
    out.push({ type: String.fromCharCode(...webp.subarray(p, p + 4)), data: webp.subarray(p + 8, p + 8 + size), at: p });
    p += 8 + size + (size & 1);
  }
  expect(p).toBe(webp.length);
  return out;
}

/** A lossy key frame header for width x height, padded to an odd length. */
function vp8(width: number, height: number): Uint8Array {
  return Uint8Array.from([0x50, 0x02, 0x00, 0x9d, 0x01, 0x2a, width & 0xff, width >> 8, height & 0xff, height >> 8, 0x11]);
}

function vp8l(width: number, height: number, alpha: boolean): Uint8Array {
  const bits = (width - 1) | ((height - 1) << 14) | ((alpha ? 1 : 0) << 28);
  return Uint8Array.from([0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0]);
}

const vp8xOf = (webp: Uint8Array) => {
  const d = chunksOf(webp)[0]!.data;
  return { flags: d[0]!, width: 1 + (d[4]! | (d[5]! << 8) | (d[6]! << 16)), height: 1 + (d[7]! | (d[8]! << 8) | (d[9]! << 16)) };
};

describe('addWebpMetadata', () => {
  const icc = Uint8Array.from({ length: 33 }, (_, i) => i);
  const exif = ascii('II*\0exif');
  const xmp = '<x:xmpmeta/>';

  it('turns a simple lossy WebP into the extended format, chunks in the spec order', () => {
    const image = vp8(6000, 4000);
    const out = addWebpMetadata(riff([['VP8 ', image]]), { icc, exif, xmp });
    expect(chunksOf(out).map((c) => c.type)).toEqual(['VP8X', 'ICCP', 'VP8 ', 'EXIF', 'XMP ']);
    expect(vp8xOf(out)).toEqual({ flags: 0x20 | 0x08 | 0x04, width: 6000, height: 4000 });
    const c = chunksOf(out);
    expect([...c[1]!.data]).toEqual([...icc]);
    expect([...c[2]!.data]).toEqual([...image]);
    expect(new TextDecoder().decode(c[4]!.data)).toBe(xmp);
    // Odd-sized chunks are padded, so every chunk starts at an even offset.
    for (const ch of c) expect(ch.at % 2).toBe(0);
  });

  it('reads the size and alpha of a lossless WebP', () => {
    const out = addWebpMetadata(riff([['VP8L', vp8l(16383, 1, true)]]), { exif });
    expect(vp8xOf(out)).toEqual({ flags: 0x10 | 0x08, width: 16383, height: 1 });
    expect(vp8xOf(addWebpMetadata(riff([['VP8L', vp8l(10, 20, false)]]), { exif })).flags).toBe(0x08);
  });

  it('replaces earlier metadata and keeps the alpha chunk with the image', () => {
    const first = addWebpMetadata(riff([['ALPH', Uint8Array.of(1, 2)], ['VP8 ', vp8(100, 50)]]), { exif, xmp });
    const again = addWebpMetadata(first, { icc });
    expect(chunksOf(again).map((c) => c.type)).toEqual(['VP8X', 'ICCP', 'ALPH', 'VP8 ']);
    expect(vp8xOf(again)).toEqual({ flags: 0x20 | 0x10, width: 100, height: 50 });
  });

  it('returns the input when there is nothing to add', () => {
    const plain = riff([['VP8 ', vp8(10, 10)]]);
    expect(addWebpMetadata(plain, {})).toBe(plain);
    expect(addWebpMetadata(plain, { xmp: '' })).toBe(plain);
  });

  it('rejects files that are not WebP', () => {
    expect(() => addWebpMetadata(ascii('RIFF\0\0\0\0WAVE'), { exif })).toThrow(/Not a WebP/);
    expect(() => addWebpMetadata(riff([['VP8 ', Uint8Array.of(0, 0, 0, 1, 2, 3, 0, 0, 0, 0)]]), { exif })).toThrow(/start code/);
  });
});
