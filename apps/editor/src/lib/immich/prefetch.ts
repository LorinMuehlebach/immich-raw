// Gets the photos around the open one ready to open: their originals and half-size images go into
// this browser's cache (photo-cache.ts), so moving on to one of them skips the download and the
// decode. Two steps per photo, one photo at a time: fetchNeighbour() downloads the original, and
// decodeNeighbour() decodes it later. A photo is only fetched if it fits in the cache, with its
// decoded image, next to the photos this page keeps.
import { getAssetInfo } from '@immich/sdk';
import { RawSession } from '@immich-raw/decoder';
import { isRawFilename } from '@immich-raw/inject/raw';
import { hasDecoded, writeDecoded } from './decoded-cache.ts';
import { cacheOriginal, downloadUncached, hasOriginal, readCachedOriginal } from './download.ts';
import { cacheRoom, pinPhoto } from './photo-cache.ts';

interface NetworkInfo {
  saveData?: boolean;
  type?: string;
}

/**
 * Prefetching needs the cache (HTTPS or localhost) and isn't worth a phone's data plan or memory:
 * not with Data Saver on, on a mobile network, or with less than 4 GB of memory.
 */
export function canPrefetch(nav: Navigator = navigator, secure = globalThis.isSecureContext): boolean {
  const n = nav as Navigator & { connection?: NetworkInfo; deviceMemory?: number };
  if (!secure || typeof n.storage?.getDirectory !== 'function') return false;
  if (n.connection?.saveData || n.connection?.type === 'cellular') return false;
  return !(typeof n.deviceMemory === 'number' && n.deviceMemory < 4);
}

/** Packed half-size images take 0.55–0.66 of their pixels' bytes (pixel-pack.ts); a bit more to be safe. */
const PACKED_SHARE = 0.7;

/**
 * Bytes a half-size image takes in the cache: a quarter of the pixels, 3 channels of 2 bytes,
 * packed. Without the sensor size, guessed from the RAW file's size (a 41 MB CR3 gives 67 MB
 * before packing).
 */
export function decodedBytesGuess(width: number | null | undefined, height: number | null | undefined, fileBytes: number): number {
  const raw = width && height && width * height > 1e6 ? width * height * 1.5 : fileBytes * 1.7;
  return Math.round(raw * PACKED_SHARE);
}

/** Room set aside for decoded images still to come, by checksum (fetched, not decoded yet). */
const reserved = new Map<string, number>();

/** Another photo is open: the room set aside for the old one's neighbours is free again. */
export function resetPrefetch(): void {
  reserved.clear();
}

/**
 * Downloads one photo's original into the cache, unless it is there already, the photo isn't a
 * RAW, or it doesn't fit with its decoded image. The photo's checksum for decodeNeighbour(), or
 * null when skipped.
 */
export async function fetchNeighbour(id: string, signal?: AbortSignal): Promise<string | null> {
  const asset = await getAssetInfo({ id });
  if (asset.isTrashed || !isRawFilename(asset.originalFileName)) return null;
  const { checksum } = asset;
  const [decoded, original] = await Promise.all([hasDecoded(checksum, true), hasOriginal(checksum, true)]);
  const fileBytes = asset.exifInfo?.fileSizeInByte || 60e6;
  const decodedBytes = decoded ? 0 : decodedBytesGuess(asset.exifInfo?.exifImageWidth, asset.exifInfo?.exifImageHeight, fileBytes);
  if (!(decoded && original)) {
    const pending = [...reserved.values()].reduce((sum, b) => sum + b, 0);
    if ((original ? 0 : fileBytes) + decodedBytes + pending > (await cacheRoom())) return null;
  }
  // Kept from now on, so the other neighbours don't push this one out.
  pinPhoto(checksum);
  if (decodedBytes) reserved.set(checksum, decodedBytes);
  if (!original) {
    const bytes = await downloadUncached(asset.id, undefined, signal);
    await cacheOriginal(checksum, bytes);
  }
  return checksum;
}

/** Decodes a fetched photo at half size into the cache. False when there was nothing to do. */
export async function decodeNeighbour(checksum: string, signal?: AbortSignal): Promise<boolean> {
  try {
    if (await hasDecoded(checksum, true)) return false;
    // Not there when it didn't fit after all: then there is nothing to decode from.
    const bytes = await readCachedOriginal(checksum);
    if (!bytes) return false;
    // A decode of its own, in its own worker, like the editor's; the worker is gone afterwards.
    const session = await RawSession.open(bytes, undefined, signal);
    await writeDecoded(checksum, session.meta, session.half);
    return true;
  } finally {
    reserved.delete(checksum);
  }
}
