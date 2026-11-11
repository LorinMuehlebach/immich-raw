// Baseline 8-bit RGB TIFF for exports: one IFD, Adobe Deflate (zlib) strips with the
// horizontal differencing predictor, Exif and GPS IFDs and an XMP packet. Strips are
// differenced and compressed one at a time, so beyond the input only one uncompressed strip
// and the compressed data are held in memory.
import { DATE_RE, exifIfd, gpsIfd } from './dng.ts';
import { BYTE, Ifd, align2, layoutIfds, writeIfds } from './tiff.ts';
import { COMPRESSION_DEFLATE, EXIF_TAG, PHOTOMETRIC_RGB, PREDICTOR_HORIZONTAL, TAG } from './tags.ts';

export interface RgbTiffMetadata {
  make?: string;
  model?: string;
  software?: string;
  artist?: string;
  copyright?: string;
  /** IFD0 ImageDescription. */
  description?: string;
  /** 'YYYY:MM:DD HH:MM:SS' in the photo's local time: IFD0 DateTime and Exif DateTimeOriginal. */
  dateTime?: string;
  /** '+01:00': Exif OffsetTimeOriginal. */
  offsetTime?: string;
  lensModel?: string;
  fNumber?: number;
  /** Seconds. */
  exposureTime?: number;
  iso?: number;
  /** mm */
  focalLength?: number;
  /** Degrees (negative = south / west), metres. */
  gps?: { latitude: number; longitude: number; altitude?: number };
  /** Print resolution in pixels per inch; 72 when missing or not a positive number. */
  ppi?: number;
  /** XMP packet, written to tag 700 (XMLPacket). */
  xmp?: string;
}

export interface RgbTiffOptions {
  /** Target uncompressed strip size in bytes; strips hold whole rows, at least one. */
  stripBytes?: number;
}

const DEFAULT_PPI = 72;
const STRIP_BYTES = 128 * 1024;

/**
 * Baseline 8-bit RGB TIFF (alpha dropped): Adobe Deflate compression (8) with horizontal
 * differencing (Predictor 2), ~128 KB strips, Orientation 1, PlanarConfiguration 1,
 * Photometric RGB. `img.data` is RGBA (ImageData) or packed RGB. The Exif IFD is always
 * written, with ColorSpace sRGB and the pixel dimensions, plus whatever `meta` gives.
 * Async because deflate uses CompressionStream('deflate') (zlib format).
 * Throws on badly formatted dates and GPS positions out of range.
 */
export async function encodeRgbTiff(
  img: { data: Uint8ClampedArray | Uint8Array; width: number; height: number },
  meta: RgbTiffMetadata = {},
  opts: RgbTiffOptions = {},
): Promise<Uint8Array> {
  const { data, width, height } = img;
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) throw new Error(`Bad image size ${width}x${height}`);
  const channels = data.length === width * height * 4 ? 4 : data.length === width * height * 3 ? 3 : 0;
  if (!channels) throw new Error(`Expected ${width * height * 4} (RGBA) or ${width * height * 3} (RGB) bytes for ${width}x${height}, got ${data.length}`);

  // Metadata first, so bad values fail before the slow part.
  const ifd0 = new Ifd();
  ifd0.longs(TAG.ImageWidth, [width]);
  ifd0.longs(TAG.ImageLength, [height]);
  ifd0.shorts(TAG.BitsPerSample, [8, 8, 8]);
  ifd0.shorts(TAG.Compression, [COMPRESSION_DEFLATE]);
  ifd0.shorts(TAG.PhotometricInterpretation, [PHOTOMETRIC_RGB]);
  ifd0.shorts(TAG.Orientation, [1]);
  ifd0.shorts(TAG.SamplesPerPixel, [3]);
  ifd0.shorts(TAG.PlanarConfiguration, [1]);
  ifd0.shorts(TAG.Predictor, [PREDICTOR_HORIZONTAL]);
  const ppi = meta.ppi !== undefined && Number.isFinite(meta.ppi) && meta.ppi > 0 ? meta.ppi : DEFAULT_PPI;
  ifd0.rationals(TAG.XResolution, [ppi]);
  ifd0.rationals(TAG.YResolution, [ppi]);
  ifd0.shorts(TAG.ResolutionUnit, [2]); // inches
  if (meta.description) ifd0.ascii(TAG.ImageDescription, meta.description);
  if (meta.make) ifd0.ascii(TAG.Make, meta.make);
  if (meta.model) ifd0.ascii(TAG.Model, meta.model);
  if (meta.software) ifd0.ascii(TAG.Software, meta.software);
  if (meta.dateTime) {
    if (!DATE_RE.test(meta.dateTime)) throw new Error(`dateTime must look like 'YYYY:MM:DD HH:MM:SS', got '${meta.dateTime}'`);
    ifd0.ascii(TAG.DateTime, meta.dateTime);
  }
  if (meta.artist) ifd0.ascii(TAG.Artist, meta.artist);
  if (meta.copyright) ifd0.ascii(TAG.Copyright, meta.copyright);
  if (meta.xmp) ifd0.bytes(TAG.XMP, BYTE, new TextEncoder().encode(meta.xmp));

  const exif = exifIfd({
    dateTimeOriginal: meta.dateTime || undefined,
    offsetTimeOriginal: meta.offsetTime || undefined,
    exposureTime: meta.exposureTime,
    fNumber: meta.fNumber,
    iso: meta.iso,
    focalLength: meta.focalLength,
    lensModel: meta.lensModel || undefined,
  });
  exif.shorts(EXIF_TAG.ColorSpace, [1]); // sRGB
  exif.longs(EXIF_TAG.PixelXDimension, [width]);
  exif.longs(EXIF_TAG.PixelYDimension, [height]);
  ifd0.longs(TAG.ExifIFD, [0]);
  const gps = meta.gps ? gpsIfd(meta.gps) : null;
  if (gps) ifd0.longs(TAG.GPSInfo, [0]);

  // Image data.
  const rowBytes = width * 3;
  const rowsPerStrip = Math.max(1, Math.min(height, Math.floor((opts.stripBytes ?? STRIP_BYTES) / rowBytes)));
  const stripCount = Math.ceil(height / rowsPerStrip);
  const strip = new Uint8Array(rowsPerStrip * rowBytes);
  const strips: Uint8Array[] = [];
  for (let s = 0; s < stripCount; s++) {
    const y0 = s * rowsPerStrip;
    const rows = Math.min(rowsPerStrip, height - y0);
    for (let r = 0; r < rows; r++) differenceRow(data, channels, width, y0 + r, strip, r * rowBytes);
    strips.push(await deflate(strip.subarray(0, rows * rowBytes)));
  }
  ifd0.longs(TAG.RowsPerStrip, [rowsPerStrip]);
  ifd0.longs(TAG.StripByteCounts, strips.map((b) => b.length));
  ifd0.longs(TAG.StripOffsets, new Array<number>(stripCount).fill(0));

  // Layout: header, IFDs with their values, strips.
  const ifds = [ifd0, exif, ...(gps ? [gps] : [])];
  let pos = layoutIfds(ifds, 8);
  const offsets: number[] = [];
  for (const b of strips) {
    pos = align2(pos);
    offsets.push(pos);
    pos += b.length;
  }
  if (pos > 0xffffffff) throw new Error('The TIFF would be larger than 4 GB');
  ifd0.setLongs(TAG.StripOffsets, offsets);
  ifd0.setLongs(TAG.ExifIFD, [exif.offset]);
  if (gps) ifd0.setLongs(TAG.GPSInfo, [gps.offset]);

  const out = new Uint8Array(pos);
  const dv = new DataView(out.buffer);
  out[0] = 0x49; // "II": little-endian
  out[1] = 0x49;
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifd0.offset, true);
  writeIfds(out, ifds);
  strips.forEach((b, i) => out.set(b, offsets[i]));
  return out;
}

/** One row of RGB(A) as RGB with horizontal differencing (each sample minus its left neighbour, mod 256). */
function differenceRow(src: Uint8ClampedArray | Uint8Array, channels: number, width: number, y: number, dst: Uint8Array, at: number): void {
  let s = y * width * channels;
  let pr = 0;
  let pg = 0;
  let pb = 0;
  for (let x = 0, d = at; x < width; x++, s += channels, d += 3) {
    const r = src[s]!;
    const g = src[s + 1]!;
    const b = src[s + 2]!;
    dst[d] = r - pr; // Uint8Array stores mod 256
    dst[d + 1] = g - pg;
    dst[d + 2] = b - pb;
    pr = r;
    pg = g;
    pb = b;
  }
}

/** zlib stream of `bytes` (what TIFF compression 8 holds). */
async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Write and read together: the writer waits on backpressure until output is read.
  await Promise.all([
    writer.write(bytes).then(() => writer.close()),
    (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        chunks.push(value);
        size += value.length;
      }
    })(),
  ]);
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
