// Gets the photos next to the open one ready to open: their originals and half-size images go
// into this browser's cache (photo-cache.ts), so moving on to one of them skips the download and
// the decode. Runs in the background, one photo at a time, and only while the cache has room
// next to the photos this page keeps.
import { getAssetInfo } from '@immich/sdk';
import { RawSession } from '@immich-raw/decoder';
import { isRawFilename } from '@immich-raw/inject/raw';
import { hasDecoded, writeDecoded } from './decoded-cache.ts';
import { downloadOriginal, hasOriginal } from './download.ts';
import { cacheRoom, pinPhoto } from './photo-cache.ts';

interface NetworkInfo {
  saveData?: boolean;
  type?: string;
}

/**
 * Prefetching needs the caches (HTTPS or localhost) and isn't worth a phone's data plan or memory:
 * not with Data Saver on, on a mobile network, or with less than 4 GB of memory.
 */
export function canPrefetch(nav: Navigator = navigator, secure = globalThis.isSecureContext): boolean {
  const n = nav as Navigator & { connection?: NetworkInfo; deviceMemory?: number };
  if (!secure || typeof n.storage?.getDirectory !== 'function') return false;
  if (n.connection?.saveData || n.connection?.type === 'cellular') return false;
  return !(typeof n.deviceMemory === 'number' && n.deviceMemory < 4);
}

/**
 * Bytes a half-size image takes: a quarter of the pixels, 3 channels of 2 bytes. Without the
 * sensor size, guessed from the RAW file's size (a 41 MB CR3 gives 67 MB).
 */
export function decodedBytesGuess(width: number | null | undefined, height: number | null | undefined, fileBytes: number): number {
  if (width && height && width * height > 1e6) return Math.round(width * height * 1.5);
  return Math.round(fileBytes * 1.7);
}

/**
 * Puts one photo's original and half-size image into the cache, unless they are there already or
 * don't fit next to the photos this page keeps. 'full': skipped for lack of room.
 */
export async function prefetchPhoto(id: string): Promise<'done' | 'full' | 'skipped'> {
  const asset = await getAssetInfo({ id });
  if (asset.isTrashed || !isRawFilename(asset.originalFileName)) return 'skipped';
  const { checksum } = asset;
  const [decoded, original] = await Promise.all([hasDecoded(checksum, true), hasOriginal(checksum, true)]);
  if (!(decoded && original)) {
    const fileBytes = asset.exifInfo?.fileSizeInByte || 60e6;
    const needed = (original ? 0 : fileBytes) + (decoded ? 0 : decodedBytesGuess(asset.exifInfo?.exifImageWidth, asset.exifInfo?.exifImageHeight, fileBytes));
    if (needed > (await cacheRoom())) return 'full';
  }
  // Kept from now on, so the other neighbour doesn't push this one out.
  pinPhoto(checksum);
  if (decoded && original) return 'done';
  const bytes = await downloadOriginal({ id: asset.id, checksum });
  if (decoded) return 'done';
  // A decode of its own, in its own worker, like the editor's; the worker is gone afterwards.
  const session = await RawSession.open(bytes);
  await writeDecoded(checksum, session.meta, session.half);
  return 'done';
}
