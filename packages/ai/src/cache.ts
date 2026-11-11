// A small IndexedDB store for model files and per-photo analyses, least recently used out
// first. IndexedDB also works on plain HTTP, where the Cache API doesn't, so models download
// once per browser in both setups. Every call fails soft: no storage = no caching.

export type StoreName = 'models' | 'analyses';

/** Bookkeeping kept apart from the values, so touching a 200 MB model doesn't rewrite it. */
interface Meta {
  store: StoreName;
  key: string;
  size: number;
  used: number;
}

const DB = 'raw-editor-ai';
const VERSION = 1;
/** Bytes each store may hold before the least recently used entries go. */
const CAPS: Record<StoreName, number> = { models: 1.5e9, analyses: 4e8 };

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => {
        for (const name of ['models', 'analyses', 'meta']) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const metaKey = (store: StoreName, key: string) => `${store}|${key}`;

export async function cacheGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  try {
    const db = await open();
    if (!db) return undefined;
    const value = (await done(db.transaction(store).objectStore(store).get(key))) as T | undefined;
    if (value === undefined) return undefined;
    const meta = db.transaction('meta', 'readwrite').objectStore('meta');
    const m = (await done(meta.get(metaKey(store, key)))) as Meta | undefined;
    if (m) meta.put({ ...m, used: Date.now() }, metaKey(store, key));
    return value;
  } catch {
    return undefined;
  }
}

export async function cacheHas(store: StoreName, key: string): Promise<boolean> {
  try {
    const db = await open();
    if (!db) return false;
    return (await done(db.transaction(store).objectStore(store).count(key))) > 0;
  } catch {
    return false;
  }
}

export async function cachePut<T>(store: StoreName, key: string, value: T, size: number): Promise<void> {
  try {
    const db = await open();
    if (!db) return;
    const tx = db.transaction([store, 'meta'], 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.objectStore('meta').put({ store, key, size, used: Date.now() } satisfies Meta, metaKey(store, key));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    await evict(db, store);
  } catch {
    // Storage full or unavailable: the next run computes again.
  }
}

async function evict(db: IDBDatabase, store: StoreName): Promise<void> {
  const metas = ((await done(db.transaction('meta').objectStore('meta').getAll())) as Meta[]).filter((m) => m.store === store);
  let total = metas.reduce((n, m) => n + m.size, 0);
  if (total <= CAPS[store]) return;
  metas.sort((a, b) => a.used - b.used);
  const tx = db.transaction([store, 'meta'], 'readwrite');
  for (const m of metas) {
    if (total <= CAPS[store]) break;
    tx.objectStore(store).delete(m.key);
    tx.objectStore('meta').delete(metaKey(store, m.key));
    total -= m.size;
  }
}
