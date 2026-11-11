// Downloads an asset's original file with progress, cached in the Origin Private File
// System by checksum so reopening a RAW is instant. Works without OPFS (no cache).
import { apiUrl, authHeaders } from './api.ts';

const CACHE_DIR = 'originals';
const INDEX_FILE = 'index.json';
const CACHE_LIMIT_BYTES = 2 * 1024 ** 3;

interface CacheEntry {
  size: number;
  lastUsed: number;
}
type CacheIndex = Record<string, CacheEntry>;

export interface OriginalRef {
  id: string;
  /** Immich's asset checksum (base64 SHA-1). */
  checksum: string;
}

export async function downloadOriginal(asset: OriginalRef, onProgress?: (fraction: number) => void): Promise<Uint8Array> {
  const name = cacheName(asset.checksum);
  const cached = await readCache(name);
  if (cached) {
    onProgress?.(1);
    return cached;
  }
  const bytes = await fetchWithProgress(apiUrl(`/assets/${asset.id}/original`), onProgress);
  void writeCache(name, bytes); // best effort, don't block the editor
  return bytes;
}

async function fetchWithProgress(url: string, onProgress?: (fraction: number) => void): Promise<Uint8Array> {
  const res = await fetch(url, { credentials: 'same-origin', headers: authHeaders() });
  if (!res.ok) throw new Error(`Could not download the original (HTTP ${res.status}).`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.(1);
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
    if (total > 0) onProgress?.(Math.min(1, received / total));
  }
  onProgress?.(1);
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
  return writeCache(cacheName(checksum), bytes);
}

/** Removes a file from the cache (its asset was deleted). */
export async function forgetOriginal(checksum: string): Promise<void> {
  const dir = await cacheDir();
  if (!dir) return;
  const name = cacheName(checksum);
  try {
    await dir.removeEntry(name);
  } catch {
    // not cached
  }
  try {
    const index = await readIndex(dir);
    delete index[name];
    await writeFile(dir, INDEX_FILE, JSON.stringify(index));
  } catch {
    // best effort
  }
}

function cacheName(checksum: string): string {
  return checksum.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '.raw';
}

async function cacheDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(CACHE_DIR, { create: true });
  } catch {
    return null;
  }
}

async function readIndex(dir: FileSystemDirectoryHandle): Promise<CacheIndex> {
  try {
    const file = await (await dir.getFileHandle(INDEX_FILE)).getFile();
    const parsed = JSON.parse(await file.text());
    return parsed && typeof parsed === 'object' ? (parsed as CacheIndex) : {};
  } catch {
    return {};
  }
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: BlobPart): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function readCache(name: string): Promise<Uint8Array | null> {
  const dir = await cacheDir();
  if (!dir) return null;
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    if (file.size === 0) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const index = await readIndex(dir);
    index[name] = { size: file.size, lastUsed: Date.now() };
    await writeFile(dir, INDEX_FILE, JSON.stringify(index));
    return bytes;
  } catch {
    return null;
  }
}

async function writeCache(name: string, bytes: Uint8Array): Promise<void> {
  const dir = await cacheDir();
  if (!dir) return;
  try {
    await writeFile(dir, name, bytes as Uint8Array<ArrayBuffer>);
    const index = await readIndex(dir);
    index[name] = { size: bytes.length, lastUsed: Date.now() };
    await evict(dir, index, name);
    await writeFile(dir, INDEX_FILE, JSON.stringify(index));
  } catch {
    // quota exceeded or OPFS unavailable: caching is optional
    try {
      await dir.removeEntry(name);
    } catch {
      // nothing to clean up
    }
  }
}

/** Removes least-recently-used files until the cache fits the limit. Mutates index. */
async function evict(dir: FileSystemDirectoryHandle, index: CacheIndex, keep: string): Promise<void> {
  let total = Object.values(index).reduce((sum, e) => sum + e.size, 0);
  const oldestFirst = Object.entries(index)
    .filter(([n]) => n !== keep)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [n, entry] of oldestFirst) {
    if (total <= CACHE_LIMIT_BYTES) break;
    try {
      await dir.removeEntry(n);
    } catch {
      // already gone
    }
    delete index[n];
    total -= entry.size;
  }
}
