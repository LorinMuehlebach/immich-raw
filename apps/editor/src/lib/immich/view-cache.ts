// What a photo looked like in the editor, kept in the photo cache (photo-cache.ts): a JPEG of the
// canvas, taken when the photo was shown with its saved edit. The next open shows it while the
// photo loads; Immich's preview looks different (its own RAW conversion, without the edit).
//
// One file per photo: 4 bytes (little-endian) for the length of a JSON header, the header (which
// saved state the picture shows), then the JPEG.
import type { CachePart } from './opfs-lru.ts';
import { photoCache, viewName } from './photo-cache.ts';

export interface KeptView {
  /** The saved state it shows: the saved edit's JSON, or 'unedited'. */
  shows: string;
  image: Blob;
}

/** The kept look of a photo, or null. */
export async function readView(checksum: string): Promise<KeptView | null> {
  const file = await photoCache.read(viewName(checksum));
  if (!file) return null;
  try {
    return await parseView(file);
  } catch {
    return null;
  }
}

/** Keeps a photo's look (a JPEG of the canvas) for its next open. Best effort. */
export async function keepView(checksum: string, shows: string, jpeg: Blob): Promise<void> {
  try {
    await photoCache.write(viewName(checksum), viewParts(shows, new Uint8Array(await jpeg.arrayBuffer())));
  } catch {
    // the next open shows Immich's preview
  }
}

export function viewParts(shows: string, jpeg: Uint8Array): CachePart[] {
  const text = new TextEncoder().encode(JSON.stringify({ shows }));
  const head = new Uint8Array(4 + text.length);
  new DataView(head.buffer).setUint32(0, text.length, true);
  head.set(text, 4);
  return [head, jpeg as Uint8Array<ArrayBuffer>];
}

export async function parseView(file: Blob): Promise<KeptView | null> {
  if (file.size < 4) return null;
  const length = new DataView(await file.slice(0, 4).arrayBuffer()).getUint32(0, true);
  if (4 + length >= file.size) return null;
  const header = JSON.parse(await file.slice(4, 4 + length).text()) as { shows?: unknown };
  if (typeof header.shows !== 'string') return null;
  return { shows: header.shows, image: file.slice(4 + length, file.size, 'image/jpeg') };
}
