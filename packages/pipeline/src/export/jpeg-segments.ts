// Writes an EXIF block into a JPEG produced by a canvas/encoder (which carries none).
// Little-endian TIFF inside an APP1 "Exif" segment, inserted right after SOI. Existing
// JFIF APP0 and Exif APP1 segments are removed; everything else is kept byte for byte.

export interface ExifFields {
  make?: string;
  model?: string;
  lensModel?: string;
  fNumber?: number;
  /** Seconds. */
  exposureTime?: number;
  iso?: number;
  focalLength?: number;
  /** 'YYYY:MM:DD HH:MM:SS' in the photo's local time. */
  dateTimeOriginal?: string;
  /** '+01:00' */
  offsetTimeOriginal?: string;
  gps?: { latitude: number; longitude: number; altitude?: number };
  software?: string;
  imageDescription?: string;
  artist?: string;
  copyright?: string;
  /** Print resolution in pixels per inch (X/YResolution, ResolutionUnit inches). */
  resolution?: number;
  /** Exif ColorSpace. */
  colorSpace?: 'sRGB';
  /** Exif PixelXDimension / PixelYDimension: the size of the encoded image. */
  pixelWidth?: number;
  pixelHeight?: number;
}

const T = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5, UNDEFINED: 7 } as const;
type TiffType = (typeof T)[keyof typeof T];

interface Entry {
  tag: number;
  type: TiffType;
  count: number;
  /** Value bytes, little-endian. */
  data: Uint8Array;
}

export const TAGS = {
  ImageDescription: 0x010e,
  Make: 0x010f,
  Model: 0x0110,
  Orientation: 0x0112,
  XResolution: 0x011a,
  YResolution: 0x011b,
  ResolutionUnit: 0x0128,
  Software: 0x0131,
  Artist: 0x013b,
  Copyright: 0x8298,
  ExifIFD: 0x8769,
  GPSIFD: 0x8825,
  ExposureTime: 0x829a,
  FNumber: 0x829d,
  ISOSpeedRatings: 0x8827,
  ExifVersion: 0x9000,
  DateTimeOriginal: 0x9003,
  OffsetTimeOriginal: 0x9011,
  FocalLength: 0x920a,
  ColorSpace: 0xa001,
  PixelXDimension: 0xa002,
  PixelYDimension: 0xa003,
  LensModel: 0xa434,
  GPSVersionID: 0x0000,
  GPSLatitudeRef: 0x0001,
  GPSLatitude: 0x0002,
  GPSLongitudeRef: 0x0003,
  GPSLongitude: 0x0004,
  GPSAltitudeRef: 0x0005,
  GPSAltitude: 0x0006,
} as const;

// --- value encoders -------------------------------------------------------------------

/** EXIF ASCII is NUL-terminated. Non-ASCII text is written as UTF-8, which exiftool reads. */
function ascii(tag: number, text: string): Entry {
  const bytes = new TextEncoder().encode(text);
  const data = new Uint8Array(bytes.length + 1);
  data.set(bytes);
  return { tag, type: T.ASCII, count: data.length, data };
}

function short(tag: number, value: number): Entry {
  const data = new Uint8Array(2);
  new DataView(data.buffer).setUint16(0, Math.max(0, Math.min(0xffff, Math.round(value))), true);
  return { tag, type: T.SHORT, count: 1, data };
}

function long(tag: number, value: number): Entry {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, value, true);
  return { tag, type: T.LONG, count: 1, data };
}

function bytes(tag: number, type: typeof T.BYTE | typeof T.UNDEFINED, values: number[]): Entry {
  return { tag, type, count: values.length, data: Uint8Array.from(values) };
}

function rationals(tag: number, values: [number, number][]): Entry {
  const data = new Uint8Array(values.length * 8);
  const view = new DataView(data.buffer);
  values.forEach(([n, d], i) => {
    view.setUint32(i * 8, n, true);
    view.setUint32(i * 8 + 4, d, true);
  });
  return { tag, type: T.RATIONAL, count: values.length, data };
}

/** Best rational approximation with a bounded denominator (continued fractions). */
export function toRational(value: number, maxDen = 100000): [number, number] {
  if (!Number.isFinite(value) || value <= 0) return [0, 1];
  // Exposure times like 1/250 are exactly representable as 1/n.
  if (value < 1) {
    const inv = 1 / value;
    if (Math.abs(inv - Math.round(inv)) < 1e-6 * inv) return [1, Math.round(inv)];
  }
  let [h0, h1, k0, k1] = [0, 1, 1, 0];
  let x = value;
  for (let i = 0; i < 32; i++) {
    const a = Math.floor(x);
    const h2 = a * h1 + h0;
    const k2 = a * k1 + k0;
    if (k2 > maxDen || h2 > 0xffffffff) break;
    [h0, h1, k0, k1] = [h1, h2, k1, k2];
    const frac = x - a;
    if (frac < 1e-12) break;
    x = 1 / frac;
  }
  return k1 === 0 ? [Math.round(value), 1] : [h1, k1];
}

function dms(decimal: number): [number, number][] {
  const abs = Math.abs(decimal);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  return [
    [deg, 1],
    [min, 1],
    [Math.round(sec * 10000), 10000],
  ];
}

// --- TIFF layout ------------------------------------------------------------------------

const align2 = (n: number) => n + (n & 1);

function ifdSize(entries: Entry[]): number {
  const data = entries.reduce((sum, e) => sum + (e.data.length > 4 ? align2(e.data.length) : 0), 0);
  return 2 + entries.length * 12 + 4 + data;
}

/** Writes one IFD at `offset` (relative to the TIFF header) with its data area right after it. */
function writeIfd(out: Uint8Array, offset: number, entries: Entry[]): void {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  let dataOffset = offset + 2 + sorted.length * 12 + 4;
  view.setUint16(offset, sorted.length, true);
  sorted.forEach((e, i) => {
    const p = offset + 2 + i * 12;
    view.setUint16(p, e.tag, true);
    view.setUint16(p + 2, e.type, true);
    view.setUint32(p + 4, e.count, true);
    if (e.data.length <= 4) {
      out.set(e.data, p + 8);
    } else {
      view.setUint32(p + 8, dataOffset, true);
      out.set(e.data, dataOffset);
      dataOffset += align2(e.data.length);
    }
  });
  view.setUint32(offset + 2 + sorted.length * 12, 0, true); // no next IFD
}

/** The TIFF structure (starting with "II*\0") holding the given fields. */
export function buildTiff(exif: ExifFields): Uint8Array {
  const ifd0: Entry[] = [short(TAGS.Orientation, 1)];
  if (exif.make) ifd0.push(ascii(TAGS.Make, exif.make));
  if (exif.model) ifd0.push(ascii(TAGS.Model, exif.model));
  if (exif.software) ifd0.push(ascii(TAGS.Software, exif.software));
  if (exif.imageDescription) ifd0.push(ascii(TAGS.ImageDescription, exif.imageDescription));
  if (exif.artist) ifd0.push(ascii(TAGS.Artist, exif.artist));
  if (exif.copyright) ifd0.push(ascii(TAGS.Copyright, exif.copyright));
  if (exif.resolution !== undefined && Number.isFinite(exif.resolution) && exif.resolution > 0) {
    const ppi = toRational(exif.resolution);
    ifd0.push(rationals(TAGS.XResolution, [ppi]), rationals(TAGS.YResolution, [ppi]), short(TAGS.ResolutionUnit, 2)); // inches
  }

  const exifIfd: Entry[] = [bytes(TAGS.ExifVersion, T.UNDEFINED, [0x30, 0x32, 0x33, 0x32])]; // "0232"
  if (exif.colorSpace === 'sRGB') exifIfd.push(short(TAGS.ColorSpace, 1));
  if (isDimension(exif.pixelWidth)) exifIfd.push(long(TAGS.PixelXDimension, exif.pixelWidth));
  if (isDimension(exif.pixelHeight)) exifIfd.push(long(TAGS.PixelYDimension, exif.pixelHeight));
  if (exif.exposureTime && exif.exposureTime > 0) exifIfd.push(rationals(TAGS.ExposureTime, [toRational(exif.exposureTime)]));
  if (exif.fNumber && exif.fNumber > 0) exifIfd.push(rationals(TAGS.FNumber, [toRational(exif.fNumber, 1000)]));
  if (exif.iso && exif.iso > 0) exifIfd.push(short(TAGS.ISOSpeedRatings, exif.iso));
  if (exif.dateTimeOriginal) exifIfd.push(ascii(TAGS.DateTimeOriginal, exif.dateTimeOriginal));
  if (exif.offsetTimeOriginal) exifIfd.push(ascii(TAGS.OffsetTimeOriginal, exif.offsetTimeOriginal));
  if (exif.focalLength && exif.focalLength > 0) exifIfd.push(rationals(TAGS.FocalLength, [toRational(exif.focalLength, 1000)]));
  if (exif.lensModel) exifIfd.push(ascii(TAGS.LensModel, exif.lensModel));

  let gpsIfd: Entry[] | null = null;
  const gps = exif.gps;
  if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
    gpsIfd = [
      bytes(TAGS.GPSVersionID, T.BYTE, [2, 3, 0, 0]),
      ascii(TAGS.GPSLatitudeRef, gps.latitude >= 0 ? 'N' : 'S'),
      rationals(TAGS.GPSLatitude, dms(gps.latitude)),
      ascii(TAGS.GPSLongitudeRef, gps.longitude >= 0 ? 'E' : 'W'),
      rationals(TAGS.GPSLongitude, dms(gps.longitude)),
    ];
    if (typeof gps.altitude === 'number' && Number.isFinite(gps.altitude)) {
      gpsIfd.push(bytes(TAGS.GPSAltitudeRef, T.BYTE, [gps.altitude < 0 ? 1 : 0]));
      gpsIfd.push(rationals(TAGS.GPSAltitude, [toRational(Math.abs(gps.altitude), 1000)]));
    }
  }

  // Pointer entries are LONGs; add placeholders now so IFD0's size is final.
  ifd0.push(long(TAGS.ExifIFD, 0));
  if (gpsIfd) ifd0.push(long(TAGS.GPSIFD, 0));

  const ifd0Offset = 8;
  const exifOffset = ifd0Offset + align2(ifdSize(ifd0));
  const gpsOffset = exifOffset + align2(ifdSize(exifIfd));
  const total = gpsIfd ? gpsOffset + ifdSize(gpsIfd) : gpsOffset;

  setLong(ifd0, TAGS.ExifIFD, exifOffset);
  if (gpsIfd) setLong(ifd0, TAGS.GPSIFD, gpsOffset);

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out[0] = 0x49; // "II": little-endian
  out[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, ifd0Offset, true);
  writeIfd(out, ifd0Offset, ifd0);
  writeIfd(out, exifOffset, exifIfd);
  if (gpsIfd) writeIfd(out, gpsOffset, gpsIfd);
  return out;
}

const isDimension = (n: number | undefined): n is number => n !== undefined && Number.isInteger(n) && n > 0 && n <= 0xffffffff;

function setLong(entries: Entry[], tag: number, value: number): void {
  const e = entries.find((x) => x.tag === tag)!;
  new DataView(e.data.buffer).setUint32(0, value, true);
}

// --- JPEG segments ----------------------------------------------------------------------

const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const JFIF_ID = [0x4a, 0x46, 0x49, 0x46, 0x00]; // "JFIF\0"

function startsWith(buf: Uint8Array, at: number, id: number[]): boolean {
  return id.every((b, i) => buf[at + i] === b);
}

/** Returns a new JPEG with the given EXIF (Orientation forced to 1). */
export function insertExif(jpeg: Uint8Array, exif: ExifFields): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Not a JPEG (missing SOI).');

  const tiff = buildTiff(exif);
  const segLength = 2 + EXIF_ID.length + tiff.length;
  if (segLength > 0xffff) throw new Error('EXIF block too large.');

  // Collect header segments up to SOS, dropping JFIF APP0 and Exif APP1.
  const kept: [number, number][] = [];
  let p = 2;
  while (p + 4 <= jpeg.length) {
    if (jpeg[p] !== 0xff) throw new Error(`Corrupt JPEG: no marker at ${p}.`);
    const marker = jpeg[p + 1]!;
    if (marker === 0xff) {
      p++; // fill byte
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI: rest is copied as-is
    const len = (jpeg[p + 2]! << 8) | jpeg[p + 3]!;
    const end = p + 2 + len;
    const drop = (marker === 0xe0 && startsWith(jpeg, p + 4, JFIF_ID)) || (marker === 0xe1 && startsWith(jpeg, p + 4, EXIF_ID));
    if (!drop) kept.push([p, end]);
    p = end;
  }

  const keptBytes = kept.reduce((s, [a, b]) => s + (b - a), 0);
  const out = new Uint8Array(2 + 2 + segLength + keptBytes + (jpeg.length - p));
  let o = 0;
  out[o++] = 0xff;
  out[o++] = 0xd8;
  out[o++] = 0xff;
  out[o++] = 0xe1;
  out[o++] = segLength >> 8;
  out[o++] = segLength & 0xff;
  out.set(EXIF_ID, o);
  o += EXIF_ID.length;
  out.set(tiff, o);
  o += tiff.length;
  for (const [a, b] of kept) {
    out.set(jpeg.subarray(a, b), o);
    o += b - a;
  }
  out.set(jpeg.subarray(p), o);
  return out;
}

// --- Immich mapping ---------------------------------------------------------------------

/** The subset of Immich's ExifResponseDto we read (kept local: no SDK dependency here). */
export interface ImmichExifLike {
  make?: string | null;
  model?: string | null;
  lensModel?: string | null;
  fNumber?: number | null;
  exposureTime?: string | null;
  iso?: number | null;
  focalLength?: number | null;
  dateTimeOriginal?: string | null;
  timeZone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  description?: string | null;
}

export function exifFromImmich(exif: ImmichExifLike | null | undefined): ExifFields {
  if (!exif) return {};
  const out: ExifFields = {};
  if (exif.make) out.make = exif.make;
  if (exif.model) out.model = exif.model;
  if (exif.lensModel) out.lensModel = exif.lensModel;
  if (typeof exif.fNumber === 'number' && exif.fNumber > 0) out.fNumber = exif.fNumber;
  const t = parseExposureTime(exif.exposureTime);
  if (t) out.exposureTime = t;
  if (typeof exif.iso === 'number' && exif.iso > 0) out.iso = exif.iso;
  if (typeof exif.focalLength === 'number' && exif.focalLength > 0) out.focalLength = exif.focalLength;
  if (exif.dateTimeOriginal) {
    const date = new Date(exif.dateTimeOriginal);
    if (!Number.isNaN(date.getTime())) {
      const offset = exif.timeZone ? (zoneOffsetMinutes(date, exif.timeZone) ?? 0) : 0;
      out.dateTimeOriginal = formatExifDate(new Date(date.getTime() + offset * 60000));
      out.offsetTimeOriginal = formatOffset(offset);
    }
  }
  if (typeof exif.latitude === 'number' && typeof exif.longitude === 'number') {
    out.gps = { latitude: exif.latitude, longitude: exif.longitude };
  }
  if (exif.description?.trim()) out.imageDescription = exif.description;
  return out;
}

/** '1/250' → 0.004, '2' → 2, '0.5' → 0.5, '1/250 s' → 0.004. */
export function parseExposureTime(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?/.exec(value);
  if (!m) return undefined;
  const v = m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Minutes east of UTC for an IANA zone or a fixed offset like 'UTC+2' / '+05:30'. */
export function zoneOffsetMinutes(date: Date, tz: string): number | null {
  const zone = tz.trim();
  if (/^(utc|gmt|z)$/i.test(zone)) return 0;
  const fixed = /^(?:utc|gmt)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(zone);
  if (fixed) {
    const minutes = Number(fixed[2]) * 60 + Number(fixed[3] ?? 0);
    return fixed[1] === '-' ? -minutes : minutes;
  }
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(date)
      .find((p) => p.type === 'timeZoneName')?.value;
    if (!name) return null;
    if (name === 'GMT' || name === 'UTC') return 0;
    const m = /([+-])(\d{2}):?(\d{2})?/.exec(name);
    if (!m) return null;
    const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
    return m[1] === '-' ? -minutes : minutes;
  } catch {
    return null;
  }
}

/** Formats the UTC fields of `d` as 'YYYY:MM:DD HH:MM:SS'. */
function formatExifDate(d: Date): string {
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}:${z(d.getUTCMonth() + 1)}:${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}`;
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
