import { describe, expect, it } from 'vitest';
import { assembleDng, buildDng } from './dng.ts';
import { decodeRawImage, readDng, tagBytes, tagText, tagValue, tagValues, type DngIfd, type ParsedDng } from './reader.ts';
import { EXIF_TAG, GPS_TAG, TAG } from './tags.ts';
import { ASCII, BYTE, LONG, RATIONAL, SHORT, SRATIONAL, UNDEFINED } from './tiff.ts';
import { buildOpcodeList, parseOpcodeList } from './opcodes.ts';
import { encodeCfaTile, encodeCfaTileWith, tileLayout } from './tiles.ts';
import { XTRANS, baseMeta, syntheticCfa } from './test-utils.ts';
import type { CfaRaw, DngMetadata } from './types.ts';

const type = (ifd: DngIfd | null | undefined, tag: number) => ifd?.entries.get(tag)?.type;
const close = (a: number[] | undefined, b: number[], eps = 1e-6) => {
  expect(a).toBeDefined();
  expect(a!.length).toBe(b.length);
  a!.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThanOrEqual(eps));
};

/** Every IFD sorted by tag, every value offset even and inside the file. */
function checkStructure(dng: ParsedDng): void {
  const visit = (ifd: DngIfd) => {
    expect(ifd.offset % 2).toBe(0);
    const tags = [...ifd.entries.keys()];
    expect(tags).toEqual([...tags].sort((a, b) => a - b));
    for (const e of ifd.entries.values()) {
      if (e.bytes.length > 4) expect(e.valueOffset % 2).toBe(0);
      expect(e.valueOffset + e.bytes.length).toBeLessThanOrEqual(dng.bytes.length);
    }
    ifd.subIfds.forEach(visit);
    if (ifd.exif) visit(ifd.exif);
    if (ifd.gps) visit(ifd.gps);
  };
  dng.chain.forEach(visit);
}

// Opcode lists as a source DNG would have them: a required GainMap-sized blob in list 1, a
// required opcode in list 2 and an optional WarpRectilinear2 (DNG 1.6) in list 3.
const op = (id: number, version: number, flags: number, size: number) => ({ id, version, flags, params: new Uint8Array(size).map((_, i) => (i * 37 + id) & 255) });
const list1 = buildOpcodeList([op(4, 0x01030000, 0, 8)]);
const list2 = buildOpcodeList([op(9, 0x01030000, 0, 120), op(3, 0x01030000, 1, 56)]);
const list3 = buildOpcodeList([op(14, 0x01060000, 1, 140), op(1, 0x01030000, 0, 76)]);

function checkCommon(dng: ParsedDng, meta: DngMetadata): void {
  const ifd0 = dng.ifd0;
  expect(dng.littleEndian).toBe(true);
  expect(Array.from(dng.bytes.subarray(0, 4))).toEqual([0x49, 0x49, 42, 0]);
  expect(tagValue(ifd0, TAG.NewSubFileType)).toBe(1);
  expect(tagValues(ifd0, TAG.BitsPerSample)).toEqual([8, 8, 8]);
  expect(tagValue(ifd0, TAG.PhotometricInterpretation)).toBe(2);
  expect(tagValue(ifd0, TAG.Compression)).toBe(1);
  expect(tagText(ifd0, TAG.Make)).toBe(meta.make);
  expect(tagText(ifd0, TAG.Model)).toBe(meta.model);
  expect(tagText(ifd0, TAG.UniqueCameraModel)).toBe(meta.uniqueCameraModel);
  expect(tagText(ifd0, TAG.Software)).toBe(meta.software);
  expect(tagText(ifd0, TAG.DateTime)).toBe(meta.dateTime);
  expect(tagValue(ifd0, TAG.Orientation)).toBe(meta.orientation);
  expect(type(ifd0, TAG.Orientation)).toBe(SHORT);
  expect(type(ifd0, TAG.DNGVersion)).toBe(BYTE);
  for (const [tag, m] of [
    [TAG.ColorMatrix1, meta.colorMatrix1],
    [TAG.ColorMatrix2, meta.colorMatrix2!],
    [TAG.ForwardMatrix1, meta.forwardMatrix1!],
    [TAG.ForwardMatrix2, meta.forwardMatrix2!],
  ] as const) {
    expect(type(ifd0, tag)).toBe(SRATIONAL);
    close(tagValues(ifd0, tag), m, 1e-7);
  }
  // Short decimal fractions come back as such.
  expect(ifd0.entries.get(TAG.ColorMatrix2)!.rationals![0]).toEqual([6722, 10000]);
  expect(ifd0.entries.get(TAG.AsShotNeutral)!.rationals![0]).toEqual([4876, 10000]);
  expect(tagValues(ifd0, TAG.CalibrationIlluminant1)).toEqual([meta.calibrationIlluminant1]);
  expect(tagValues(ifd0, TAG.CalibrationIlluminant2)).toEqual([meta.calibrationIlluminant2]);
  expect(type(ifd0, TAG.AsShotNeutral)).toBe(RATIONAL);
  close(tagValues(ifd0, TAG.AsShotNeutral), meta.asShotNeutral, 1e-7);
  expect(type(ifd0, TAG.BaselineExposure)).toBe(SRATIONAL);
  close(tagValues(ifd0, TAG.BaselineExposure), [meta.baselineExposure!]);
  expect(tagText(ifd0, TAG.OriginalRawFileName)).toBe(meta.originalRawFileName);
  expect(type(ifd0, TAG.OriginalRawFileName)).toBe(BYTE); // UTF-8 name
  expect(type(ifd0, TAG.XMP)).toBe(BYTE);
  expect(new TextDecoder().decode(tagBytes(ifd0, TAG.XMP))).toBe(meta.xmp);

  // Thumbnail.
  const t = meta.thumbnail!;
  expect([tagValue(ifd0, TAG.ImageWidth), tagValue(ifd0, TAG.ImageLength)]).toEqual([t.width, t.height]);
  const off = tagValue(ifd0, TAG.StripOffsets)!;
  expect(tagValue(ifd0, TAG.StripByteCounts)).toBe(t.rgb.length);
  expect(dng.bytes.subarray(off, off + t.rgb.length)).toEqual(t.rgb);

  // Preview.
  expect(dng.ifd0.subIfds.length).toBe(2);
  const pv = dng.ifd0.subIfds[1]!;
  expect(dng.previews).toEqual([pv]);
  expect(tagValue(pv, TAG.NewSubFileType)).toBe(1);
  expect(tagValue(pv, TAG.Compression)).toBe(7);
  expect(tagValue(pv, TAG.PhotometricInterpretation)).toBe(6);
  expect(tagValues(pv, TAG.BitsPerSample)).toEqual([8, 8, 8]);
  expect(tagValues(pv, TAG.YCbCrSubSampling)).toEqual([2, 2]);
  expect(tagValue(pv, TAG.PreviewColorSpace)).toBe(2);
  const po = tagValue(pv, TAG.StripOffsets)!;
  expect(dng.bytes.subarray(po, po + meta.preview!.jpeg.length)).toEqual(meta.preview!.jpeg);

  // EXIF.
  const ex = dng.exif!;
  const e = meta.exif!;
  expect(ex.entries.get(EXIF_TAG.ExposureTime)!.rationals![0]).toEqual([1, 250]);
  expect(tagValue(ex, EXIF_TAG.FNumber)).toBeCloseTo(2.8, 9);
  expect(tagValue(ex, EXIF_TAG.ISOSpeedRatings)).toBe(400);
  expect(type(ex, EXIF_TAG.ISOSpeedRatings)).toBe(SHORT);
  expect(type(ex, EXIF_TAG.ExifVersion)).toBe(UNDEFINED);
  expect(new TextDecoder().decode(tagBytes(ex, EXIF_TAG.ExifVersion))).toBe('0231');
  expect(tagText(ex, EXIF_TAG.DateTimeOriginal)).toBe(e.dateTimeOriginal);
  expect(type(ex, EXIF_TAG.DateTimeOriginal)).toBe(ASCII);
  expect(tagText(ex, EXIF_TAG.OffsetTimeOriginal)).toBe(e.offsetTimeOriginal);
  expect(tagText(ex, EXIF_TAG.SubSecTimeOriginal)).toBe(e.subSecTimeOriginal);
  expect(ex.entries.get(EXIF_TAG.ExposureBiasValue)!.rationals![0]).toEqual([-1, 3]);
  expect(tagValue(ex, EXIF_TAG.FocalLength)).toBe(35);
  expect(tagValue(ex, EXIF_TAG.FocalLengthIn35mmFilm)).toBe(35);
  expect(tagText(ex, EXIF_TAG.LensMake)).toBe(e.lensMake);
  expect(tagText(ex, EXIF_TAG.LensModel)).toBe(e.lensModel);
  expect(tagText(ex, EXIF_TAG.BodySerialNumber)).toBe(e.bodySerialNumber);

  // GPS.
  const g = dng.gps!;
  const deg = (v: number[]) => v[0]! + v[1]! / 60 + v[2]! / 3600;
  expect(tagValues(g, GPS_TAG.GPSVersionID)).toEqual([2, 3, 0, 0]);
  expect(tagText(g, GPS_TAG.GPSLatitudeRef)).toBe('N');
  expect(tagText(g, GPS_TAG.GPSLongitudeRef)).toBe('W');
  expect(deg(tagValues(g, GPS_TAG.GPSLatitude)!)).toBeCloseTo(meta.gps!.latitude, 7);
  expect(deg(tagValues(g, GPS_TAG.GPSLongitude)!)).toBeCloseTo(-meta.gps!.longitude, 7);
  expect(tagValues(g, GPS_TAG.GPSAltitudeRef)).toEqual([1]);
  expect(tagValue(g, GPS_TAG.GPSAltitude)).toBeCloseTo(12.5, 6);
}

function checkCfa(dng: ParsedDng, raw: CfaRaw, meta: DngMetadata): void {
  const r = dng.raw!;
  expect(dng.ifd0.subIfds[0]).toBe(r);
  expect(tagValue(r, TAG.NewSubFileType)).toBe(0);
  expect([tagValue(r, TAG.ImageWidth), tagValue(r, TAG.ImageLength)]).toEqual([raw.width, raw.height]);
  expect(tagValues(r, TAG.BitsPerSample)).toEqual([16]);
  expect(tagValue(r, TAG.Compression)).toBe(7);
  expect(tagValue(r, TAG.PhotometricInterpretation)).toBe(32803);
  expect(tagValue(r, TAG.SamplesPerPixel)).toBe(1);
  expect(tagValue(r, TAG.PlanarConfiguration)).toBe(1);
  const layout = tileLayout(raw.width, raw.height);
  expect([tagValue(r, TAG.TileWidth), tagValue(r, TAG.TileLength)]).toEqual([256, 256]);
  for (const tag of [TAG.TileWidth, TAG.TileLength, TAG.TileOffsets, TAG.TileByteCounts, TAG.WhiteLevel]) expect(type(r, tag)).toBe(LONG);
  expect(tagValues(r, TAG.TileOffsets)!.length).toBe(layout.count);
  expect(tagValues(r, TAG.CFARepeatPatternDim)).toEqual([raw.patternHeight, raw.patternWidth]);
  expect(tagValues(r, TAG.CFAPattern)).toEqual(raw.pattern);
  expect(tagValues(r, TAG.CFAPlaneColor)).toEqual([0, 1, 2]);
  expect(tagValue(r, TAG.CFALayout)).toBe(1);
  expect(type(r, TAG.BlackLevel)).toBe(RATIONAL);
  expect(tagValues(r, TAG.WhiteLevel)).toEqual([raw.white]);
  expect(tagValues(r, TAG.DefaultScale)).toEqual([1, 1]);
  expect(tagValues(r, TAG.BestQualityScale)).toEqual([1]);
  const c = meta.defaultCrop!;
  expect(tagValues(r, TAG.DefaultCropOrigin)).toEqual([c.x, c.y]);
  expect(tagValues(r, TAG.DefaultCropSize)).toEqual([c.width, c.height]);
  expect(tagBytes(r, TAG.OpcodeList1)).toEqual(meta.opcodeList1);
  expect(tagBytes(r, TAG.OpcodeList2)).toEqual(meta.opcodeList2);
  expect(tagBytes(r, TAG.OpcodeList3)).toEqual(meta.opcodeList3);
  for (const tag of [TAG.OpcodeList1, TAG.OpcodeList2, TAG.OpcodeList3]) expect(type(r, tag)).toBe(UNDEFINED);
  expect(r.entries.has(TAG.LinearizationTable)).toBe(false);

  const img = decodeRawImage(dng);
  expect(img.samplesPerPixel).toBe(1);
  expect(img.data).toEqual(raw.data);
}

function fullMeta(): DngMetadata {
  const meta = baseMeta();
  const rgb = new Uint8Array(160 * 120 * 3).map((_, i) => (i * 13) & 255);
  meta.thumbnail = { width: 160, height: 120, rgb };
  // Minimal baseline JPEG header: SOI, SOF0 400x300 4:2:0, EOI.
  meta.preview = {
    width: 400,
    height: 300,
    jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 1, 44, 1, 144, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]),
  };
  meta.opcodeList1 = list1;
  meta.opcodeList2 = list2;
  meta.opcodeList3 = list3;
  return meta;
}

describe('buildDng (lossless CFA)', () => {
  it('round-trips a Bayer mosaic and all metadata', async () => {
    const raw = syntheticCfa(600, 400, [0, 1, 1, 2], 2, [512, 513.5, 512, 514.25], 16383);
    const meta = fullMeta();
    const bytes = await buildDng(meta, raw);
    const dng = readDng(bytes);
    checkStructure(dng);
    checkCommon(dng, meta);
    checkCfa(dng, raw, meta);
    const r = dng.raw!;
    expect(tagValues(r, TAG.BlackLevelRepeatDim)).toEqual([2, 2]);
    expect(tagValues(r, TAG.BlackLevel)).toEqual(raw.black);
    expect(tagValues(r, TAG.AntiAliasStrength)).toEqual([1]);
    // DNG 1.6 because of the WarpRectilinear2 in list 3; backward 1.3 as it is optional.
    expect(tagValues(dng.ifd0, TAG.DNGVersion)).toEqual([1, 6, 0, 0]);
    expect(tagValues(dng.ifd0, TAG.DNGBackwardVersion)).toEqual([1, 3, 0, 0]);
  });

  it('round-trips an X-Trans mosaic', async () => {
    const raw = syntheticCfa(534, 390, XTRANS, 6, new Array(36).fill(1024), 16383, 2);
    const meta = fullMeta();
    const bytes = await buildDng(meta, raw);
    const dng = readDng(bytes);
    checkStructure(dng);
    checkCommon(dng, meta);
    checkCfa(dng, raw, meta);
    // Uniform black collapses to a 1 x 1 pattern; no AntiAliasStrength for X-Trans.
    expect(tagValues(dng.raw!, TAG.BlackLevelRepeatDim)).toEqual([1, 1]);
    expect(tagValues(dng.raw!, TAG.BlackLevel)).toEqual([1024]);
    expect(dng.raw!.entries.has(TAG.AntiAliasStrength)).toBe(false);
  });

  it('keeps a non-uniform X-Trans black pattern in full', async () => {
    const black = XTRANS.map((c, i) => 1000 + c * 3 + (i % 5));
    const raw = syntheticCfa(300, 260, XTRANS, 6, black, 16383, 3);
    const dng = readDng(await buildDng({ ...baseMeta(), defaultCrop: undefined }, raw));
    expect(tagValues(dng.raw!, TAG.BlackLevelRepeatDim)).toEqual([6, 6]);
    expect(tagValues(dng.raw!, TAG.BlackLevel)).toEqual(black);
    expect(decodeRawImage(dng).data).toEqual(raw.data);
  });

  it('writes a valid minimal file without optional metadata', async () => {
    const raw = syntheticCfa(300, 200, [1, 0, 2, 1], 2, [256, 256, 256, 256], 4095, 4);
    const meta: DngMetadata = {
      make: 'Nikon',
      model: 'Z 7',
      uniqueCameraModel: 'Nikon Z 7',
      software: 'test',
      orientation: 1,
      colorMatrix1: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      calibrationIlluminant1: 21,
      asShotNeutral: [0.5, 1, 0.7],
    };
    const dng = readDng(await buildDng(meta, raw));
    checkStructure(dng);
    expect(dng.ifd0.subIfds.length).toBe(1);
    expect([tagValue(dng.ifd0, TAG.ImageWidth), tagValue(dng.ifd0, TAG.ImageLength)]).toEqual([1, 1]);
    expect(dng.exif).toBeNull();
    expect(dng.gps).toBeNull();
    expect(tagValues(dng.ifd0, TAG.DNGVersion)).toEqual([1, 4, 0, 0]);
    expect(tagValues(dng.ifd0, TAG.DNGBackwardVersion)).toEqual([1, 1, 0, 0]);
    expect(tagValues(dng.raw!, TAG.BlackLevel)).toEqual([256]);
    expect(tagValues(dng.raw!, TAG.DefaultCropSize)).toEqual([300, 200]);
    expect(decodeRawImage(dng).data).toEqual(raw.data);
  });

  it('checks its input', () => {
    const raw = syntheticCfa(300, 200, [0, 1, 1, 2], 2, [0, 0, 0, 0], 4095, 5);
    const meta = baseMeta();
    const tiles = Array.from({ length: tileLayout(300, 200).count }, (_, i) => encodeCfaTile(raw, i));
    expect(() => assembleDng(meta, raw, tiles.slice(1))).toThrow(/Expected 2 tiles/);
    expect(() => assembleDng({ ...meta, defaultCrop: undefined, exif: { dateTimeOriginal: '2026-07-04T18:45:12' } }, raw, tiles)).toThrow(/dateTimeOriginal/);
    expect(() => assembleDng({ ...meta, defaultCrop: undefined, colorMatrix1: [1, 2, 3] }, raw, tiles)).toThrow(/colorMatrix1/);
    expect(() => assembleDng({ ...meta, defaultCrop: undefined, opcodeList3: new Uint8Array([0, 0, 0, 1]) }, raw, tiles)).toThrow(/Opcode list/);
    expect(() => assembleDng({ ...meta, defaultCrop: { x: 0, y: 0, width: 301, height: 10 } }, raw, tiles)).toThrow(/defaultCrop/);
  });

  it('writes ISO above 65535 as 65535 + ISOSpeed', async () => {
    const raw = syntheticCfa(300, 200, [0, 1, 1, 2], 2, [0, 0, 0, 0], 4095, 6);
    const meta = { ...baseMeta(), defaultCrop: undefined, exif: { iso: 102400 } };
    const ex = readDng(await buildDng(meta, raw)).exif!;
    expect(tagValue(ex, EXIF_TAG.ISOSpeedRatings)).toBe(65535);
    expect(tagValue(ex, EXIF_TAG.SensitivityType)).toBe(3);
    expect(tagValue(ex, EXIF_TAG.ISOSpeed)).toBe(102400);
  });

  it('parses the opcode lists it copies, ignoring trailing padding', () => {
    expect(parseOpcodeList(list3).map((o) => [o.id, o.version, o.flags, o.params.length])).toEqual([
      [14, 0x01060000, 1, 140],
      [1, 0x01030000, 0, 76],
    ]);
    const padded = new Uint8Array(list1.length + 3);
    padded.set(list1);
    expect(parseOpcodeList(padded).length).toBe(1);
    expect(() => parseOpcodeList(list3.subarray(0, list3.length - 1))).toThrow(/past the list/);
  });

  it('scales AsShotNeutral so its largest value is 1', async () => {
    const raw = syntheticCfa(300, 200, [0, 1, 1, 2], 2, [0, 0, 0, 0], 4095, 7);
    const meta = { ...baseMeta(), defaultCrop: undefined, asShotNeutral: [1.25, 1, 0.5] as [number, number, number] };
    close(tagValues(readDng(await buildDng(meta, raw)).ifd0, TAG.AsShotNeutral), [1, 0.8, 0.4], 1e-9);
  });
});

describe('X-Trans component count', () => {
  it('measures 1 vs 2 components on synthetic X-Trans data', () => {
    const raw = syntheticCfa(1536, 1024, XTRANS, 6, new Array(36).fill(1024), 16383, 9);
    const { count } = tileLayout(raw.width, raw.height);
    const size = (comps: number) => {
      let s = 0;
      for (let i = 0; i < count; i++) s += encodeCfaTileWith(raw, i, 256, comps).length;
      return s;
    };
    const one = size(1);
    const two = size(2);
    console.log(`X-Trans synthetic: 1 component ${(one / 1e6).toFixed(3)} MB, 2 components ${(two / 1e6).toFixed(3)} MB`);
    expect(one).toBeGreaterThan(0);
  });
});
