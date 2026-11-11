// DNG writer. Layout follows Adobe DNG Converter:
//   IFD0       small 8-bit RGB thumbnail (NewSubFileType 1) + all DNG-level tags,
//              ExifIFD, GPSInfo and SubIFDs pointers
//   SubIFD 0   the raw image (NewSubFileType 0): lossless JPEG CFA tiles, or lossy JPEG
//              LinearRaw tiles
//   SubIFD 1   optional full-size-ish JPEG preview (NewSubFileType 1)
// then the image data. The whole layout is computed first and the file written into one
// buffer, so big files cost one allocation and one copy of each tile.
//
// Reference: Adobe DNG Specification 1.7.1.0. Reader-specific details are checked against
// LibRaw 0.22.1 (src/metadata/tiff.cpp, src/decoders/dng.cpp).
import { DNG_TILE, type CfaRaw, type DngMetadata, type LinearRaw } from './types.ts';
import { BYTE, Ifd, UNDEFINED, align2, layoutIfds, writeIfds } from './tiff.ts';
import {
  COMPRESSION_JPEG,
  COMPRESSION_LOSSY_JPEG,
  COMPRESSION_NONE,
  EXIF_TAG,
  GPS_TAG,
  PHOTOMETRIC_CFA,
  PHOTOMETRIC_LINEAR_RAW,
  PHOTOMETRIC_RGB,
  PHOTOMETRIC_YCBCR,
  TAG,
} from './tags.ts';
import { buildOpcodeList, mapPolynomialOpcodes, opcodeVersions, parseOpcodeList, type Opcode } from './opcodes.ts';
import { LOSSY_POLY, encodeCfaTile, lossyTileRgba, tileLayout } from './tiles.ts';

const V1_1 = 0x01010000;
const V1_4 = 0x01040000;

const versionBytes = (v: number) => new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);

export interface JpegFrameInfo {
  /** SOFn marker, e.g. 0xffc0 for baseline. */
  marker: number;
  precision: number;
  width: number;
  height: number;
  components: { id: number; h: number; v: number }[];
}

/** Reads the frame header of a JPEG. */
export function jpegFrameInfo(bytes: Uint8Array): JpegFrameInfo {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not a JPEG (no SOI marker)');
  let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) throw new Error('JPEG: expected a marker');
    const m = bytes[p + 1]!;
    if (m === 0xff) {
      p++;
      continue;
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      p += 2;
      continue;
    }
    const len = (bytes[p + 2]! << 8) | bytes[p + 3]!;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const s = p + 4;
      const n = bytes[s + 5]!;
      const components = [];
      for (let c = 0; c < n; c++) components.push({ id: bytes[s + 6 + 3 * c]!, h: bytes[s + 7 + 3 * c]! >> 4, v: bytes[s + 7 + 3 * c]! & 15 });
      return {
        marker: 0xff00 | m,
        precision: bytes[s]!,
        height: (bytes[s + 1]! << 8) | bytes[s + 2]!,
        width: (bytes[s + 3]! << 8) | bytes[s + 4]!,
        components,
      };
    }
    if (m === 0xda || m === 0xd9) break;
    p += 2 + len;
  }
  throw new Error('JPEG: no frame header');
}

function checkMatrix(name: string, m: number[] | undefined): void {
  if (m && (m.length !== 9 || m.some((v) => !Number.isFinite(v)))) throw new Error(`${name} must have 9 finite values`);
}

const DATE_RE = /^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d$/;

/**
 * Smallest repeat pattern (rows x cols, dividing the CFA pattern) that reproduces the black
 * levels: 1 x 1 when they are all equal. Readers handle 1 x 1 and 2 x 2 best (rawspeed only
 * reads the top-left 2 x 2 of a larger pattern).
 */
function blackRepeat(black: number[], pw: number, ph: number): { rows: number; cols: number; values: number[] } {
  const options: [number, number][] = [];
  for (let r = 1; r <= ph; r++) if (ph % r === 0) for (let c = 1; c <= pw; c++) if (pw % c === 0) options.push([r, c]);
  options.sort((a, b) => a[0] * a[1] - b[0] * b[1]);
  for (const [rows, cols] of options) {
    let ok = true;
    for (let y = 0; y < ph && ok; y++) for (let x = 0; x < pw && ok; x++) ok = black[y * pw + x] === black[(y % rows) * pw + (x % cols)];
    if (!ok) continue;
    const values: number[] = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) values.push(black[y * pw + x]!);
    return { rows, cols, values };
  }
  throw new Error('unreachable');
}

/** Degrees -> [deg, min, sec] rationals as numbers (seconds to 1/10000). */
function dms(deg: number): { d: number; m: number; s: number } {
  const total = Math.round(Math.abs(deg) * 3600 * 10000);
  return { d: Math.floor(total / 36_000_000), m: Math.floor((total % 36_000_000) / 600_000), s: (total % 600_000) / 10000 };
}

function exifIfd(exif: NonNullable<DngMetadata['exif']>): Ifd {
  const ifd = new Ifd();
  const E = EXIF_TAG;
  if (exif.exposureTime !== undefined && exif.exposureTime > 0) {
    const t = exif.exposureTime;
    const n = Math.round(1 / t);
    // 1/250 s rather than 4/1000.
    if (t < 1 && n > 0 && Math.abs(n * t - 1) < 1e-3) ifd.rationalFixed(E.ExposureTime, [1 / n], n);
    else ifd.rationals(E.ExposureTime, [t]);
  }
  if (exif.fNumber !== undefined && exif.fNumber > 0) ifd.rationalFixed(E.FNumber, [exif.fNumber], 100);
  if (exif.iso !== undefined && exif.iso > 0) {
    const iso = Math.round(exif.iso);
    // PhotographicSensitivity is a SHORT; EXIF 2.3 wants 65535 plus the real value in ISOSpeed above that.
    ifd.shorts(E.ISOSpeedRatings, [Math.min(iso, 65535)]);
    if (iso > 65535) {
      ifd.shorts(E.SensitivityType, [3]);
      ifd.longs(E.ISOSpeed, [iso]);
    }
  }
  ifd.bytes(E.ExifVersion, UNDEFINED, new TextEncoder().encode('0231'));
  if (exif.dateTimeOriginal) {
    if (!DATE_RE.test(exif.dateTimeOriginal)) throw new Error(`dateTimeOriginal must look like 'YYYY:MM:DD HH:MM:SS', got '${exif.dateTimeOriginal}'`);
    ifd.ascii(E.DateTimeOriginal, exif.dateTimeOriginal);
  }
  if (exif.offsetTimeOriginal) {
    if (!/^[+-]\d\d:\d\d$/.test(exif.offsetTimeOriginal)) throw new Error(`offsetTimeOriginal must look like '+HH:MM', got '${exif.offsetTimeOriginal}'`);
    ifd.ascii(E.OffsetTimeOriginal, exif.offsetTimeOriginal);
  }
  if (exif.exposureBias !== undefined && Number.isFinite(exif.exposureBias)) ifd.rationals(E.ExposureBiasValue, [exif.exposureBias], true);
  if (exif.focalLength !== undefined && exif.focalLength > 0) ifd.rationalFixed(E.FocalLength, [exif.focalLength], 100);
  if (exif.subSecTimeOriginal) {
    if (!/^\d+$/.test(exif.subSecTimeOriginal)) throw new Error(`subSecTimeOriginal must be digits, got '${exif.subSecTimeOriginal}'`);
    ifd.ascii(E.SubSecTimeOriginal, exif.subSecTimeOriginal);
  }
  if (exif.focalLengthIn35mm !== undefined && exif.focalLengthIn35mm > 0) ifd.shorts(E.FocalLengthIn35mmFilm, [Math.min(65535, Math.round(exif.focalLengthIn35mm))]);
  if (exif.bodySerialNumber) ifd.ascii(E.BodySerialNumber, exif.bodySerialNumber);
  if (exif.lensMake) ifd.ascii(E.LensMake, exif.lensMake);
  if (exif.lensModel) ifd.ascii(E.LensModel, exif.lensModel);
  return ifd;
}

function gpsIfd(gps: NonNullable<DngMetadata['gps']>): Ifd {
  if (!(Math.abs(gps.latitude) <= 90 && Math.abs(gps.longitude) <= 180)) throw new Error(`Bad GPS position ${gps.latitude}, ${gps.longitude}`);
  const ifd = new Ifd();
  ifd.bytes(GPS_TAG.GPSVersionID, BYTE, new Uint8Array([2, 3, 0, 0]));
  const lat = dms(gps.latitude);
  const lon = dms(gps.longitude);
  ifd.ascii(GPS_TAG.GPSLatitudeRef, gps.latitude < 0 ? 'S' : 'N');
  ifd.rationalFixed(GPS_TAG.GPSLatitude, [lat.d, lat.m, lat.s], 10000);
  ifd.ascii(GPS_TAG.GPSLongitudeRef, gps.longitude < 0 ? 'W' : 'E');
  ifd.rationalFixed(GPS_TAG.GPSLongitude, [lon.d, lon.m, lon.s], 10000);
  if (gps.altitude !== undefined && Number.isFinite(gps.altitude)) {
    ifd.bytes(GPS_TAG.GPSAltitudeRef, BYTE, new Uint8Array([gps.altitude < 0 ? 1 : 0]));
    ifd.rationalFixed(GPS_TAG.GPSAltitude, [Math.abs(gps.altitude)], 1000);
  }
  return ifd;
}

function checkRaw(raw: Omit<CfaRaw, 'data'> | Omit<LinearRaw, 'data'>): void {
  if (!(Number.isInteger(raw.width) && Number.isInteger(raw.height) && raw.width > 0 && raw.height > 0 && raw.width <= 65535 && raw.height <= 65535)) {
    throw new Error(`Bad image size ${raw.width}x${raw.height}`);
  }
  if (raw.kind !== 'cfa') return;
  const n = raw.patternWidth * raw.patternHeight;
  if (!(n > 0) || raw.pattern.length !== n || raw.black.length !== n) throw new Error('CFA pattern and black levels must have patternWidth * patternHeight entries');
  if (raw.pattern.some((c) => c !== 0 && c !== 1 && c !== 2)) throw new Error('CFA pattern colours must be 0, 1 or 2');
  if (raw.black.some((b) => !(b >= 0 && b < 65536))) throw new Error('Bad black level');
  if (!(Number.isInteger(raw.white) && raw.white > 0 && raw.white <= 65535)) throw new Error(`Bad white level ${raw.white}`);
}

/**
 * Builds the file from already encoded tiles: lossless JPEG tiles (encodeCfaTile) for 'cfa',
 * baseline JPEGs of lossyTileRgba tiles for 'linear'. `tile` must be the tile size the tiles
 * were made with.
 *
 * Lossy files get an OpcodeList2 with one MapPolynomial (LOSSY_POLY) per plane, which turns the
 * 8-bit codes back into linear values in Adobe's pipeline and in LibRaw (lossy_dng_load_raw
 * reads exactly that opcode; without it LibRaw assumes sRGB-encoded codes and Adobe linear
 * ones). meta.opcodeList1/2 are not written for lossy files: they describe the source's
 * mosaic, and a MapPolynomial in a copied list 2 would also replace our curve in LibRaw.
 * meta.opcodeList3 is written in both modes.
 */
export function assembleDng(meta: DngMetadata, raw: Omit<CfaRaw, 'data'> | Omit<LinearRaw, 'data'>, tiles: Uint8Array[], tile: number = DNG_TILE): Uint8Array {
  checkRaw(raw);
  const lossy = raw.kind === 'linear';
  const layout = tileLayout(raw.width, raw.height, tile);
  if (tiles.length !== layout.count) throw new Error(`Expected ${layout.count} tiles (${layout.across} x ${layout.down} of ${tile} px), got ${tiles.length}`);
  tiles.forEach((t, i) => {
    if (!t || t.length < 4 || t[0] !== 0xff || t[1] !== 0xd8) throw new Error(`Tile ${i} is not a JPEG`);
  });
  if (lossy) {
    tiles.forEach((t, i) => {
      const f = jpegFrameInfo(t);
      if (f.marker !== 0xffc0) throw new Error(`Tile ${i} is not a baseline JPEG (SOF ${f.marker.toString(16)}); progressive and other variants are not allowed in DNG`);
      if (f.precision !== 8 || f.components.length !== 3) throw new Error(`Tile ${i} must be an 8-bit, 3-component JPEG`);
      if (f.width !== layout.tileWidth || f.height !== layout.tileHeight) throw new Error(`Tile ${i} is ${f.width}x${f.height}, expected ${layout.tileWidth}x${layout.tileHeight}`);
    });
  }
  checkMatrix('colorMatrix1', meta.colorMatrix1);
  checkMatrix('colorMatrix2', meta.colorMatrix2);
  checkMatrix('forwardMatrix1', meta.forwardMatrix1);
  checkMatrix('forwardMatrix2', meta.forwardMatrix2);
  if (!meta.colorMatrix1) throw new Error('colorMatrix1 is required');
  if (meta.colorMatrix2 && !meta.calibrationIlluminant2) throw new Error('colorMatrix2 needs calibrationIlluminant2');
  if (meta.forwardMatrix2 && !meta.colorMatrix2) throw new Error('forwardMatrix2 needs colorMatrix2');
  for (const ill of [meta.calibrationIlluminant1, meta.calibrationIlluminant2]) {
    // 255 = "other" would need IlluminantData tags.
    if (ill !== undefined && !(Number.isInteger(ill) && ill >= 0 && ill < 255)) throw new Error(`Unsupported calibration illuminant ${ill}`);
  }
  if (meta.asShotNeutral.length !== 3 || meta.asShotNeutral.some((v) => !(v > 0 && Number.isFinite(v)))) throw new Error('asShotNeutral must be 3 positive values');
  if (!(Number.isInteger(meta.orientation) && meta.orientation >= 1 && meta.orientation <= 8)) throw new Error(`Bad orientation ${meta.orientation}`);
  if (meta.dateTime && !DATE_RE.test(meta.dateTime)) throw new Error(`dateTime must look like 'YYYY:MM:DD HH:MM:SS', got '${meta.dateTime}'`);

  // Opcode lists.
  const lists: { tag: number; ops: Opcode[]; bytes: Uint8Array }[] = [];
  const addList = (tag: number, bytes: Uint8Array | undefined, ops?: Opcode[]) => {
    if (!bytes) return;
    lists.push({ tag, bytes, ops: ops ?? parseOpcodeList(bytes) });
  };
  if (lossy) {
    const ops = mapPolynomialOpcodes(raw.width, raw.height, 3, LOSSY_POLY);
    addList(TAG.OpcodeList2, buildOpcodeList(ops), ops);
  } else {
    addList(TAG.OpcodeList1, meta.opcodeList1);
    addList(TAG.OpcodeList2, meta.opcodeList2);
  }
  addList(TAG.OpcodeList3, meta.opcodeList3);
  const opv = opcodeVersions(lists.map((l) => l.ops));
  const dngVersion = Math.max(V1_4, opv.version);
  const backwardVersion = Math.max(lossy ? V1_4 : V1_1, opv.backward);

  // IFD0: thumbnail + DNG tags.
  const thumb = meta.thumbnail ?? { width: 1, height: 1, rgb: new Uint8Array([128, 128, 128]) };
  if (thumb.rgb.length !== thumb.width * thumb.height * 3) throw new Error('thumbnail.rgb must have width * height * 3 bytes');
  const ifd0 = new Ifd();
  ifd0.longs(TAG.NewSubFileType, [1]);
  ifd0.longs(TAG.ImageWidth, [thumb.width]);
  ifd0.longs(TAG.ImageLength, [thumb.height]);
  ifd0.shorts(TAG.BitsPerSample, [8, 8, 8]);
  ifd0.shorts(TAG.Compression, [COMPRESSION_NONE]);
  ifd0.shorts(TAG.PhotometricInterpretation, [PHOTOMETRIC_RGB]);
  ifd0.ascii(TAG.Make, meta.make);
  ifd0.ascii(TAG.Model, meta.model);
  ifd0.longs(TAG.StripOffsets, [0]);
  ifd0.shorts(TAG.Orientation, [meta.orientation]);
  ifd0.shorts(TAG.SamplesPerPixel, [3]);
  ifd0.longs(TAG.RowsPerStrip, [thumb.height]);
  ifd0.longs(TAG.StripByteCounts, [thumb.rgb.length]);
  ifd0.shorts(TAG.PlanarConfiguration, [1]);
  ifd0.ascii(TAG.Software, meta.software);
  if (meta.dateTime) ifd0.ascii(TAG.DateTime, meta.dateTime);
  ifd0.longs(TAG.SubIFDs, meta.preview ? [0, 0] : [0]);
  if (meta.xmp) ifd0.bytes(TAG.XMP, BYTE, new TextEncoder().encode(meta.xmp));
  const exif = meta.exif ? exifIfd(meta.exif) : null;
  if (exif) ifd0.longs(TAG.ExifIFD, [0]);
  const gps = meta.gps ? gpsIfd(meta.gps) : null;
  if (gps) ifd0.longs(TAG.GPSInfo, [0]);
  ifd0.bytes(TAG.DNGVersion, BYTE, versionBytes(dngVersion));
  ifd0.bytes(TAG.DNGBackwardVersion, BYTE, versionBytes(backwardVersion));
  ifd0.ascii(TAG.UniqueCameraModel, meta.uniqueCameraModel);
  ifd0.rationals(TAG.ColorMatrix1, meta.colorMatrix1, true);
  if (meta.colorMatrix2) ifd0.rationals(TAG.ColorMatrix2, meta.colorMatrix2, true);
  // Only the direction matters; scaled so the largest value is 1, as Adobe writes it.
  const neutralMax = Math.max(...meta.asShotNeutral);
  ifd0.rationals(TAG.AsShotNeutral, meta.asShotNeutral.map((v) => v / Math.max(1, neutralMax)));
  if (meta.baselineExposure !== undefined) ifd0.rationals(TAG.BaselineExposure, [meta.baselineExposure], true);
  ifd0.shorts(TAG.CalibrationIlluminant1, [meta.calibrationIlluminant1]);
  if (meta.colorMatrix2) ifd0.shorts(TAG.CalibrationIlluminant2, [meta.calibrationIlluminant2!]);
  if (meta.originalRawFileName) ifd0.ascii(TAG.OriginalRawFileName, meta.originalRawFileName, true);
  if (meta.forwardMatrix1) ifd0.rationals(TAG.ForwardMatrix1, meta.forwardMatrix1, true);
  if (meta.forwardMatrix2) ifd0.rationals(TAG.ForwardMatrix2, meta.forwardMatrix2, true);

  // SubIFD 0: the raw image.
  const rawIfd = new Ifd();
  rawIfd.longs(TAG.NewSubFileType, [0]);
  rawIfd.longs(TAG.ImageWidth, [raw.width]);
  rawIfd.longs(TAG.ImageLength, [raw.height]);
  if (raw.kind === 'cfa') {
    rawIfd.shorts(TAG.BitsPerSample, [16]);
    rawIfd.shorts(TAG.Compression, [COMPRESSION_JPEG]);
    rawIfd.shorts(TAG.PhotometricInterpretation, [PHOTOMETRIC_CFA]);
    rawIfd.shorts(TAG.SamplesPerPixel, [1]);
  } else {
    rawIfd.shorts(TAG.BitsPerSample, [8, 8, 8]);
    rawIfd.shorts(TAG.Compression, [COMPRESSION_LOSSY_JPEG]);
    rawIfd.shorts(TAG.PhotometricInterpretation, [PHOTOMETRIC_LINEAR_RAW]);
    rawIfd.shorts(TAG.SamplesPerPixel, [3]);
  }
  rawIfd.shorts(TAG.PlanarConfiguration, [1]);
  rawIfd.longs(TAG.TileWidth, [layout.tileWidth]);
  rawIfd.longs(TAG.TileLength, [layout.tileHeight]);
  rawIfd.longs(TAG.TileOffsets, new Array<number>(layout.count).fill(0));
  rawIfd.longs(TAG.TileByteCounts, tiles.map((t) => t.length));
  if (raw.kind === 'cfa') {
    const { patternWidth: pw, patternHeight: ph } = raw;
    rawIfd.shorts(TAG.CFARepeatPatternDim, [ph, pw]);
    rawIfd.bytes(TAG.CFAPattern, BYTE, new Uint8Array(raw.pattern));
    rawIfd.bytes(TAG.CFAPlaneColor, BYTE, new Uint8Array([0, 1, 2]));
    rawIfd.shorts(TAG.CFALayout, [1]);
    const b = blackRepeat(raw.black, pw, ph);
    rawIfd.shorts(TAG.BlackLevelRepeatDim, [b.rows, b.cols]);
    // RATIONAL so fractional black levels survive.
    rawIfd.rationals(TAG.BlackLevel, b.values);
    rawIfd.longs(TAG.WhiteLevel, [raw.white]);
    if (pw === 2 && ph === 2) rawIfd.rationals(TAG.AntiAliasStrength, [1]);
  } else {
    rawIfd.shorts(TAG.BlackLevel, [0, 0, 0]);
    rawIfd.longs(TAG.WhiteLevel, [255, 255, 255]);
  }
  rawIfd.rationals(TAG.DefaultScale, [1, 1]);
  const crop = meta.defaultCrop ?? { x: 0, y: 0, width: raw.width, height: raw.height };
  if (!(crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0 && crop.x + crop.width <= raw.width && crop.y + crop.height <= raw.height)) {
    throw new Error(`defaultCrop ${JSON.stringify(crop)} is outside the ${raw.width}x${raw.height} image`);
  }
  if ([crop.x, crop.y, crop.width, crop.height].every(Number.isInteger)) {
    rawIfd.longs(TAG.DefaultCropOrigin, [crop.x, crop.y]);
    rawIfd.longs(TAG.DefaultCropSize, [crop.width, crop.height]);
  } else {
    rawIfd.rationals(TAG.DefaultCropOrigin, [crop.x, crop.y]);
    rawIfd.rationals(TAG.DefaultCropSize, [crop.width, crop.height]);
  }
  rawIfd.rationals(TAG.BestQualityScale, [1]);
  for (const l of lists) rawIfd.bytes(l.tag, UNDEFINED, l.bytes);

  // SubIFD 1: preview.
  let previewIfd: Ifd | null = null;
  if (meta.preview) {
    const f = jpegFrameInfo(meta.preview.jpeg);
    if (f.marker !== 0xffc0 && f.marker !== 0xffc1) throw new Error('The preview must be a baseline JPEG');
    if (f.width !== meta.preview.width || f.height !== meta.preview.height) throw new Error(`The preview JPEG is ${f.width}x${f.height}, not ${meta.preview.width}x${meta.preview.height}`);
    if (f.precision !== 8 || (f.components.length !== 3 && f.components.length !== 1)) throw new Error('The preview must be an 8-bit colour or greyscale JPEG');
    const color = f.components.length === 3;
    previewIfd = new Ifd();
    previewIfd.longs(TAG.NewSubFileType, [1]);
    previewIfd.longs(TAG.ImageWidth, [f.width]);
    previewIfd.longs(TAG.ImageLength, [f.height]);
    previewIfd.shorts(TAG.BitsPerSample, color ? [8, 8, 8] : [8]);
    previewIfd.shorts(TAG.Compression, [COMPRESSION_JPEG]);
    previewIfd.shorts(TAG.PhotometricInterpretation, [color ? PHOTOMETRIC_YCBCR : 1]);
    previewIfd.longs(TAG.StripOffsets, [0]);
    previewIfd.shorts(TAG.SamplesPerPixel, [f.components.length]);
    previewIfd.longs(TAG.RowsPerStrip, [f.height]);
    previewIfd.longs(TAG.StripByteCounts, [meta.preview.jpeg.length]);
    previewIfd.shorts(TAG.PlanarConfiguration, [1]);
    if (color) {
      const [y, cb] = f.components;
      previewIfd.shorts(TAG.YCbCrSubSampling, [Math.max(1, Math.round(y!.h / cb!.h)), Math.max(1, Math.round(y!.v / cb!.v))]);
    }
    previewIfd.longs(TAG.PreviewColorSpace, [color ? 2 : 1]);
  }

  // Layout: header, IFDs with their values, thumbnail, preview, tiles.
  const ifds = [ifd0, rawIfd, ...(previewIfd ? [previewIfd] : []), ...(exif ? [exif] : []), ...(gps ? [gps] : [])];
  let pos = layoutIfds(ifds, 8);
  pos = align2(pos);
  const thumbOffset = pos;
  pos += thumb.rgb.length;
  let previewOffset = 0;
  if (meta.preview) {
    pos = align2(pos);
    previewOffset = pos;
    pos += meta.preview.jpeg.length;
  }
  const tileOffsets: number[] = [];
  for (const t of tiles) {
    pos = align2(pos);
    tileOffsets.push(pos);
    pos += t.length;
  }
  if (pos > 0xffffffff) throw new Error('The DNG would be larger than 4 GB');

  ifd0.setLongs(TAG.StripOffsets, [thumbOffset]);
  ifd0.setLongs(TAG.SubIFDs, previewIfd ? [rawIfd.offset, previewIfd.offset] : [rawIfd.offset]);
  if (exif) ifd0.setLongs(TAG.ExifIFD, [exif.offset]);
  if (gps) ifd0.setLongs(TAG.GPSInfo, [gps.offset]);
  rawIfd.setLongs(TAG.TileOffsets, tileOffsets);
  if (previewIfd) previewIfd.setLongs(TAG.StripOffsets, [previewOffset]);

  const out = new Uint8Array(pos);
  const dv = new DataView(out.buffer);
  out[0] = 0x49;
  out[1] = 0x49;
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifd0.offset, true);
  writeIfds(out, ifds);
  out.set(thumb.rgb, thumbOffset);
  if (meta.preview) out.set(meta.preview.jpeg, previewOffset);
  tiles.forEach((t, i) => out.set(t, tileOffsets[i]));
  return out;
}

/**
 * Single-threaded convenience (tests, small images): encodes all tiles and assembles.
 * `encodeJpeg` is required for 'linear' and must return a baseline JPEG of the RGBA tile.
 */
export async function buildDng(
  meta: DngMetadata,
  raw: CfaRaw | LinearRaw,
  opts: { encodeJpeg?: (rgba: { data: Uint8ClampedArray; width: number; height: number }) => Promise<Uint8Array> } = {},
): Promise<Uint8Array> {
  const { count } = tileLayout(raw.width, raw.height);
  const tiles: Uint8Array[] = [];
  if (raw.kind === 'cfa') {
    for (let i = 0; i < count; i++) tiles.push(encodeCfaTile(raw, i));
  } else {
    const encode = opts.encodeJpeg;
    if (!encode) throw new Error('buildDng needs opts.encodeJpeg for lossy (linear) images');
    for (let i = 0; i < count; i++) tiles.push(await encode(lossyTileRgba(raw, i)));
  }
  return assembleDng(meta, raw, tiles);
}

