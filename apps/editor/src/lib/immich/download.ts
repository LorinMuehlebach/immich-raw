// Downloads an asset's original file with progress, cached in the Origin Private File
// System by checksum so reopening a RAW is instant (photo-cache.ts). Works without OPFS (no cache).
import { apiUrl, authHeaders } from './api.ts';
import { originalName as cacheName, photoCache as originals } from './photo-cache.ts';

export interface OriginalRef {
  id: string;
  /** Immich's asset checksum (base64 SHA-1). */
  checksum: string;
}

/** Where the bytes come from and how many have arrived (`total` is 0 when Immich doesn't say). */
export interface DownloadProgress {
  from: 'cache' | 'network';
  received: number;
  total: number;
}

export type OnDownloadProgress = (fraction: number, progress: DownloadProgress) => void;

/** `signal` stops a download (another photo was opened). */
export async function downloadOriginal(asset: OriginalRef, onProgress?: OnDownloadProgress, signal?: AbortSignal): Promise<Uint8Array> {
  const name = cacheName(asset.checksum);
  const cached = await readCache(name, onProgress);
  if (cached) return cached;
  const bytes = await fetchWithProgress(apiUrl(`/assets/${asset.id}/original`), onProgress, signal);
  void originals.write(name, [bytes as Uint8Array<ArrayBuffer>]); // best effort, don't block the editor
  return bytes;
}

/** An original without the cache (e.g. a JPEG in a batch export), with the same stall timeout. */
export function downloadUncached(id: string, onProgress?: OnDownloadProgress, signal?: AbortSignal): Promise<Uint8Array> {
  return fetchWithProgress(apiUrl(`/assets/${id}/original`), onProgress, signal);
}

/** The original from this browser's cache only, or null. */
export function readCachedOriginal(checksum: string): Promise<Uint8Array | null> {
  return readCache(cacheName(checksum));
}

/** Whether the original is cached in this browser. `touch`: also keep it longer, as if opened. */
export function hasOriginal(checksum: string, touch = false): Promise<boolean> {
  return originals.has(cacheName(checksum), touch);
}

/** A download gives up when Immich sends nothing for this long (e.g. the server stopped answering). */
const STALL_MS = 60_000;

async function fetchWithProgress(url: string, onProgress?: OnDownloadProgress, signal?: AbortSignal): Promise<Uint8Array> {
  const abort = new AbortController();
  signal?.throwIfAborted();
  signal?.addEventListener('abort', () => abort.abort(signal.reason), { once: true });
  let timer = 0;
  const poke = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => abort.abort(new Error('The download stalled: Immich sent nothing for a minute.')), STALL_MS);
  };
  poke();
  try {
    return await readBody(await fetch(url, { credentials: 'same-origin', headers: authHeaders(), signal: abort.signal }), poke, onProgress);
  } catch (e) {
    throw abort.signal.aborted ? abort.signal.reason : e;
  } finally {
    clearTimeout(timer);
  }
}

async function readBody(res: Response, poke: () => void, onProgress?: OnDownloadProgress): Promise<Uint8Array> {
  if (!res.ok) throw new Error(`Could not download the original (HTTP ${res.status}).`);
  poke();
  const total = Number(res.headers.get('Content-Length')) || 0;
  onProgress?.(0, { from: 'network', received: 0, total });
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.(1, { from: 'network', received: buf.length, total: buf.length });
    return buf;
  }
  const reader = res.body.getReader();
  // Preallocate when the size is known; otherwise collect chunks.
  let out = total > 0 ? new Uint8Array(total) : null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    poke();
    if (out && received + value.length <= out.length) out.set(value, received);
    else {
      if (out) {
        // Content-Length was wrong (e.g. compressed); switch to chunk mode.
        chunks.push(out.subarray(0, received));
        out = null;
      }
      chunks.push(value);
    }
    received += value.length;
    if (total > 0) onProgress?.(Math.min(1, received / total), { from: 'network', received, total });
  }
  onProgress?.(1, { from: 'network', received, total: Math.max(total, received) });
  if (out) return received === out.length ? out : out.subarray(0, received);
  const joined = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.length;
  }
  return joined;
}

/** Puts a file into the cache (e.g. a DNG made here, so opening it needs no download). */
export function cacheOriginal(checksum: string, bytes: Uint8Array): Promise<void> {
  return originals.write(cacheName(checksum), [bytes as Uint8Array<ArrayBuffer>]);
}

/** Removes a file from the cache (its asset was deleted). */
export function forgetOriginal(checksum: string): Promise<void> {
  return originals.remove(cacheName(checksum));
}

async function readCache(name: string, onProgress?: OnDownloadProgress): Promise<Uint8Array | null> {
  const file = await originals.read(name);
  if (!file) return null;
  onProgress?.(0, { from: 'cache', received: 0, total: file.size });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    onProgress?.(1, { from: 'cache', received: bytes.length, total: bytes.length });
    return bytes;
  } catch {
    return null; // removed meanwhile (another tab evicted it): download it instead
  }
}
