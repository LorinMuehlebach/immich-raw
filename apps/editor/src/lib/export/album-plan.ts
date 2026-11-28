// Which files an album export writes: RAWs once each, other images unless they are the camera
// JPEG of a RAW in the album; no videos. The editor's saved JPEG of a RAW counts as that RAW, so
// it is rendered again from the RAW at full quality instead of being re-encoded; a virtual copy's
// JPEG counts as that copy, exported besides the original.
import { captureBaseName, isRawFilename } from '@immich-raw/inject/raw';

const SAME_CAPTURE_MS = 2000;

/** copyId: a RAW's virtual copy (its own settings), for the copy's JPEG in the album. */
export type AlbumItem = { kind: 'raw' | 'image'; id: string; name: string; copyId?: string };

export interface PlanAsset {
  id: string;
  originalFileName: string;
  /** Immich's asset type: 'IMAGE', 'VIDEO', ... */
  type: string;
  fileCreatedAt?: string;
  /** For the editor's renders: the RAW it was made from (null when that RAW is gone). */
  sourceId?: string | null;
  /** For a virtual copy's render: the copy. */
  copyId?: string | null;
}

export interface PlannedItems {
  items: AlbumItem[];
  /** The editor's saved JPEGs that are rendered again from their RAW. */
  renders: number;
  skipped: { videos: number; jpegTwins: number };
}

export function planItems(assets: PlanAsset[], skipJpegTwins: boolean): PlannedItems {
  const items: AlbumItem[] = [];
  const raws = new Set<string>();
  const captures: { base: string; t: number }[] = [];
  const skipped = { videos: 0, jpegTwins: 0 };
  let renders = 0;
  const addRaw = (id: string, name: string, copyId?: string | null) => {
    const key = copyId ? `${id}|${copyId}` : id;
    if (raws.has(key)) return;
    raws.add(key);
    items.push(copyId ? { kind: 'raw', id, name, copyId } : { kind: 'raw', id, name });
  };
  for (const a of assets) {
    if (!isRawFilename(a.originalFileName)) continue;
    addRaw(a.id, a.originalFileName);
    captures.push({ base: captureBaseName(a.originalFileName), t: Date.parse(a.fileCreatedAt ?? '') });
  }
  for (const a of assets) {
    if (isRawFilename(a.originalFileName)) continue;
    if (a.type === 'VIDEO') {
      skipped.videos++;
      continue;
    }
    if (a.type !== 'IMAGE') continue;
    if (a.sourceId) {
      renders++;
      addRaw(a.sourceId, a.originalFileName, a.copyId);
      continue;
    }
    if (skipJpegTwins) {
      const base = captureBaseName(a.originalFileName);
      const t = Date.parse(a.fileCreatedAt ?? '');
      if (captures.some((c) => c.base === base && (!Number.isFinite(t) || !Number.isFinite(c.t) || Math.abs(c.t - t) <= SAME_CAPTURE_MS))) {
        skipped.jpegTwins++;
        continue;
      }
    }
    items.push({ kind: 'image', id: a.id, name: a.originalFileName });
  }
  return { items, renders, skipped };
}

/** Runs `fn` over `items` with at most `limit` calls at once, keeping the order of results. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
