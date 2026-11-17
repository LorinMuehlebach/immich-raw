import { describe, expect, it } from 'vitest';
import { assembleDng, buildDng, jpegFrameInfo } from './dng.ts';
import { decodeRawImage, imageSegments, readDng, tagValue, tagValues } from './reader.ts';
import { TAG } from './tags.ts';
import { buildOpcodeList } from './opcodes.ts';
import { encodeCfaTile, encodeLinearTile, tileLayout } from './tiles.ts';
import { baseMeta, rng } from './test-utils.ts';
import type { LinearRaw } from './types.ts';

/** Full 16-bit range with noise, so every bit has to survive. */
function wideLinear(width: number, height: number): LinearRaw {
  const r = rng(7);
  const data = new Uint16Array(width * height * 3);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(r() * 65536);
  return { kind: 'linear', encoding: 'lossless', width, height, data };
}

describe('buildDng (lossless 16-bit LinearRaw)', () => {
  it('writes 3-component lossless JPEG tiles that decode to the exact values', async () => {
    const raw = wideLinear(300, 270);
    const meta = { ...baseMeta(), defaultCrop: undefined };
    // A copied list 2 would describe a mosaic we don't have: it must not be written.
    meta.opcodeList2 = buildOpcodeList([{ id: 8, version: 0x01030000, flags: 0, params: new Uint8Array(44) }]);
    const bytes = await buildDng(meta, raw);
    const dng = readDng(bytes);
    const r = dng.raw!;
    expect(tagValue(r, TAG.Compression)).toBe(7);
    expect(tagValue(r, TAG.PhotometricInterpretation)).toBe(34892);
    expect(tagValue(r, TAG.SamplesPerPixel)).toBe(3);
    expect(tagValues(r, TAG.BitsPerSample)).toEqual([16, 16, 16]);
    expect(tagValues(r, TAG.WhiteLevel)).toEqual([65535, 65535, 65535]);
    expect(tagValues(r, TAG.BlackLevel)).toEqual([0, 0, 0]);
    expect(r.entries.has(TAG.OpcodeList2)).toBe(false);
    expect(r.entries.has(TAG.CFAPattern)).toBe(false);

    const segs = imageSegments(dng, r);
    expect(segs.length).toBe(tileLayout(300, 270).count);
    const f = jpegFrameInfo(segs[0]!);
    expect([f.marker, f.precision, f.components.length, f.width, f.height]).toEqual([0xffc3, 16, 3, 256, 256]);

    const back = decodeRawImage(dng);
    expect(back.samplesPerPixel).toBe(3);
    expect(back.data).toEqual(raw.data);
  });

  it('takes only 16-bit, 3-component lossless tiles', () => {
    const raw = wideLinear(40, 30);
    const { data: _data, ...shape } = raw;
    const meta = { ...baseMeta(), defaultCrop: undefined };
    expect(() => assembleDng(meta, shape, [encodeLinearTile(raw, 0)])).not.toThrow();
    // A CFA tile (1 component) of the same size is refused.
    const mosaic = { kind: 'cfa' as const, width: 40, height: 30, data: new Uint16Array(1200), patternWidth: 2, patternHeight: 2, pattern: [0, 1, 1, 2] };
    expect(() => assembleDng(meta, shape, [encodeCfaTile(mosaic, 0)])).toThrow(/3-component lossless/);
  });
});
