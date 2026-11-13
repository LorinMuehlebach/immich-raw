import { describe, expect, it } from 'vitest';
import type { LinearImage, RawMeta } from '@immich-raw/decoder';
import { decodedParts, parseDecoded } from './decoded-cache.ts';

const meta: RawMeta = {
  width: 6,
  height: 4,
  flip: 6,
  camMul: [2.1, 1, 1.6, 1],
  preMul: [2, 1, 1.5, 1],
  rgbCam: [
    [1.7, -0.6, -0.1, 0],
    [-0.2, 1.5, -0.3, 0],
    [0, -0.5, 1.5, 0],
  ],
  camXyz: [
    [0.7, -0.2, -0.05],
    [-0.4, 1.1, 0.3],
    [-0.08, 0.2, 0.6],
    [0, 0, 0],
  ],
  black: 512,
  maximum: 16383,
  baselineExposure: 0,
  isXTrans: false,
  make: 'Sony',
  model: 'ILCE-7RM5',
  lens: 'FE 35mm F1.4 GM',
  iso: 100,
  shutter: 1 / 250,
  aperture: 2.8,
  focalLength: 35,
};

const half = (): LinearImage => ({ width: 3, height: 2, data: Uint16Array.from({ length: 18 }, (_, i) => i * 3000), halfSize: true });

const blobOf = (parts: ArrayBufferView<ArrayBuffer>[]) => new Blob(parts);

describe('decoded-cache file', () => {
  it('reads back the metadata and the pixels', async () => {
    const parts = decodedParts(meta, half())!;
    const photo = await parseDecoded(blobOf(parts));
    expect(photo?.meta).toEqual(meta);
    expect(photo?.half.width).toBe(3);
    expect(photo?.half.height).toBe(2);
    expect(photo?.half.halfSize).toBe(true);
    expect(Array.from(photo!.half.data)).toEqual(Array.from(half().data));
    // The pixels have a buffer of their own, like a decoded image's.
    expect(photo!.half.data.byteOffset).toBe(0);
    expect(photo!.half.data.buffer.byteLength).toBe(18 * 2);
  });

  it('starts the pixels at a multiple of 8 bytes', () => {
    const [head] = decodedParts(meta, half())!;
    expect(head!.byteLength % 8).toBe(0);
  });

  it("doesn't keep metadata that JSON would change", () => {
    expect(decodedParts({ ...meta, aperture: NaN }, half())).toBeNull();
    expect(decodedParts({ ...meta, shutter: Infinity }, half())).toBeNull();
  });

  it('keeps half-size images only, never a full-resolution one', () => {
    const full: LinearImage = { width: 6, height: 4, data: new Uint16Array(6 * 4 * 3), halfSize: false };
    expect(decodedParts(meta, full)).toBeNull();
    expect(decodedParts(meta, { ...full, halfSize: true })).toBeNull();
  });

  it("doesn't keep an image whose pixels don't match its size", () => {
    expect(decodedParts(meta, { ...half(), width: 4 })).toBeNull();
  });

  it('ignores a file from another decoder or format', async () => {
    const [head, data] = decodedParts(meta, half())!;
    const length = new DataView(head!.buffer).getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(head!.buffer, 8, length)));
    for (const change of [{ decoder: 'libraw-wasm 0.0.1 0.21' }, { format: 99 }]) {
      const text = new TextEncoder().encode(JSON.stringify({ ...header, ...change }));
      const other = new Uint8Array(Math.ceil((8 + text.length) / 8) * 8);
      new DataView(other.buffer).setUint32(0, 0x31485249, true);
      new DataView(other.buffer).setUint32(4, text.length, true);
      other.set(text, 8);
      expect(await parseDecoded(blobOf([other, data!]))).toBeNull();
    }
  });

  it('ignores a damaged or cut-off file', async () => {
    const [head, data] = decodedParts(meta, half())!;
    expect(await parseDecoded(new Blob([head!]))).toBeNull();
    expect(await parseDecoded(new Blob([head!, new Uint8Array(data!.buffer, 0, 20)]))).toBeNull();
    expect(await parseDecoded(new Blob([new Uint8Array(4)]))).toBeNull();
    const bad = new Uint8Array(head!.buffer.slice(0));
    bad[0] = 0;
    expect(await parseDecoded(new Blob([bad, data!]))).toBeNull();
  });
});
