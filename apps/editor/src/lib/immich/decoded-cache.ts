// Half-size images of opened RAWs, kept in the browser's private storage next to the cached
// originals (photo-cache.ts), so reopening a photo skips its half-size decode (1–3 s).
//
// One file per photo, named after Immich's checksum of the original:
//   bytes 0–3  'IRH1'
//   bytes 4–7  length of the JSON header (little-endian)
//   then       the JSON header: format, decoder, image size, the RAW's metadata
//   then       the pixels (interleaved RGB, 16-bit), starting at a multiple of 8
// A file written by another decoder (DECODER) or format is ignored and replaced on the next open.
import { DECODER, type LinearImage, type RawMeta } from '@immich-raw/decoder';
import type { CachePart } from './opfs-lru.ts';
import { decodedName as fileName, photoCache as store } from './photo-cache.ts';

/** Bump when RawSession.open() returns different pixels or metadata without a new DECODER. */
const FORMAT = 1;
const MAGIC = 0x31485249; // 'IRH1', read as a little-endian uint32
export interface DecodedPhoto {
  meta: RawMeta;
  half: LinearImage;
}

interface Header {
  format: number;
  decoder: string;
  width: number;
  height: number;
  meta: RawMeta;
}

const decoderId = () => `${DECODER.name} ${DECODER.version} ${DECODER.libraw}`;
const align8 = (n: number) => Math.ceil(n / 8) * 8;

/** The cached half-size image of a RAW, or null. */
export async function readDecoded(checksum: string): Promise<DecodedPhoto | null> {
  const file = await store.read(fileName(checksum));
  if (!file) return null;
  try {
    return await parseDecoded(file);
  } catch {
    return null;
  }
}

/** Keeps the half-size image of a RAW for the next open. Best effort. */
export async function writeDecoded(checksum: string, meta: RawMeta, half: LinearImage): Promise<void> {
  const parts = decodedParts(meta, half);
  if (parts) await store.write(fileName(checksum), parts);
}

/** Whether the half-size image is cached. `touch`: also keep it longer, as if opened. */
export function hasDecoded(checksum: string, touch = false): Promise<boolean> {
  return store.has(fileName(checksum), touch);
}

export function forgetDecoded(checksum: string): Promise<void> {
  return store.remove(fileName(checksum));
}

/**
 * The file's parts, or null when the image isn't a half-size one (only those are kept, never a
 * full-resolution image) or the metadata doesn't survive JSON (a number that isn't finite).
 */
export function decodedParts(meta: RawMeta, half: LinearImage): CachePart[] | null {
  // Same test as RawSession.open() uses to tell a full-size result from a half-size one.
  if (!half.halfSize || half.width > meta.width * 0.75 || half.height > meta.height * 0.75) return null;
  const header: Header = { format: FORMAT, decoder: decoderId(), width: half.width, height: half.height, meta };
  let json: string;
  try {
    json = JSON.stringify(header, (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('not finite');
      return value;
    });
  } catch {
    return null;
  }
  if (half.data.length !== half.width * half.height * 3) return null;
  const text = new TextEncoder().encode(json);
  const head = new Uint8Array(align8(8 + text.length));
  const view = new DataView(head.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, text.length, true);
  head.set(text, 8);
  return [head, half.data as Uint16Array<ArrayBuffer>];
}

/** Reads a file made from decodedParts(); null if it is from another decoder or format, or damaged. */
export async function parseDecoded(file: Blob): Promise<DecodedPhoto | null> {
  if (file.size < 8) return null;
  const pre = new DataView(await file.slice(0, 8).arrayBuffer());
  if (pre.getUint32(0, true) !== MAGIC) return null;
  const length = pre.getUint32(4, true);
  if (8 + length > file.size) return null;
  const header = JSON.parse(await file.slice(8, 8 + length).text()) as Partial<Header>;
  const { width, height, meta } = header;
  if (header.format !== FORMAT || header.decoder !== decoderId() || !meta || typeof meta !== 'object') return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width! <= 0 || height! <= 0) return null;
  if (width! > meta.width * 0.75 || height! > meta.height * 0.75) return null;
  const offset = align8(8 + length);
  const bytes = width! * height! * 3 * 2;
  if (file.size !== offset + bytes) return null;
  // A slice reads into its own buffer, so the pixels start at offset 0 like a decoded image's.
  const data = new Uint16Array(await file.slice(offset).arrayBuffer());
  return { meta, half: { width: width!, height: height!, data, halfSize: true } };
}
