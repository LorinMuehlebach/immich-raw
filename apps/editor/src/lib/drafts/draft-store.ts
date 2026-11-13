// Drafts: unsaved edits kept in this browser, one per photo (and per virtual copy of it), so
// switching to another photo or leaving the editor never has to ask. A photo with a draft opens
// with the draft instead of its saved edit, until the draft is saved or discarded. The draft
// remembers which saved edit it was made from, so a newer save (another tab or device) can be
// pointed out when the photo opens. Kept in IndexedDB; in memory only, when the browser has none.
import { applyPatch, type Recipe, type SettingsPatch } from '@immich-raw/recipe';
import { editable, editableJson } from '../state/history.ts';

export interface Draft {
  key: string;
  assetId: string;
  /** The virtual copy it is a draft of, null for the original edit. */
  copyId: string | null;
  recipe: Recipe;
  /** The saved edit it was made from (savedShows()). */
  base: string;
  /** When it was last written (ms since 1970). */
  updatedAt: number;
  /** A small picture of it for the filmstrip (JPEG), if one could be taken. */
  thumb?: Blob;
  /**
   * Only these settings (Sync Settings on a photo without a saved edit, whose starting settings
   * aren't known until it opens): they go on top of its defaults then.
   */
  patch?: SettingsPatch;
}

export const draftKey = (assetId: string, copyId: string | null): string => `${assetId}|${copyId ?? ''}`;

/** What a photo's saved edit is, for comparing: its edited fields, or 'unedited' when it has none. */
export const savedShows = (stored: Recipe | null): string => (stored ? editableJson(stored) : 'unedited');

/** The saved edit (or the photo's defaults) with the draft's edits on top; bookkeeping stays the saved one's. */
export function withDraft(base: Recipe, draft: Pick<Draft, 'recipe' | 'patch'>): Recipe {
  if (draft.patch) return applyPatch(structuredClone(base), draft.patch);
  return { ...structuredClone(base), ...structuredClone(editable(draft.recipe)) };
}

export interface DraftBackend {
  all(): Promise<Draft[]>;
  get(key: string): Promise<Draft | undefined>;
  put(draft: Draft): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryDraftBackend implements DraftBackend {
  private items = new Map<string, Draft>();

  async all(): Promise<Draft[]> {
    return [...this.items.values()].map((d) => structuredClone(d));
  }

  async get(key: string): Promise<Draft | undefined> {
    const d = this.items.get(key);
    return d && structuredClone(d);
  }

  async put(draft: Draft): Promise<void> {
    this.items.set(draft.key, structuredClone(draft));
  }

  async delete(key: string): Promise<void> {
    this.items.delete(key);
  }
}

/** IndexedDB, falling back to memory (this page only) when it is missing or blocked. */
export class IndexedDbDraftBackend implements DraftBackend {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private fallback: MemoryDraftBackend | null = null;

  constructor(
    private readonly dbName = 'raw-editor-drafts',
    private readonly storeName = 'drafts',
  ) {}

  private open(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(this.storeName)) req.result.createObjectStore(this.storeName, { keyPath: 'key' });
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

  private async withFallback<T>(idb: () => Promise<T>, mem: (m: MemoryDraftBackend) => Promise<T>): Promise<T> {
    if (this.fallback) return mem(this.fallback);
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no IndexedDB');
      return await idb();
    } catch (e) {
      console.warn('Drafts: IndexedDB unavailable, keeping drafts for this page only.', e);
      this.fallback = new MemoryDraftBackend();
      return mem(this.fallback);
    }
  }

  all(): Promise<Draft[]> {
    return this.withFallback(
      () => this.run('readonly', (s) => s.getAll() as IDBRequest<Draft[]>),
      (m) => m.all(),
    );
  }

  get(key: string): Promise<Draft | undefined> {
    return this.withFallback(
      () => this.run('readonly', (s) => s.get(key) as IDBRequest<Draft | undefined>),
      (m) => m.get(key),
    );
  }

  put(draft: Draft): Promise<void> {
    return this.withFallback(
      async () => {
        await this.run('readwrite', (s) => s.put(draft));
      },
      (m) => m.put(draft),
    );
  }

  delete(key: string): Promise<void> {
    return this.withFallback(
      async () => {
        await this.run('readwrite', (s) => s.delete(key));
      },
      (m) => m.delete(key),
    );
  }
}

/** The drafts, and which photos have one (for the filmstrip). */
export class DraftStore {
  /** Draft keys per photo. */
  private keys = new Map<string, Set<string>>();
  private loaded: Promise<void> | null = null;
  private listeners = new Set<(photos: ReadonlySet<string>) => void>();
  private writes = 0;

  constructor(private readonly backend: DraftBackend) {}

  /** Writes not finished yet (leaving the page should wait for them). */
  get pending(): number {
    return this.writes;
  }

  /** Called with the photos that have a draft, now and whenever that changes. */
  onChange(listener: (photos: ReadonlySet<string>) => void): () => void {
    this.listeners.add(listener);
    void this.load().then(() => listener(this.photos()));
    return () => this.listeners.delete(listener);
  }

  /** Photos with a draft of their original edit or of a copy. */
  photos(): ReadonlySet<string> {
    return new Set(this.keys.keys());
  }

  load(): Promise<void> {
    this.loaded ??= this.backend.all().then(
      (all) => {
        for (const d of all) this.note(d.assetId, d.key, true);
      },
      () => {},
    );
    return this.loaded;
  }

  async get(assetId: string, copyId: string | null): Promise<Draft | null> {
    return (await this.backend.get(draftKey(assetId, copyId)).catch(() => undefined)) ?? null;
  }

  /** Every draft, newest first. */
  async list(): Promise<Draft[]> {
    const all = await this.backend.all().catch(() => []);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async put(draft: Omit<Draft, 'key'>): Promise<void> {
    const key = draftKey(draft.assetId, draft.copyId);
    await this.track(() => this.backend.put({ ...draft, key }));
    await this.load();
    this.note(draft.assetId, key, true);
  }

  async remove(assetId: string, copyId: string | null): Promise<void> {
    const key = draftKey(assetId, copyId);
    await this.track(() => this.backend.delete(key));
    await this.load();
    this.note(assetId, key, false);
  }

  private async track(write: () => Promise<void>): Promise<void> {
    this.writes++;
    try {
      await write();
    } finally {
      this.writes--;
    }
  }

  private note(assetId: string, key: string, has: boolean): void {
    const keys = this.keys.get(assetId) ?? new Set<string>();
    const before = this.keys.has(assetId);
    if (has) keys.add(key);
    else keys.delete(key);
    if (keys.size) this.keys.set(assetId, keys);
    else this.keys.delete(assetId);
    if (before !== this.keys.has(assetId)) for (const l of this.listeners) l(this.photos());
  }
}
