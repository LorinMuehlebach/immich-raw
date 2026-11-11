// Minimal TIFF/DNG reader for tests and diagnostics: the IFD tree (IFD0 chain, SubIFDs, Exif,
// GPS) with decoded tag values, and decoding of the raw IFD's lossless JPEG or uncompressed
// 16-bit tiles/strips.
import { decodeLosslessJpeg } from './ljpeg.ts';
import { TAG } from './tags.ts';
import { TYPE_SIZE } from './tiff.ts';

export interface DngEntry {
  tag: number;
  type: number;
  count: number;
  /** Absolute file offset of the value bytes. */
  valueOffset: number;
  /** The value bytes (a view into the file). */
  bytes: Uint8Array;
  /** Numeric types: the values ((S)RATIONAL as numerator / denominator). BYTE included. Empty for ASCII and UNDEFINED. */
  values: number[];
  /** ASCII: the string (UTF-8, trailing NULs removed). */
  text?: string;
  /** (S)RATIONAL: the raw [numerator, denominator] pairs. */
  rationals?: [number, number][];
}

export interface DngIfd {
  offset: number;
  entries: Map<number, DngEntry>;
  subIfds: DngIfd[];
  exif: DngIfd | null;
  gps: DngIfd | null;
}

export interface ParsedDng {
  bytes: Uint8Array;
  littleEndian: boolean;
  /** IFD0 followed by any IFDs chained to it. */
  chain: DngIfd[];
  ifd0: DngIfd;
  /** First IFD with NewSubFileType 0. */
  raw: DngIfd | null;
  /** IFDs with NewSubFileType 1 other than IFD0. */
  previews: DngIfd[];
  exif: DngIfd | null;
  gps: DngIfd | null;
}

const decoder = new TextDecoder();

export function readDng(bytes: Uint8Array): ParsedDng {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bo = String.fromCharCode(bytes[0]!, bytes[1]!);
  if (bo !== 'II' && bo !== 'MM') throw new Error('Not a TIFF file');
  const le = bo === 'II';
  if (dv.getUint16(2, le) !== 42) throw new Error('Not a classic TIFF file (BigTIFF is not supported)');
  const seen = new Set<number>();

  const readIfd = (offset: number, depth: number): DngIfd => {
    if (depth > 8 || seen.has(offset)) throw new Error(`IFD loop at ${offset}`);
    if (offset < 8 || offset + 2 > bytes.length) throw new Error(`IFD offset ${offset} out of range`);
    seen.add(offset);
    const n = dv.getUint16(offset, le);
    if (offset + 2 + n * 12 + 4 > bytes.length) throw new Error(`IFD at ${offset} is truncated`);
    const entries = new Map<number, DngEntry>();
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + i * 12;
      const tag = dv.getUint16(e, le);
      const type = dv.getUint16(e + 2, le);
      const count = dv.getUint32(e + 4, le);
      const size = (TYPE_SIZE[type] ?? 0) * count;
      if (!TYPE_SIZE[type]) continue; // unknown type: skip, as TIFF requires
      const valueOffset = size <= 4 ? e + 8 : dv.getUint32(e + 8, le);
      if (valueOffset + size > bytes.length) throw new Error(`Tag ${tag} points past the end of the file`);
      entries.set(tag, decodeEntry(dv, bytes, le, tag, type, count, valueOffset, size));
    }
    const ifd: DngIfd = { offset, entries, subIfds: [], exif: null, gps: null };
    for (const off of entries.get(TAG.SubIFDs)?.values ?? []) ifd.subIfds.push(readIfd(off, depth + 1));
    const exif = entries.get(TAG.ExifIFD)?.values[0];
    if (exif) ifd.exif = readIfd(exif, depth + 1);
    const gps = entries.get(TAG.GPSInfo)?.values[0];
    if (gps) ifd.gps = readIfd(gps, depth + 1);
    return ifd;
  };

  const chain: DngIfd[] = [];
  let next = dv.getUint32(4, le);
  while (next && chain.length < 16) {
    const ifd = readIfd(next, 0);
    chain.push(ifd);
    next = dv.getUint32(ifd.offset + 2 + dv.getUint16(ifd.offset, le) * 12, le);
  }
  if (!chain.length) throw new Error('TIFF file has no IFD');

  const all: DngIfd[] = [];
  const walk = (ifd: DngIfd) => {
    all.push(ifd);
    ifd.subIfds.forEach(walk);
  };
  chain.forEach(walk);
  const nsft = (ifd: DngIfd) => ifd.entries.get(TAG.NewSubFileType)?.values[0] ?? 0;
  const ifd0 = chain[0]!;
  return {
    bytes,
    littleEndian: le,
    chain,
    ifd0,
    raw: all.find((i) => nsft(i) === 0) ?? null,
    previews: all.filter((i) => i !== ifd0 && nsft(i) === 1),
    exif: ifd0.exif,
    gps: ifd0.gps,
  };
}

function decodeEntry(dv: DataView, bytes: Uint8Array, le: boolean, tag: number, type: number, count: number, off: number, size: number): DngEntry {
  const entry: DngEntry = { tag, type, count, valueOffset: off, bytes: bytes.subarray(off, off + size), values: [] };
  const v = entry.values;
  switch (type) {
    case 1: // BYTE
      for (let i = 0; i < count; i++) v.push(bytes[off + i]!);
      break;
    case 2: {
      // ASCII
      let end = off + count;
      while (end > off && bytes[end - 1] === 0) end--;
      entry.text = decoder.decode(bytes.subarray(off, end));
      break;
    }
    case 3:
      for (let i = 0; i < count; i++) v.push(dv.getUint16(off + 2 * i, le));
      break;
    case 4:
    case 13:
      for (let i = 0; i < count; i++) v.push(dv.getUint32(off + 4 * i, le));
      break;
    case 5:
    case 10: {
      entry.rationals = [];
      for (let i = 0; i < count; i++) {
        const n = type === 5 ? dv.getUint32(off + 8 * i, le) : dv.getInt32(off + 8 * i, le);
        const d = type === 5 ? dv.getUint32(off + 8 * i + 4, le) : dv.getInt32(off + 8 * i + 4, le);
        entry.rationals.push([n, d]);
        v.push(d === 0 ? 0 : n / d);
      }
      break;
    }
    case 6:
      for (let i = 0; i < count; i++) v.push(dv.getInt8(off + i));
      break;
    case 8:
      for (let i = 0; i < count; i++) v.push(dv.getInt16(off + 2 * i, le));
      break;
    case 9:
      for (let i = 0; i < count; i++) v.push(dv.getInt32(off + 4 * i, le));
      break;
    case 11:
      for (let i = 0; i < count; i++) v.push(dv.getFloat32(off + 4 * i, le));
      break;
    case 12:
      for (let i = 0; i < count; i++) v.push(dv.getFloat64(off + 8 * i, le));
      break;
  }
  return entry;
}

/** Numeric values of a tag, or undefined if the IFD doesn't have it. */
export function tagValues(ifd: DngIfd | null | undefined, tag: number): number[] | undefined {
  return ifd?.entries.get(tag)?.values;
}

/** First numeric value of a tag. */
export function tagValue(ifd: DngIfd | null | undefined, tag: number): number | undefined {
  return ifd?.entries.get(tag)?.values[0];
}

/** String value of an ASCII tag (or a BYTE tag holding UTF-8 text). */
export function tagText(ifd: DngIfd | null | undefined, tag: number): string | undefined {
  const e = ifd?.entries.get(tag);
  if (!e) return undefined;
  if (e.text !== undefined) return e.text;
  let end = e.bytes.length;
  while (end > 0 && e.bytes[end - 1] === 0) end--;
  return decoder.decode(e.bytes.subarray(0, end));
}

/** Raw value bytes of a tag (e.g. opcode lists, XMP). */
export function tagBytes(ifd: DngIfd | null | undefined, tag: number): Uint8Array | undefined {
  return ifd?.entries.get(tag)?.bytes;
}

/** The tile (or strip) payloads of an image IFD, in file order of the offsets tag. */
export function imageSegments(dng: ParsedDng, ifd: DngIfd): Uint8Array[] {
  const tiled = ifd.entries.has(TAG.TileOffsets);
  const offsets = tagValues(ifd, tiled ? TAG.TileOffsets : TAG.StripOffsets) ?? [];
  const counts = tagValues(ifd, tiled ? TAG.TileByteCounts : TAG.StripByteCounts) ?? [];
  if (offsets.length !== counts.length) throw new Error('Offsets and byte counts differ in length');
  return offsets.map((o, i) => {
    if (o + counts[i]! > dng.bytes.length) throw new Error(`Segment ${i} runs past the end of the file`);
    return dng.bytes.subarray(o, o + counts[i]!);
  });
}

/**
 * Decodes a 16-bit raw IFD (lossless JPEG, Compression 7, or uncompressed) to width * height *
 * SamplesPerPixel samples.
 */
export function decodeRawImage(dng: ParsedDng, ifd: DngIfd | null = dng.raw): { width: number; height: number; samplesPerPixel: number; data: Uint16Array } {
  if (!ifd) throw new Error('The file has no raw IFD');
  const width = tagValue(ifd, TAG.ImageWidth) ?? 0;
  const height = tagValue(ifd, TAG.ImageLength) ?? 0;
  const spp = tagValue(ifd, TAG.SamplesPerPixel) ?? 1;
  const compression = tagValue(ifd, TAG.Compression) ?? 1;
  const bps = tagValue(ifd, TAG.BitsPerSample) ?? 1;
  const tiled = ifd.entries.has(TAG.TileOffsets);
  const tw = tiled ? tagValue(ifd, TAG.TileWidth)! : width;
  const th = tiled ? tagValue(ifd, TAG.TileLength)! : Math.min(height, tagValue(ifd, TAG.RowsPerStrip) ?? height);
  const across = Math.ceil(width / tw);
  const segments = imageSegments(dng, ifd);
  const out = new Uint16Array(width * height * spp);
  segments.forEach((seg, i) => {
    const x0 = (i % across) * tw;
    const y0 = Math.floor(i / across) * th;
    const rows = tiled ? th : Math.min(th, height - y0);
    let samples: Uint16Array;
    if (compression === 7) {
      const j = decodeLosslessJpeg(seg);
      samples = j.data;
      if (samples.length < tw * rows * spp) throw new Error(`Tile ${i} decodes to ${samples.length} samples, expected ${tw * rows * spp}`);
    } else if (compression === 1 && bps === 16) {
      samples = new Uint16Array(tw * rows * spp);
      const dv = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
      for (let k = 0; k < samples.length; k++) samples[k] = dv.getUint16(2 * k, dng.littleEndian);
    } else throw new Error(`Unsupported raw compression ${compression} / ${bps} bits`);
    const w = Math.min(tw, width - x0);
    for (let r = 0; r < rows && y0 + r < height; r++) {
      out.set(samples.subarray(r * tw * spp, (r * tw + w) * spp), ((y0 + r) * width + x0) * spp);
    }
  });
  return { width, height, samplesPerPixel: spp, data: out };
}
