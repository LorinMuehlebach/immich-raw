import { describe, expect, it } from 'vitest';
import { TAGS, exifFromImmich, insertExif, parseExposureTime, toRational, zoneOffsetMinutes, type ExifFields } from './jpeg-segments.ts';

// --- a minimal synthetic JPEG (no real image data needed) ----------------------------------

const seg = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

const APP0_JFIF = seg(0xe0, [...text('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const APP1_OLD_EXIF = seg(0xe1, [...text('Exif'), 0, 0, 0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const APP2_ICC = seg(0xe2, [...text('ICC_PROFILE'), 0, 1, 1, 9, 9, 9]);
const DQT = seg(0xdb, [0, ...Array.from({ length: 64 }, (_, i) => i + 1)]);
const SOF0 = seg(0xc0, [8, 0, 16, 0, 16, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
const SOS_AND_SCAN = [...seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]), 0x12, 0xff, 0x00, 0x34, 0x56, 0xff, 0xd9];

function makeJpeg(...segments: number[][]): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, ...segments.flat(), ...SOS_AND_SCAN]);
}

// --- a tiny TIFF reader to parse the output back ---------------------------------------------

type Value = string | number[] | [number, number][];
interface ReadEntry {
  type: number;
  count: number;
  value: Value;
}

function readTiff(tiff: Uint8Array) {
  const v = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  expect(String.fromCharCode(tiff[0]!, tiff[1]!)).toBe('II');
  expect(v.getUint16(2, true)).toBe(42);
  const typeSize: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };

  const readIfd = (offset: number): Map<number, ReadEntry> => {
    expect(offset % 2).toBe(0);
    const n = v.getUint16(offset, true);
    const out = new Map<number, ReadEntry>();
    let lastTag = -1;
    for (let i = 0; i < n; i++) {
      const p = offset + 2 + i * 12;
      const tag = v.getUint16(p, true);
      const type = v.getUint16(p + 2, true);
      const count = v.getUint32(p + 4, true);
      expect(tag).toBeGreaterThan(lastTag); // ascending tag order
      lastTag = tag;
      const size = count * typeSize[type]!;
      const at = size <= 4 ? p + 8 : v.getUint32(p + 8, true);
      if (size > 4) expect(at % 2).toBe(0); // word aligned
      expect(at + size).toBeLessThanOrEqual(tiff.length);
      let value: Value;
      if (type === 2) {
        expect(tiff[at + count - 1]).toBe(0); // NUL-terminated
        value = new TextDecoder().decode(tiff.subarray(at, at + count - 1));
      } else if (type === 3) value = Array.from({ length: count }, (_, k) => v.getUint16(at + k * 2, true));
      else if (type === 4) value = Array.from({ length: count }, (_, k) => v.getUint32(at + k * 4, true));
      else if (type === 5) value = Array.from({ length: count }, (_, k) => [v.getUint32(at + k * 8, true), v.getUint32(at + k * 8 + 4, true)] as [number, number]);
      else value = Array.from(tiff.subarray(at, at + count));
      out.set(tag, { type, count, value });
    }
    expect(v.getUint32(offset + 2 + n * 12, true)).toBe(0); // single IFD chain
    return out;
  };

  const ifd0 = readIfd(v.getUint32(4, true));
  const exifPtr = ifd0.get(TAGS.ExifIFD)?.value as number[] | undefined;
  const gpsPtr = ifd0.get(TAGS.GPSIFD)?.value as number[] | undefined;
  return {
    ifd0,
    exif: exifPtr ? readIfd(exifPtr[0]!) : new Map<number, ReadEntry>(),
    gps: gpsPtr ? readIfd(gpsPtr[0]!) : null,
  };
}

/** Splits a JPEG into [marker, start, end] header segments plus the offset of SOS. */
function segments(jpeg: Uint8Array) {
  const list: { marker: number; start: number; end: number }[] = [];
  let p = 2;
  while (jpeg[p + 1] !== 0xda) {
    const len = (jpeg[p + 2]! << 8) | jpeg[p + 3]!;
    list.push({ marker: jpeg[p + 1]!, start: p, end: p + 2 + len });
    p += 2 + len;
  }
  return { list, sos: p };
}

function tiffOf(jpeg: Uint8Array): Uint8Array {
  const first = segments(jpeg).list[0]!;
  expect(first.marker).toBe(0xe1);
  expect(text('Exif').every((c, i) => jpeg[first.start + 4 + i] === c)).toBe(true);
  return jpeg.subarray(first.start + 10, first.end);
}

const FULL: ExifFields = {
  make: 'SONY',
  model: 'ILCE-7RM5',
  lensModel: 'FE 24-70mm F2.8 GM II',
  fNumber: 2.8,
  exposureTime: 1 / 250,
  iso: 400,
  focalLength: 35,
  dateTimeOriginal: '2024:07:01 12:34:56',
  offsetTimeOriginal: '+02:00',
  gps: { latitude: 47.3769, longitude: -8.5417, altitude: -12.5 },
  software: 'immich-raw@0.1.0',
  imageDescription: 'Zürich lake',
  artist: 'Jane Doe',
  copyright: '© 2024 Jane Doe',
  resolution: 300,
  colorSpace: 'sRGB',
  pixelWidth: 6000,
  pixelHeight: 4000,
};

describe('insertExif', () => {
  it('writes every tag with the right type, count and value', () => {
    const out = insertExif(makeJpeg(APP0_JFIF, DQT, SOF0), FULL);
    const { ifd0, exif, gps } = readTiff(tiffOf(out));

    expect(ifd0.get(TAGS.Orientation)).toEqual({ type: 3, count: 1, value: [1] });
    expect(ifd0.get(TAGS.Make)?.value).toBe('SONY');
    expect(ifd0.get(TAGS.Make)?.count).toBe(5);
    expect(ifd0.get(TAGS.Model)?.value).toBe('ILCE-7RM5');
    expect(ifd0.get(TAGS.Software)?.value).toBe('immich-raw@0.1.0');
    expect(ifd0.get(TAGS.ImageDescription)?.value).toBe('Zürich lake');
    expect(ifd0.get(TAGS.Artist)).toEqual({ type: 2, count: 9, value: 'Jane Doe' });
    // UTF-8 inside ASCII, like ImageDescription: '©' is two bytes.
    expect(ifd0.get(TAGS.Copyright)).toEqual({ type: 2, count: 17, value: '© 2024 Jane Doe' });
    expect(ifd0.get(TAGS.XResolution)).toEqual({ type: 5, count: 1, value: [[300, 1]] });
    expect(ifd0.get(TAGS.YResolution)).toEqual({ type: 5, count: 1, value: [[300, 1]] });
    expect(ifd0.get(TAGS.ResolutionUnit)).toEqual({ type: 3, count: 1, value: [2] });

    expect(exif.get(TAGS.ExifVersion)?.value).toEqual(text('0232'));
    expect(exif.get(TAGS.ColorSpace)).toEqual({ type: 3, count: 1, value: [1] });
    expect(exif.get(TAGS.PixelXDimension)).toEqual({ type: 4, count: 1, value: [6000] });
    expect(exif.get(TAGS.PixelYDimension)).toEqual({ type: 4, count: 1, value: [4000] });
    expect(exif.get(TAGS.ExposureTime)?.value).toEqual([[1, 250]]);
    const [fn, fd] = (exif.get(TAGS.FNumber)!.value as [number, number][])[0]!;
    expect(fn / fd).toBeCloseTo(2.8, 6);
    expect(exif.get(TAGS.ISOSpeedRatings)).toEqual({ type: 3, count: 1, value: [400] });
    expect(exif.get(TAGS.DateTimeOriginal)?.value).toBe('2024:07:01 12:34:56');
    expect(exif.get(TAGS.DateTimeOriginal)?.count).toBe(20);
    expect(exif.get(TAGS.OffsetTimeOriginal)?.value).toBe('+02:00');
    expect(exif.get(TAGS.FocalLength)?.value).toEqual([[35, 1]]);
    expect(exif.get(TAGS.LensModel)?.value).toBe('FE 24-70mm F2.8 GM II');

    expect(gps).not.toBeNull();
    expect(gps!.get(TAGS.GPSVersionID)?.value).toEqual([2, 3, 0, 0]);
    expect(gps!.get(TAGS.GPSLatitudeRef)?.value).toBe('N');
    expect(gps!.get(TAGS.GPSLongitudeRef)?.value).toBe('W');
    const toDecimal = (r: [number, number][]) => r[0]![0] / r[0]![1] + r[1]![0] / r[1]![1] / 60 + r[2]![0] / r[2]![1] / 3600;
    expect(toDecimal(gps!.get(TAGS.GPSLatitude)!.value as [number, number][])).toBeCloseTo(47.3769, 6);
    expect(toDecimal(gps!.get(TAGS.GPSLongitude)!.value as [number, number][])).toBeCloseTo(8.5417, 6);
    expect(gps!.get(TAGS.GPSAltitudeRef)?.value).toEqual([1]);
    const [an, ad] = (gps!.get(TAGS.GPSAltitude)!.value as [number, number][])[0]!;
    expect(an / ad).toBeCloseTo(12.5, 6);
  });

  it('removes JFIF APP0 and an old Exif APP1, keeps other segments and the scan byte for byte', () => {
    const input = makeJpeg(APP0_JFIF, APP1_OLD_EXIF, APP2_ICC, DQT, SOF0);
    const out = insertExif(input, { make: 'X' });
    const { list, sos } = segments(out);
    expect(list.map((s) => s.marker)).toEqual([0xe1, 0xe2, 0xdb, 0xc0]);
    expect(list.filter((s) => s.marker === 0xe0)).toHaveLength(0);

    const inSegs = segments(input);
    for (const marker of [0xe2, 0xdb, 0xc0]) {
      const a = inSegs.list.find((s) => s.marker === marker)!;
      const b = list.find((s) => s.marker === marker)!;
      expect(Array.from(out.subarray(b.start, b.end))).toEqual(Array.from(input.subarray(a.start, a.end)));
    }
    expect(Array.from(out.subarray(sos))).toEqual(Array.from(input.subarray(inSegs.sos)));
  });

  it('writes only Orientation, ExifVersion and pointers for empty fields, no GPS IFD', () => {
    const out = insertExif(makeJpeg(DQT, SOF0), {});
    const { ifd0, exif, gps } = readTiff(tiffOf(out));
    expect([...ifd0.keys()]).toEqual([TAGS.Orientation, TAGS.ExifIFD]);
    expect([...exif.keys()]).toEqual([TAGS.ExifVersion]);
    expect(gps).toBeNull();
  });

  it('writes fractional resolutions and skips invalid resolution and dimensions', () => {
    const fractional = readTiff(tiffOf(insertExif(makeJpeg(DQT), { resolution: 240.5 })));
    expect(fractional.ifd0.get(TAGS.XResolution)?.value).toEqual([[481, 2]]);
    expect(fractional.ifd0.get(TAGS.ResolutionUnit)?.value).toEqual([2]);

    const { ifd0, exif } = readTiff(tiffOf(insertExif(makeJpeg(DQT), { resolution: 0, pixelWidth: 12.5, pixelHeight: -1, artist: '', copyright: '' })));
    expect([...ifd0.keys()]).toEqual([TAGS.Orientation, TAGS.ExifIFD]);
    expect([...exif.keys()]).toEqual([TAGS.ExifVersion]);
  });

  it('keeps IFD0 and Exif IFD tags in ascending order with all fields', () => {
    const { ifd0, exif } = readTiff(tiffOf(insertExif(makeJpeg(DQT), FULL)));
    expect([...ifd0.keys()]).toEqual([
      TAGS.ImageDescription,
      TAGS.Make,
      TAGS.Model,
      TAGS.Orientation,
      TAGS.XResolution,
      TAGS.YResolution,
      TAGS.ResolutionUnit,
      TAGS.Software,
      TAGS.Artist,
      TAGS.Copyright,
      TAGS.ExifIFD,
      TAGS.GPSIFD,
    ]);
    expect([...exif.keys()]).toEqual([
      TAGS.ExposureTime,
      TAGS.FNumber,
      TAGS.ISOSpeedRatings,
      TAGS.ExifVersion,
      TAGS.DateTimeOriginal,
      TAGS.OffsetTimeOriginal,
      TAGS.FocalLength,
      TAGS.ColorSpace,
      TAGS.PixelXDimension,
      TAGS.PixelYDimension,
      TAGS.LensModel,
    ]);
  });

  it('writes the APP1 length field correctly', () => {
    const out = insertExif(makeJpeg(DQT), FULL);
    const len = (out[4]! << 8) | out[5]!;
    const { list } = segments(out);
    expect(list[0]!.end - list[0]!.start).toBe(len + 2);
  });

  it('rejects non-JPEG input', () => {
    expect(() => insertExif(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), {})).toThrow(/SOI/);
  });
});

describe('toRational', () => {
  it('represents exposure times as 1/n', () => {
    expect(toRational(1 / 250)).toEqual([1, 250]);
    expect(toRational(1 / 8000)).toEqual([1, 8000]);
  });
  it('approximates decimals', () => {
    expect(toRational(0.3)).toEqual([3, 10]);
    expect(toRational(2.8, 1000)).toEqual([14, 5]);
    expect(toRational(30)).toEqual([30, 1]);
  });
});

describe('exifFromImmich', () => {
  it('maps Immich exifInfo, converting the date to the photo\'s local time', () => {
    const out = exifFromImmich({
      make: 'Canon',
      model: 'Canon EOS R5',
      lensModel: 'RF24-105mm F4 L IS USM',
      fNumber: 4,
      exposureTime: '1/250',
      iso: 100,
      focalLength: 50,
      dateTimeOriginal: '2024-07-01T10:00:00.000Z',
      timeZone: 'Europe/Zurich',
      latitude: 47.1,
      longitude: 8.2,
      description: '  ',
    });
    expect(out).toEqual({
      make: 'Canon',
      model: 'Canon EOS R5',
      lensModel: 'RF24-105mm F4 L IS USM',
      fNumber: 4,
      exposureTime: 0.004,
      iso: 100,
      focalLength: 50,
      dateTimeOriginal: '2024:07:01 12:00:00',
      offsetTimeOriginal: '+02:00',
      gps: { latitude: 47.1, longitude: 8.2 },
    });
  });

  it('handles fixed offsets, missing time zones and missing GPS', () => {
    expect(exifFromImmich({ dateTimeOriginal: '2024-01-01T00:00:00.000Z', timeZone: 'UTC+5:30' })).toMatchObject({
      dateTimeOriginal: '2024:01:01 05:30:00',
      offsetTimeOriginal: '+05:30',
    });
    expect(exifFromImmich({ dateTimeOriginal: '2024-01-01T00:00:00.000Z' })).toMatchObject({
      dateTimeOriginal: '2024:01:01 00:00:00',
      offsetTimeOriginal: '+00:00',
    });
    expect(exifFromImmich({ latitude: 1, longitude: null }).gps).toBeUndefined();
    expect(exifFromImmich(null)).toEqual({});
  });
});

describe('helpers', () => {
  it('parses exposure time strings', () => {
    expect(parseExposureTime('1/250')).toBeCloseTo(0.004);
    expect(parseExposureTime('2')).toBe(2);
    expect(parseExposureTime('0.5')).toBe(0.5);
    expect(parseExposureTime('1/250 s')).toBeCloseTo(0.004);
    expect(parseExposureTime('')).toBeUndefined();
    expect(parseExposureTime('n/a')).toBeUndefined();
  });
  it('resolves time zone offsets', () => {
    const winter = new Date('2024-01-15T12:00:00Z');
    expect(zoneOffsetMinutes(winter, 'Europe/Zurich')).toBe(60);
    expect(zoneOffsetMinutes(winter, 'America/New_York')).toBe(-300);
    expect(zoneOffsetMinutes(winter, 'UTC-3')).toBe(-180);
    expect(zoneOffsetMinutes(winter, 'Not/AZone')).toBeNull();
  });
});
