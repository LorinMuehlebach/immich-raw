// Watermark logos: PNG files picked in the export settings, kept in this browser like the rest of
// those settings. They live in an IndexedDB database of their own, so adding them never has to
// upgrade (and wait on) the presets database, and nothing evicts them the way the AI cache is.
// Without IndexedDB they are kept for this session only.

export interface StoredLogo {
  id: string;
  /** The file name it was picked as. */
  name: string;
  /** A PNG. */
  blob: Blob;
  width: number;
  height: number;
  addedAt: number;
}

export interface LogoStorage {
  get(id: string): Promise<StoredLogo | null>;
  list(): Promise<StoredLogo[]>;
  put(logo: StoredLogo): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Bigger files are refused; bigger images are scaled down to maxSide on import. */
export const LOGO_LIMITS = { maxBytes: 16 * 1024 * 1024, maxSide: 4096 } as const;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Why a picked file can't be a logo, or null. `head` is its first bytes (8 or more). */
export function logoFileProblem(file: { size: number }, head: Uint8Array): string | null {
  if (head.length < 8 || PNG_SIGNATURE.some((b, i) => head[i] !== b)) return 'The logo must be a PNG file.';
  if (file.size > LOGO_LIMITS.maxBytes) return `The logo is larger than ${LOGO_LIMITS.maxBytes / 1024 / 1024} MB.`;
  return null;
}

/** Ids that also work where crypto.randomUUID doesn't (plain HTTP). */
export function newLogoId(): string {
  return `logo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class MemoryLogoStorage implements LogoStorage {
  private items = new Map<string, StoredLogo>();

  async get(id: string): Promise<StoredLogo | null> {
    return this.items.get(id) ?? null;
  }

  async list(): Promise<StoredLogo[]> {
    return [...this.items.values()];
  }

  async put(logo: StoredLogo): Promise<void> {
    this.items.set(logo.id, logo);
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }
}

/** IndexedDB storage; if IndexedDB is missing or fails it quietly keeps logos in memory. */
export class IndexedDbLogoStorage implements LogoStorage {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private fallback: MemoryLogoStorage | null = null;

  constructor(
    private readonly dbName = 'raw-editor-logos',
    private readonly storeName = 'logos',
  ) {}

  private open(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(this.storeName)) req.result.createObjectStore(this.storeName, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
    return this.dbPromise;
  }

  private async run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(this.storeName, mode);
      const req = op(tx.objectStore(this.storeName));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? req.error ?? new Error('IndexedDB request failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  private async withFallback<T>(idb: () => Promise<T>, mem: (m: MemoryLogoStorage) => Promise<T>): Promise<T> {
    if (this.fallback) return mem(this.fallback);
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no IndexedDB');
      return await idb();
    } catch (e) {
      console.warn('Watermark logos: IndexedDB unavailable, keeping logos for this session only.', e);
      this.fallback = new MemoryLogoStorage();
      return mem(this.fallback);
    }
  }

  get(id: string): Promise<StoredLogo | null> {
    return this.withFallback(
      async () => ((await this.run('readonly', (s) => s.get(id) as IDBRequest<StoredLogo | undefined>)) ?? null),
      (m) => m.get(id),
    );
  }

  list(): Promise<StoredLogo[]> {
    return this.withFallback(
      () => this.run('readonly', (s) => s.getAll() as IDBRequest<StoredLogo[]>),
      (m) => m.list(),
    );
  }

  put(logo: StoredLogo): Promise<void> {
    return this.withFallback(
      async () => {
        await this.run('readwrite', (s) => s.put(logo));
      },
      (m) => m.put(logo),
    );
  }

  delete(id: string): Promise<void> {
    return this.withFallback(
      async () => {
        await this.run('readwrite', (s) => s.delete(id));
      },
      (m) => m.delete(id),
    );
  }
}

export const logoStorage: LogoStorage = new IndexedDbLogoStorage();

/** Checks a picked file, scales it down if it is very large, and stores it. */
export async function importLogo(file: File, storage: LogoStorage = logoStorage): Promise<StoredLogo> {
  const problem = logoFileProblem(file, new Uint8Array(await file.slice(0, 8).arrayBuffer()));
  if (problem) throw new Error(problem);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This PNG could not be read.');
  }
  try {
    let blob: Blob = file;
    let { width, height } = bitmap;
    const scale = Math.min(1, LOGO_LIMITS.maxSide / Math.max(width, height));
    if (scale < 1) {
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('This browser cannot scale the logo.');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, width, height);
      blob = await canvas.convertToBlob({ type: 'image/png' });
    }
    const logo: StoredLogo = { id: newLogoId(), name: file.name || 'logo.png', blob, width, height, addedAt: Date.now() };
    await storage.put(logo);
    return logo;
  } finally {
    bitmap.close();
  }
}

/** The stored logo, decoded for drawing; null when it isn't in this browser (any more). */
export async function loadLogoBitmap(id: string | null, storage: LogoStorage = logoStorage): Promise<ImageBitmap | null> {
  if (!id) return null;
  try {
    const logo = await storage.get(id);
    return logo ? await createImageBitmap(logo.blob) : null;
  } catch (e) {
    console.warn('Could not load the watermark logo', e);
    return null;
  }
}

/**
 * Deletes a logo that was removed or replaced, unless a preset still uses it (`used`: every
 * preset's logo id). Only that one logo: one just added in another tab is never touched.
 */
export async function deleteUnusedLogo(id: string | null, used: Iterable<string | null>, storage: LogoStorage = logoStorage): Promise<boolean> {
  if (!id || [...used].includes(id)) return false;
  await storage.delete(id);
  return true;
}
