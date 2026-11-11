import { describe, expect, it } from 'vitest';
import { assembleDng, buildDng } from './dng.ts';
import { readDng, imageSegments, tagBytes, tagValue, tagValues } from './reader.ts';
import { TAG } from './tags.ts';
import { buildOpcodeList, parseMapPolynomial, parseOpcodeList } from './opcodes.ts';
import { LOSSY_POLY, lossyCurve, lossyEncodeLut, lossyTileRgba, tileLayout } from './tiles.ts';
import { baseMeta, syntheticLinear } from './test-utils.ts';

/** Stand-in for a JPEG encoder: SOI, SOF0 (8-bit, 3 components), a COM with a checksum of the pixels, EOI. */
function fakeJpeg(rgba: { data: Uint8ClampedArray; width: number; height: number }, sof = 0xc0): Uint8Array {
  let sum = 0;
  for (let i = 0; i < rgba.data.length; i++) sum = (Math.imul(sum, 31) + rgba.data[i]!) | 0;
  const w = rgba.width;
  const h = rgba.height;
  return new Uint8Array([
    0xff, 0xd8,
    0xff, sof, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xfe, 0, 6, (sum >>> 24) & 255, (sum >>> 16) & 255, (sum >>> 8) & 255, sum & 255,
    0xff, 0xd9,
  ]);
}

/**
 * Port of the opcode handling in LibRaw 0.22.1 lossy_dng_load_raw (src/decoders/dng.cpp):
 * seeks to OpcodeList2, reads big-endian, applies only opcode 8 to curve[Plane].
 * LibRaw: Copyright (C) 2008-2026 LibRaw LLC, LGPL-2.1 (see THIRD-PARTY-NOTICES.md).
 */
function librawCurves(list: Uint8Array): (Uint16Array | null)[] {
  const dv = new DataView(list.buffer, list.byteOffset, list.byteLength);
  let p = 0;
  const get4 = () => {
    const v = dv.getUint32(p);
    p += 4;
    return v;
  };
  const cur: (Uint16Array | null)[] = [null, null, null, null];
  let ntags = get4();
  while (ntags--) {
    const opcode = get4();
    get4();
    get4();
    if (opcode !== 8) {
      p += get4();
      continue;
    }
    p += 20;
    const c = get4();
    if (c > 3) break;
    p += 12;
    const deg = get4();
    if (deg > 8) break;
    const coeff: number[] = [];
    for (let i = 0; i <= deg && i < 9; i++) {
      coeff.push(dv.getFloat64(p));
      p += 8;
    }
    const t = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
      let tot = 0;
      for (let j = 0; j <= deg; j++) tot += coeff[j]! * Math.pow(i / 255, j);
      t[i] = Math.trunc(tot * 0xffff);
    }
    cur[c] = t;
  }
  return cur;
}

describe('lossy curve', () => {
  it('is a valid MapPolynomial: f(0) = 0, f(1) = 1, increasing, degree <= 8', () => {
    expect(LOSSY_POLY.length).toBeLessThanOrEqual(9);
    expect(LOSSY_POLY[0]).toBe(0);
    expect(LOSSY_POLY.reduce((a, b) => a + b, 0)).toBe(1);
    expect(lossyCurve(0)).toBe(0);
    expect(lossyCurve(1)).toBe(1);
    for (let i = 1; i <= 1000; i++) expect(lossyCurve(i / 1000)).toBeGreaterThan(lossyCurve((i - 1) / 1000));
    // Shadows: the first code is a few 16-bit steps, and steps stay < 16 % down to -10 EV.
    expect(lossyCurve(1 / 255) * 65535).toBeLessThan(6);
    const lut = lossyEncodeLut();
    for (const ev of [-2, -4, -6, -8, -10]) {
      const v = Math.round(65535 * 2 ** ev);
      const c = lut[v]!;
      const step = (lossyCurve((c + 1) / 255) - lossyCurve(c / 255)) / lossyCurve(c / 255);
      expect(step).toBeLessThan(0.16);
    }
  });

  it('encodes every 16-bit value to the nearest code (in code space), within half a code step', () => {
    const lut = lossyEncodeLut();
    const f = (c: number) => lossyCurve(c / 255) * 65535;
    expect(lut[0]).toBe(0);
    expect(lut[65535]).toBe(255);
    for (let v = 0; v < 65536; v++) {
      const c = lut[v]!;
      if (v > 0) expect(c).toBeGreaterThanOrEqual(lut[v - 1]!);
      const lower = c === 0 ? -Infinity : f(c - 0.5);
      const upper = c === 255 ? Infinity : f(c + 0.5);
      expect(v).toBeGreaterThanOrEqual(lower);
      expect(v).toBeLessThan(upper);
      expect(Math.abs(f(c) - v)).toBeLessThanOrEqual(Math.max(f(c) - lower, upper - f(c)));
    }
  });
});

describe('buildDng (lossy LinearRaw)', () => {
  it('writes a LibRaw/Adobe-compatible LinearRaw IFD with the MapPolynomial curve', async () => {
    const raw = syntheticLinear(700, 300);
    const meta = { ...baseMeta(), defaultCrop: undefined };
    meta.opcodeList1 = buildOpcodeList([{ id: 4, version: 0x01030000, flags: 0, params: new Uint8Array(8) }]);
    meta.opcodeList2 = buildOpcodeList([{ id: 8, version: 0x01030000, flags: 0, params: new Uint8Array(44) }]);
    meta.opcodeList3 = buildOpcodeList([{ id: 3, version: 0x01030000, flags: 1, params: new Uint8Array(56) }]);
    const bytes = await buildDng(meta, raw, { encodeJpeg: async (rgba) => fakeJpeg(rgba) });
    const dng = readDng(bytes);
    const r = dng.raw!;
    expect(tagValue(r, TAG.NewSubFileType)).toBe(0);
    expect(tagValue(r, TAG.Compression)).toBe(34892);
    expect(tagValue(r, TAG.PhotometricInterpretation)).toBe(34892);
    expect(tagValue(r, TAG.SamplesPerPixel)).toBe(3);
    expect(tagValues(r, TAG.BitsPerSample)).toEqual([8, 8, 8]);
    expect(tagValues(r, TAG.WhiteLevel)).toEqual([255, 255, 255]);
    expect(tagValues(r, TAG.BlackLevel)).toEqual([0, 0, 0]);
    expect(r.entries.has(TAG.LinearizationTable)).toBe(false);
    expect(r.entries.has(TAG.CFAPattern)).toBe(false);
    expect(tagValues(r, TAG.DefaultCropSize)).toEqual([700, 300]);
    expect(tagValues(dng.ifd0, TAG.DNGBackwardVersion)).toEqual([1, 4, 0, 0]);

    // Tiles: 256 x 256, each the JPEG of lossyTileRgba(raw, i), in order.
    const layout = tileLayout(700, 300);
    expect([tagValue(r, TAG.TileWidth), tagValue(r, TAG.TileLength)]).toEqual([256, 256]);
    const segs = imageSegments(dng, r);
    expect(segs.length).toBe(layout.count);
    segs.forEach((s, i) => expect(s).toEqual(fakeJpeg(lossyTileRgba(raw, i))));

    // Source lists 1 and 2 are dropped, list 3 is kept.
    expect(r.entries.has(TAG.OpcodeList1)).toBe(false);
    expect(tagBytes(r, TAG.OpcodeList3)).toEqual(meta.opcodeList3);

    // OpcodeList2: exactly three MapPolynomials, one per plane, over the whole image.
    const list = tagBytes(r, TAG.OpcodeList2)!;
    expect(list.length).toBe(4 + 3 * (16 + 36 + 8 * LOSSY_POLY.length));
    const ops = parseOpcodeList(list);
    expect(ops.map((o) => [o.id, o.version, o.flags])).toEqual([
      [8, 0x01030000, 0],
      [8, 0x01030000, 0],
      [8, 0x01030000, 0],
    ]);
    ops.forEach((o, plane) => {
      expect(parseMapPolynomial(o)).toEqual({ top: 0, left: 0, bottom: 300, right: 700, plane, planes: 1, rowPitch: 1, colPitch: 1, coefficients: [...LOSSY_POLY] });
    });

    // What LibRaw makes of it: the same curve for R, G, B; 0 -> 0, 255 -> 65535, increasing.
    const cur = librawCurves(list);
    expect(cur[3]).toBeNull();
    for (let c = 0; c < 3; c++) {
      const t = cur[c]!;
      expect(t[0]).toBe(0);
      expect(t[255]).toBe(65535);
      for (let i = 0; i < 256; i++) {
        expect(Math.abs(t[i]! - lossyCurve(i / 255) * 65535)).toBeLessThan(1);
        if (i) expect(t[i]!).toBeGreaterThan(t[i - 1]!);
      }
    }
  });

  it('pads edge tiles and maps values through the curve', () => {
    const raw = syntheticLinear(300, 270);
    const lut = lossyEncodeLut();
    const t = lossyTileRgba(raw, 3); // bottom-right tile: 44 x 14 inside, rest padded
    expect([t.width, t.height, t.data.length]).toEqual([256, 256, 256 * 256 * 4]);
    const px = (x: number, y: number) => Array.from(t.data.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4));
    const src = (x: number, y: number) => [0, 1, 2].map((c) => lut[raw.data[(y * 300 + x) * 3 + c]!]!).concat(255);
    expect(px(0, 0)).toEqual(src(256, 256));
    expect(px(43, 13)).toEqual(src(299, 269));
    expect(px(200, 13)).toEqual(src(299, 269));
    expect(px(10, 250)).toEqual(src(266, 269));
    expect(px(255, 255)).toEqual(src(299, 269));
  });

  it('rejects tiles DNG readers cannot take', () => {
    const raw = { kind: 'linear' as const, width: 300, height: 200 };
    const meta = { ...baseMeta(), defaultCrop: undefined };
    const rgba = { data: new Uint8ClampedArray(256 * 200 * 4), width: 256, height: 200 };
    const good = fakeJpeg(rgba);
    expect(() => assembleDng(meta, raw, [good, good])).not.toThrow();
    expect(() => assembleDng(meta, raw, [good, fakeJpeg(rgba, 0xc2)])).toThrow(/baseline/);
    expect(() => assembleDng(meta, raw, [good, fakeJpeg({ ...rgba, width: 128 })])).toThrow(/expected 256x200/);
    return expect(buildDng(meta, { ...raw, data: new Uint16Array(300 * 200 * 3) })).rejects.toThrow(/encodeJpeg/);
  });
});
