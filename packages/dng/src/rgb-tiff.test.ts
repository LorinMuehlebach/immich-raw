import { describe, expect, it } from 'vitest';
import { imageSegments, readDng, tagBytes, tagText, tagValue, tagValues, type DngIfd, type ParsedDng } from './reader.ts';
import { encodeRgbTiff, type RgbTiffMetadata } from './rgb-tiff.ts';
import { EXIF_TAG, GPS_TAG, TAG } from './tags.ts';
import { ASCII, BYTE, LONG, RATIONAL, SHORT, UNDEFINED } from './tiff.ts';

/** RGBA gradient with varying alpha (which must not leak into the TIFF). */
function gradient(width: number, height: number): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 255) / Math.max(1, width - 1);
      data[i + 1] = (y * 255) / Math.max(1, height - 1);
      data[i + 2] = (x * 37 + y * 101) & 255; // jumps, so differences wrap around
      data[i + 3] = (x + y) & 255;
    }
  }
  return { data, width, height };
}

const rgbOf = (rgba: Uint8ClampedArray) => Uint8Array.from({ length: (rgba.length / 4) * 3 }, (_, i) => rgba[Math.floor(i / 3) * 4 + (i % 3)]!);

/** zlib inflate (an independent implementation from the encoder's CompressionStream). */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflates the strips and undoes the horizontal predictor. */
async function decodePixels(tiff: ParsedDng): Promise<Uint8Array> {
  const ifd = tiff.ifd0;
  const width = tagValue(ifd, TAG.ImageWidth)!;
  const height = tagValue(ifd, TAG.ImageLength)!;
  const rowsPerStrip = tagValue(ifd, TAG.RowsPerStrip)!;
  const rowBytes = width * 3;
  const out = new Uint8Array(height * rowBytes);
  const segments = imageSegments(tiff, ifd);
  for (let s = 0; s < segments.length; s++) {
    const rows = Math.min(rowsPerStrip, height - s * rowsPerStrip);
    const raw = await inflate(segments[s]!);
    expect(raw.length).toBe(rows * rowBytes);
    for (let r = 0; r < rows; r++) {
      const row = raw.subarray(r * rowBytes, (r + 1) * rowBytes);
      for (let i = 3; i < rowBytes; i++) row[i] = (row[i]! + row[i - 3]!) & 255;
      out.set(row, (s * rowsPerStrip + r) * rowBytes);
    }
  }
  return out;
}

/** Every IFD sorted by tag, word-aligned values inside the file, strips word-aligned and in order. */
function checkStructure(tiff: ParsedDng): void {
  const visit = (ifd: DngIfd | null) => {
    if (!ifd) return;
    expect(ifd.offset % 2).toBe(0);
    const tags = [...ifd.entries.keys()];
    expect(tags).toEqual([...tags].sort((a, b) => a - b));
    for (const e of ifd.entries.values()) {
      if (e.bytes.length > 4) expect(e.valueOffset % 2).toBe(0);
      expect(e.valueOffset + e.bytes.length).toBeLessThanOrEqual(tiff.bytes.length);
    }
  };
  expect(tiff.chain).toHaveLength(1);
  [tiff.ifd0, tiff.exif, tiff.gps].forEach(visit);
  const offsets = tagValues(tiff.ifd0, TAG.StripOffsets)!;
  const counts = tagValues(tiff.ifd0, TAG.StripByteCounts)!;
  offsets.forEach((o, i) => {
    expect(o % 2).toBe(0);
    if (i > 0) expect(o).toBeGreaterThanOrEqual(offsets[i - 1]! + counts[i - 1]!);
  });
  expect(offsets[offsets.length - 1]! + counts[counts.length - 1]!).toBe(tiff.bytes.length);
}

const type = (ifd: DngIfd | null, tag: number) => ifd?.entries.get(tag)?.type;

const META: RgbTiffMetadata = {
  make: 'SONY',
  model: 'ILCE-7RM5',
  software: 'immich-raw 1.0',
  artist: 'Zoë Doe',
  copyright: '© 2024 Zoë Doe',
  description: 'Lake <dusk> & "friends"',
  dateTime: '2024:07:01 12:34:56',
  offsetTime: '+02:00',
  lensModel: 'FE 24-70mm F2.8 GM II',
  fNumber: 2.8,
  exposureTime: 1 / 250,
  iso: 400,
  focalLength: 35,
  gps: { latitude: 47.376887, longitude: -8.541694, altitude: 408.5 },
  ppi: 300,
  xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta> — ü',
};

describe('encodeRgbTiff', () => {
  it('round-trips pixels through several deflate strips (odd size, last strip shorter)', async () => {
    const img = gradient(37, 23);
    const bytes = await encodeRgbTiff(img, META, { stripBytes: 37 * 3 * 5 });
    const tiff = readDng(bytes);
    checkStructure(tiff);
    expect(tagValue(tiff.ifd0, TAG.RowsPerStrip)).toBe(5);
    expect(tagValues(tiff.ifd0, TAG.StripOffsets)).toHaveLength(5);
    expect(Array.from(await decodePixels(tiff))).toEqual(Array.from(rgbOf(img.data)));
  });

  it('writes the baseline image tags', async () => {
    const tiff = readDng(await encodeRgbTiff(gradient(37, 23), META, { stripBytes: 1000 }));
    const ifd0 = tiff.ifd0;
    expect(Array.from(tiff.bytes.subarray(0, 4))).toEqual([0x49, 0x49, 42, 0]);
    expect(tagValue(ifd0, TAG.ImageWidth)).toBe(37);
    expect(tagValue(ifd0, TAG.ImageLength)).toBe(23);
    expect(tagValues(ifd0, TAG.BitsPerSample)).toEqual([8, 8, 8]);
    expect(type(ifd0, TAG.BitsPerSample)).toBe(SHORT);
    expect(tagValue(ifd0, TAG.SamplesPerPixel)).toBe(3);
    expect(tagValue(ifd0, TAG.Compression)).toBe(8);
    expect(tagValue(ifd0, TAG.Predictor)).toBe(2);
    expect(tagValue(ifd0, TAG.PhotometricInterpretation)).toBe(2);
    expect(tagValue(ifd0, TAG.PlanarConfiguration)).toBe(1);
    expect(tagValue(ifd0, TAG.Orientation)).toBe(1);
    expect(tagValue(ifd0, TAG.RowsPerStrip)).toBe(9); // floor(1000 / 111)
    expect(type(ifd0, TAG.StripOffsets)).toBe(LONG);
    expect(tagValues(ifd0, TAG.StripByteCounts)).toHaveLength(3);
    expect(ifd0.entries.get(TAG.XResolution)!.rationals).toEqual([[300, 1]]);
    expect(ifd0.entries.get(TAG.YResolution)!.rationals).toEqual([[300, 1]]);
    expect(type(ifd0, TAG.XResolution)).toBe(RATIONAL);
    expect(tagValue(ifd0, TAG.ResolutionUnit)).toBe(2);
    expect(ifd0.entries.has(TAG.NewSubFileType)).toBe(false);
  });

  it('writes the descriptive, Exif and GPS metadata', async () => {
    const tiff = readDng(await encodeRgbTiff(gradient(37, 23), META));
    const ifd0 = tiff.ifd0;
    expect(tagText(ifd0, TAG.Make)).toBe('SONY');
    expect(tagText(ifd0, TAG.Model)).toBe('ILCE-7RM5');
    expect(tagText(ifd0, TAG.Software)).toBe('immich-raw 1.0');
    expect(tagText(ifd0, TAG.Artist)).toBe('Zoë Doe');
    expect(type(ifd0, TAG.Artist)).toBe(ASCII);
    expect(tagText(ifd0, TAG.Copyright)).toBe('© 2024 Zoë Doe');
    expect(type(ifd0, TAG.Copyright)).toBe(ASCII);
    expect(tagText(ifd0, TAG.ImageDescription)).toBe('Lake <dusk> & "friends"');
    expect(tagText(ifd0, TAG.DateTime)).toBe('2024:07:01 12:34:56');
    expect(type(ifd0, TAG.XMP)).toBe(BYTE);
    expect(new TextDecoder().decode(tagBytes(ifd0, TAG.XMP))).toBe(META.xmp);

    const ex = tiff.exif!;
    expect(ex).not.toBeNull();
    expect(type(ex, EXIF_TAG.ExifVersion)).toBe(UNDEFINED);
    expect(new TextDecoder().decode(tagBytes(ex, EXIF_TAG.ExifVersion))).toBe('0231');
    expect(tagText(ex, EXIF_TAG.DateTimeOriginal)).toBe('2024:07:01 12:34:56');
    expect(tagText(ex, EXIF_TAG.OffsetTimeOriginal)).toBe('+02:00');
    expect(ex.entries.get(EXIF_TAG.ExposureTime)!.rationals).toEqual([[1, 250]]);
    expect(tagValue(ex, EXIF_TAG.FNumber)).toBeCloseTo(2.8, 6);
    expect(tagValue(ex, EXIF_TAG.ISOSpeedRatings)).toBe(400);
    expect(tagValue(ex, EXIF_TAG.FocalLength)).toBe(35);
    expect(tagText(ex, EXIF_TAG.LensModel)).toBe('FE 24-70mm F2.8 GM II');
    expect(tagValue(ex, EXIF_TAG.ColorSpace)).toBe(1);
    expect(type(ex, EXIF_TAG.ColorSpace)).toBe(SHORT);
    expect(tagValue(ex, EXIF_TAG.PixelXDimension)).toBe(37);
    expect(tagValue(ex, EXIF_TAG.PixelYDimension)).toBe(23);

    const g = tiff.gps!;
    const deg = (v: number[]) => v[0]! + v[1]! / 60 + v[2]! / 3600;
    expect(tagValues(g, GPS_TAG.GPSVersionID)).toEqual([2, 3, 0, 0]);
    expect(tagText(g, GPS_TAG.GPSLatitudeRef)).toBe('N');
    expect(tagText(g, GPS_TAG.GPSLongitudeRef)).toBe('W');
    expect(deg(tagValues(g, GPS_TAG.GPSLatitude)!)).toBeCloseTo(47.376887, 7);
    expect(deg(tagValues(g, GPS_TAG.GPSLongitude)!)).toBeCloseTo(8.541694, 7);
    expect(tagValues(g, GPS_TAG.GPSAltitudeRef)).toEqual([0]);
    expect(tagValue(g, GPS_TAG.GPSAltitude)).toBeCloseTo(408.5, 6);
  });

  it('writes a minimal file without metadata: 72 ppi, Exif colour space and size only, no GPS', async () => {
    const img = gradient(37, 23);
    const tiff = readDng(await encodeRgbTiff(img));
    checkStructure(tiff);
    const ifd0 = tiff.ifd0;
    expect(tagValues(ifd0, TAG.StripOffsets)).toHaveLength(1); // default strip size holds the whole image
    expect(tagValue(ifd0, TAG.RowsPerStrip)).toBe(23);
    expect(ifd0.entries.get(TAG.XResolution)!.rationals).toEqual([[72, 1]]);
    expect(tagValue(ifd0, TAG.ResolutionUnit)).toBe(2);
    for (const tag of [TAG.Make, TAG.Model, TAG.Software, TAG.Artist, TAG.Copyright, TAG.ImageDescription, TAG.DateTime, TAG.XMP, TAG.GPSInfo]) {
      expect(ifd0.entries.has(tag)).toBe(false);
    }
    expect([...tiff.exif!.entries.keys()]).toEqual([EXIF_TAG.ExifVersion, EXIF_TAG.ColorSpace, EXIF_TAG.PixelXDimension, EXIF_TAG.PixelYDimension]);
    expect(tiff.gps).toBeNull();
    expect(Array.from(await decodePixels(tiff))).toEqual(Array.from(rgbOf(img.data)));
  });

  it('falls back to 72 ppi for a resolution that is not a positive number, keeps fractional ones', async () => {
    for (const ppi of [0, -5, Number.NaN]) {
      expect(readDng(await encodeRgbTiff(gradient(3, 2), { ppi })).ifd0.entries.get(TAG.XResolution)!.rationals).toEqual([[72, 1]]);
    }
    expect(readDng(await encodeRgbTiff(gradient(3, 2), { ppi: 240.5 })).ifd0.entries.get(TAG.YResolution)!.rationals).toEqual([[481, 2]]);
  });

  it('accepts packed RGB input with the same result as RGBA', async () => {
    const img = gradient(37, 23);
    const fromRgba = await encodeRgbTiff(img, META, { stripBytes: 600 });
    const fromRgb = await encodeRgbTiff({ data: rgbOf(img.data), width: 37, height: 23 }, META, { stripBytes: 600 });
    expect(Array.from(fromRgb)).toEqual(Array.from(fromRgba));
  });

  it('uses one-row strips when a row is larger than the strip size, and handles 1-pixel images', async () => {
    const img = gradient(40, 6);
    const tiff = readDng(await encodeRgbTiff(img, {}, { stripBytes: 10 }));
    expect(tagValue(tiff.ifd0, TAG.RowsPerStrip)).toBe(1);
    expect(tagValues(tiff.ifd0, TAG.StripOffsets)).toHaveLength(6);
    expect(Array.from(await decodePixels(tiff))).toEqual(Array.from(rgbOf(img.data)));

    for (const [w, h] of [
      [1, 1],
      [1, 9],
      [9, 1],
    ] as const) {
      const small = gradient(w, h);
      const t = readDng(await encodeRgbTiff(small, {}, { stripBytes: 7 }));
      checkStructure(t);
      expect(Array.from(await decodePixels(t))).toEqual(Array.from(rgbOf(small.data)));
    }
  });

  it('compresses a large smooth image well, in ~128 KB strips', async () => {
    const img = gradient(1024, 768);
    const bytes = await encodeRgbTiff(img);
    const tiff = readDng(bytes);
    const rows = tagValue(tiff.ifd0, TAG.RowsPerStrip)!;
    expect(rows).toBe(Math.floor((128 * 1024) / (1024 * 3)));
    expect(tagValues(tiff.ifd0, TAG.StripOffsets)).toHaveLength(Math.ceil(768 / rows));
    expect(bytes.length).toBeLessThan(1024 * 768 * 3 * 0.5);
    expect(Array.from(await decodePixels(tiff))).toEqual(Array.from(rgbOf(img.data)));
  });

  it('rejects bad input and badly formatted metadata', async () => {
    const img = gradient(4, 4);
    await expect(encodeRgbTiff({ data: new Uint8Array(10), width: 4, height: 4 })).rejects.toThrow(/RGBA/);
    await expect(encodeRgbTiff({ data: new Uint8Array(0), width: 0, height: 0 })).rejects.toThrow(/size/);
    await expect(encodeRgbTiff(img, { dateTime: '2024-07-01T12:34:56' })).rejects.toThrow(/dateTime/);
    await expect(encodeRgbTiff(img, { dateTime: '2024:07:01 12:34:56', offsetTime: '2' })).rejects.toThrow(/offsetTimeOriginal/);
    await expect(encodeRgbTiff(img, { gps: { latitude: 91, longitude: 0 } })).rejects.toThrow(/GPS/);
  });
});
