// Half-size images of opened RAWs, kept in the browser's private storage next to the cached
// originals (photo-cache.ts), so reopening a photo skips its half-size decode (1–3 s). Only
// half-size images are kept, never a full-resolution one.
//
// One file per photo, named after Immich's checksum of the original:
//   bytes 0–3  'IRH1'
//   bytes 4–7  length of the JSON header (little-endian)
//   then       the JSON header: format, decoder, image size, packed size, the RAW's metadata
//   then       the pixels (interleaved RGB, 16-bit), packed (pixel-pack.ts), starting at a
//              multiple of 8
// A file written by another decoder (DECODER) or format is ignored and replaced on the next open.
import { DECODER, type LinearImage, type RawMeta } from '@immich-raw/decoder';
import type { CachePart } from './opfs-lru.ts';
import { decodedName as fileName, photoCache as store } from './photo-cache.ts';
import type { PackReply, PackWork } from './pixel-pack.worker.ts';

/**
 * Bump when RawSession.open() returns different pixels or metadata without a new DECODER, or the
 * file changes. 2: packed pixels.
 */
const FORMAT = 2;
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
  /** Bytes of packed pixels after the header. */
  packed: number;
  meta: RawMeta;
}

export type Pack = (values: Uint16Array) => Promise<Uint8Array>;
export type Unpack = (packed: ArrayBuffer, count: number) => Promise<Uint16Array>;

const decoderId = () => `${DECODER.name} ${DECODER.version} ${DECODER.libraw}`;
const align8 = (n: number) => Math.ceil(n / 8) * 8;

/** The cached half-size image of a RAW, or null. */
export async function readDecoded(checksum: string): Promise<DecodedPhoto | null> {
  const file = await store.read(fileName(checksum));
  if (!file) return null;
  try {
    return await parseDecoded(file, unpackInWorker);
  } catch {
    return null;
  }
}

/** Keeps the half-size image of a RAW for the next open. Best effort. */
export async function writeDecoded(checksum: string, meta: RawMeta, half: LinearImage): Promise<void> {
  try {
    const parts = await decodedParts(meta, half, packInWorker);
    if (parts) await store.write(fileName(checksum), parts);
  } catch {
    // not kept: the next open decodes again
  }
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
export async function decodedParts(meta: RawMeta, half: LinearImage, pack: Pack): Promise<CachePart[] | null> {
  // Same test as RawSession.open() uses to tell a full-size result from a half-size one.
  if (!half.halfSize || half.width > meta.width * 0.75 || half.height > meta.height * 0.75) return null;
  if (half.data.length !== half.width * half.height * 3) return null;
  try {
    JSON.stringify(meta, (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('not finite');
      return value;
    });
  } catch {
    return null;
  }
  const packed = await pack(half.data);
  const header: Header = { format: FORMAT, decoder: decoderId(), width: half.width, height: half.height, packed: packed.length, meta };
  const text = new TextEncoder().encode(JSON.stringify(header));
  const head = new Uint8Array(align8(8 + text.length));
  const view = new DataView(head.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, text.length, true);
  head.set(text, 8);
  return [head, packed as Uint8Array<ArrayBuffer>];
}

/** Reads a file made from decodedParts(); null if it is from another decoder or format, or damaged. */
export async function parseDecoded(file: Blob, unpack: Unpack): Promise<DecodedPhoto | null> {
  if (file.size < 8) return null;
  const pre = new DataView(await file.slice(0, 8).arrayBuffer());
  if (pre.getUint32(0, true) !== MAGIC) return null;
  const length = pre.getUint32(4, true);
  if (8 + length > file.size) return null;
  const header = JSON.parse(await file.slice(8, 8 + length).text()) as Partial<Header>;
  const { width, height, packed, meta } = header;
  if (header.format !== FORMAT || header.decoder !== decoderId() || !meta || typeof meta !== 'object') return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width! <= 0 || height! <= 0) return null;
  if (width! > meta.width * 0.75 || height! > meta.height * 0.75) return null;
  const offset = align8(8 + length);
  if (!Number.isInteger(packed) || file.size !== offset + packed!) return null;
  const data = await unpack(await file.slice(offset).arrayBuffer(), width! * height! * 3);
  return { meta, half: { width: width!, height: height!, data, halfSize: true } };
}

// ---------------------------------------------------------------- the packing workers

/**
 * One worker packs, another unpacks. A worker does one job after another, and opening a photo
 * mustn't wait for packing a neighbour in the background (1–3 s).
 */
class PackWorker {
  private worker: Worker | null = null;
  private nextId = 0;
  private readonly waiting = new Map<number, { resolve: (r: Uint8Array | Uint16Array) => void; reject: (e: Error) => void }>();

  run(work: PackWork, transfer: Transferable[]): Promise<Uint8Array | Uint16Array> {
    const w = (this.worker ??= this.start());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      w.postMessage({ ...work, id }, transfer);
    });
  }

  private start(): Worker {
    const w = new Worker(new URL('./pixel-pack.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<PackReply>) => {
      const r = e.data;
      const job = this.waiting.get(r.id);
      this.waiting.delete(r.id);
      if (r.ok) job?.resolve(r.result);
      else job?.reject(new Error(r.message));
    };
    w.onerror = () => {
      // Didn't start or crashed: what was waiting fails (nothing is cached), the next job starts a new one.
      for (const job of this.waiting.values()) job.reject(new Error('The packing worker failed.'));
      this.waiting.clear();
      this.worker = null;
    };
    return w;
  }
}

const packer = new PackWorker();
const unpacker = new PackWorker();

/** A copy goes to the worker: the editor keeps rendering from the original. */
const packInWorker: Pack = (values) => {
  const copy = values.slice();
  return packer.run({ op: 'pack', values: copy }, [copy.buffer]) as Promise<Uint8Array>;
};

const unpackInWorker: Unpack = (packed, count) => unpacker.run({ op: 'unpack', packed, count }, [packed]) as Promise<Uint16Array>;
