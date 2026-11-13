// The editor's cache of photos in the browser's storage: each RAW's original (download.ts), its
// decoded half-size image (decoded-cache.ts) and a JPEG of how it looked in the editor
// (view-cache.ts), in one folder with one size limit. Files are named after Immich's checksum of
// the original.
import { OpfsLru } from './opfs-lru.ts';

/**
 * The most the cache takes on disk: 5–10 photos of 45–61 MP with their packed decoded images (a
 * 45 MP CR3 and its decoded image take about 78 MB), so the open photo and the four around it fit.
 */
export const PHOTO_CACHE_BYTES = 800 * 1024 ** 2;

// The folder keeps the name it had when it held only originals (up to 2 GB): on the next write,
// eviction brings an old, bigger one down to the new limit.
export const photoCache = new OpfsLru('originals', PHOTO_CACHE_BYTES);

/** Base64 made safe for file names. */
const safe = (checksum: string) => checksum.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const originalName = (checksum: string) => `${safe(checksum)}.raw`;
export const decodedName = (checksum: string) => `${safe(checksum)}.half`;
export const viewName = (checksum: string) => `${safe(checksum)}.view`;

/** Keeps a photo's files while this page is open (the photo being edited, a prefetched one). */
export function pinPhoto(checksum: string): void {
  photoCache.pin(originalName(checksum), decodedName(checksum), viewName(checksum));
}

/** Lets go of the pinned photos: another photo was opened in the page. */
export function unpinPhotos(): void {
  photoCache.unpinAll();
}

/** Bytes another photo may take without pushing out a pinned one. */
export function cacheRoom(): Promise<number> {
  return photoCache.room();
}
