// Adds metadata chunks to a PNG produced by a canvas/encoder (which writes none). Chunks are
// rewritten around the image data; IDAT and every other chunk are copied byte for byte.
import { crc32 } from './crc32.ts';

export interface PngMetadata {
  /** TIFF block from buildTiff ("II*\0..."), written as eXIf. */
  exif?: Uint8Array;
  /** XMP packet, written as uncompressed iTXt with keyword "XML:com.adobe.xmp". */
  xmp?: string;
  /** Print resolution in pixels per inch, written as pHYs in pixels per metre. */
  ppi?: number;
  /** Writes an sRGB chunk (perceptual rendering intent). */
  srgb?: boolean;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const XMP_KEYWORD = 'XML:com.adobe.xmp';
const encoder = new TextEncoder();

interface Chunk {
  type: string;
  /** Whole chunk: length, type, data and CRC. */
  start: number;
  end: number;
}

function readChunks(png: Uint8Array): Chunk[] {
  if (png.length < 8 || SIGNATURE.some((b, i) => png[i] !== b)) throw new Error('Not a PNG (bad signature).');
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Chunk[] = [];
  let p = 8;
  while (p < png.length) {
    if (p + 12 > png.length) throw new Error(`Corrupt PNG: truncated chunk at ${p}.`);
    const length = dv.getUint32(p);
    const end = p + 12 + length;
    if (length > 0x7fffffff || end > png.length) throw new Error(`Corrupt PNG: chunk at ${p} runs past the end.`);
    const type = String.fromCharCode(png[p + 4]!, png[p + 5]!, png[p + 6]!, png[p + 7]!);
    chunks.push({ type, start: p, end });
    p = end;
    if (type === 'IEND') break;
  }
  return chunks;
}

/** Whether an iTXt chunk carries XMP (keyword "XML:com.adobe.xmp"). */
function isXmpChunk(png: Uint8Array, c: Chunk): boolean {
  if (c.type !== 'iTXt') return false;
  const key = encoder.encode(XMP_KEYWORD);
  const at = c.start + 8;
  if (at + key.length + 1 > c.end - 4) return false;
  return key.every((b, i) => png[at + i] === b) && png[at + key.length] === 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  const typeBytes = encoder.encode(type);
  out.set(typeBytes, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(data, crc32(typeBytes)));
  return out;
}

/** Pixels per metre for pHYs, or undefined when `ppi` isn't a usable resolution. */
function pixelsPerMetre(ppi: number | undefined): number | undefined {
  if (ppi === undefined || !Number.isFinite(ppi)) return undefined;
  const ppm = Math.round(ppi / 0.0254);
  return ppm >= 1 && ppm <= 0x7fffffff ? ppm : undefined;
}

function physChunk(ppm: number): Uint8Array {
  const data = new Uint8Array(9);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, ppm);
  dv.setUint32(4, ppm);
  data[8] = 1; // unit: metre
  return chunk('pHYs', data);
}

function xmpChunk(xmp: string): Uint8Array {
  const key = encoder.encode(XMP_KEYWORD);
  const text = encoder.encode(xmp);
  // keyword \0, compression flag 0, method 0, empty language tag \0, empty translated keyword \0, text
  const data = new Uint8Array(key.length + 5 + text.length);
  data.set(key);
  data.set(text, key.length + 5);
  return chunk('iTXt', data);
}

function exifChunk(tiff: Uint8Array): Uint8Array {
  const le = tiff[0] === 0x49 && tiff[1] === 0x49 && tiff[2] === 42 && tiff[3] === 0;
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d && tiff[2] === 0 && tiff[3] === 42;
  if (!le && !be) throw new Error('eXIf data must be a TIFF block ("II*\\0" or "MM\\0*").');
  return chunk('eXIf', tiff);
}

/**
 * Returns a new PNG with the given chunks: sRGB and pHYs right after IHDR, eXIf and the XMP
 * iTXt right before the first IDAT. Existing chunks of the kinds being written are removed (only
 * the XMP iTXt, not other text), and with `srgb` also iCCP, gAMA and cHRM, which sRGB
 * replaces. A `ppi` that isn't positive and finite and an empty `xmp` count as not given.
 * Only the signature and chunk framing are checked; other chunks are copied as they are.
 */
export function addPngMetadata(png: Uint8Array, m: PngMetadata): Uint8Array {
  const chunks = readChunks(png);
  if (chunks[0]?.type !== 'IHDR') throw new Error('Corrupt PNG: IHDR is not the first chunk.');
  const firstIdat = chunks.findIndex((c) => c.type === 'IDAT');
  if (firstIdat < 0) throw new Error('Corrupt PNG: no IDAT chunk.');

  const srgb = m.srgb === true;
  const ppm = pixelsPerMetre(m.ppi);
  const afterIhdr: Uint8Array[] = [];
  if (srgb) afterIhdr.push(chunk('sRGB', Uint8Array.of(0)));
  if (ppm !== undefined) afterIhdr.push(physChunk(ppm));
  const beforeIdat: Uint8Array[] = [];
  if (m.exif) beforeIdat.push(exifChunk(m.exif));
  if (m.xmp) beforeIdat.push(xmpChunk(m.xmp));

  const drop = (c: Chunk): boolean =>
    (srgb && (c.type === 'sRGB' || c.type === 'iCCP' || c.type === 'gAMA' || c.type === 'cHRM')) ||
    (ppm !== undefined && c.type === 'pHYs') ||
    (m.exif !== undefined && c.type === 'eXIf') ||
    (!!m.xmp && isXmpChunk(png, c));

  const parts: Uint8Array[] = [png.subarray(0, 8)];
  chunks.forEach((c, i) => {
    if (i === firstIdat) parts.push(...beforeIdat);
    if (!drop(c)) parts.push(png.subarray(c.start, c.end));
    if (i === 0) parts.push(...afterIhdr);
  });
  const last = chunks[chunks.length - 1]!;
  if (last.end < png.length) parts.push(png.subarray(last.end)); // anything after IEND, as is

  const out = new Uint8Array(parts.reduce((s, b) => s + b.length, 0));
  let o = 0;
  for (const b of parts) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}
