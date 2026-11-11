// Develop presets, stored in this browser (IndexedDB). Immich has no per-user storage the
// editor could use, so presets travel between browsers via JSON export/import.
import { applyPatch, patchGroups, pickGroups, type GroupId, type Recipe, type SettingsPatch } from '@immich-raw/recipe';
import { newId } from '../id.ts';

export const DEFAULT_FOLDER = 'User Presets';
export const LIGHTROOM_FOLDER = 'Lightroom Presets';
const EXPORT_FORMAT = 'immich-raw-presets';

export interface Preset {
  id: string;
  name: string;
  /** Folder shown in the Presets panel. */
  group: string;
  patch: SettingsPatch;
  groups: GroupId[];
  createdAt: string;
  source: 'user' | 'lightroom' | 'import';
}

export interface PresetStorage {
  list(): Promise<Preset[]>;
  put(p: Preset): Promise<void>;
  delete(id: string): Promise<void>;
}

export type XmpParser = (text: string, filename: string) => { name: string; patch: SettingsPatch } | null;

export interface ImportResult {
  imported: Preset[];
  failed: { file: string; reason: string }[];
}

export class MemoryPresetStorage implements PresetStorage {
  private items = new Map<string, Preset>();

  async list(): Promise<Preset[]> {
    return [...this.items.values()].map((p) => structuredClone(p));
  }

  async put(p: Preset): Promise<void> {
    this.items.set(p.id, structuredClone(p));
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }
}

/** IndexedDB storage; if IndexedDB is missing or blocked it quietly keeps presets in memory. */
export class IndexedDbPresetStorage implements PresetStorage {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private fallback: MemoryPresetStorage | null = null;

  constructor(
    private readonly dbName = 'raw-editor',
    private readonly storeName = 'presets',
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

  private async withFallback<T>(idb: () => Promise<T>, mem: (m: MemoryPresetStorage) => Promise<T>): Promise<T> {
    if (this.fallback) return mem(this.fallback);
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no IndexedDB');
      return await idb();
    } catch (e) {
      console.warn('Presets: IndexedDB unavailable, keeping presets for this session only.', e);
      this.fallback = new MemoryPresetStorage();
      return mem(this.fallback);
    }
  }

  list(): Promise<Preset[]> {
    return this.withFallback(
      () => this.run('readonly', (s) => s.getAll() as IDBRequest<Preset[]>),
      (m) => m.list(),
    );
  }

  put(p: Preset): Promise<void> {
    return this.withFallback(
      async () => {
        await this.run('readwrite', (s) => s.put(structuredClone(p)));
      },
      (m) => m.put(p),
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

/** Keeps only the recipe paths the setting groups know about. */
export function sanitizePatch(patch: unknown): SettingsPatch {
  if (!patch || typeof patch !== 'object') return {};
  return applyPatch({} as Recipe, patch as SettingsPatch) as unknown as SettingsPatch;
}

const baseName = (filename: string) => filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || filename;

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export class PresetStore {
  constructor(private readonly storage: PresetStorage = new IndexedDbPresetStorage()) {}

  /** All presets, sorted by folder then name. */
  async list(): Promise<Preset[]> {
    const all = await this.storage.list();
    return all.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  async create(name: string, recipe: Recipe, groups: readonly GroupId[], group = DEFAULT_FOLDER): Promise<Preset> {
    const patch = pickGroups(recipe, groups);
    const preset: Preset = {
      id: newId(),
      name: name.trim() || 'Untitled preset',
      group: group.trim() || DEFAULT_FOLDER,
      patch,
      groups: patchGroups(patch),
      createdAt: new Date().toISOString(),
      source: 'user',
    };
    await this.storage.put(preset);
    return preset;
  }

  async rename(id: string, name: string): Promise<Preset | null> {
    const p = (await this.storage.list()).find((x) => x.id === id);
    if (!p || !name.trim()) return null;
    p.name = name.trim();
    await this.storage.put(p);
    return p;
  }

  async remove(id: string): Promise<void> {
    await this.storage.delete(id);
  }

  /** Imports our JSON export (wrapper, array or single preset) and, with a parser, Lightroom .xmp presets. */
  async importFiles(files: File[], parseXmp?: XmpParser): Promise<ImportResult> {
    const result: ImportResult = { imported: [], failed: [] };
    for (const file of files) {
      const fail = (reason: string) => result.failed.push({ file: file.name, reason });
      let text: string;
      try {
        text = await file.text();
      } catch {
        fail('could not read the file');
        continue;
      }
      const ext = file.name.toLowerCase().split('.').pop();
      if (ext === 'xmp') {
        if (!parseXmp) {
          fail('XMP import is not available');
          continue;
        }
        let parsed: ReturnType<XmpParser>;
        try {
          parsed = parseXmp(text, file.name);
        } catch (e) {
          fail(e instanceof Error ? e.message : 'not a valid XMP file');
          continue;
        }
        const patch = sanitizePatch(parsed?.patch);
        if (!parsed || !Object.keys(patch).length) {
          fail('no develop settings found');
          continue;
        }
        result.imported.push(await this.add({ name: parsed.name || baseName(file.name), group: LIGHTROOM_FOLDER, patch, source: 'lightroom' }));
        continue;
      }
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        fail(ext === 'json' ? 'not valid JSON' : 'unsupported file type (use .json or .xmp)');
        continue;
      }
      const entries = isObject(data) && Array.isArray(data.presets) ? data.presets : Array.isArray(data) ? data : [data];
      let added = 0;
      for (const entry of entries) {
        if (!isObject(entry) || typeof entry.name !== 'string') continue;
        const patch = sanitizePatch(entry.patch);
        if (!Object.keys(patch).length) continue;
        result.imported.push(
          await this.add({
            name: entry.name,
            group: typeof entry.group === 'string' && entry.group.trim() ? entry.group : DEFAULT_FOLDER,
            patch,
            source: 'import',
          }),
        );
        added++;
      }
      if (!added) fail('no presets found');
    }
    return result;
  }

  private async add(p: Pick<Preset, 'name' | 'group' | 'patch' | 'source'>): Promise<Preset> {
    const preset: Preset = {
      id: newId(),
      name: p.name.trim() || 'Untitled preset',
      group: p.group,
      patch: p.patch,
      groups: patchGroups(p.patch),
      createdAt: new Date().toISOString(),
      source: p.source,
    };
    await this.storage.put(preset);
    return preset;
  }

  exportJson(presets: readonly Preset[]): Blob {
    const payload = {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      presets: presets.map(({ name, group, patch, groups, createdAt }) => ({ name, group, patch, groups, createdAt })),
    };
    return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  }
}

/** Folder names in display order. */
export function presetFolders(presets: readonly Preset[]): string[] {
  const set = new Set(presets.map((p) => p.group));
  set.add(DEFAULT_FOLDER);
  return [...set].sort((a, b) => (a === DEFAULT_FOLDER ? -1 : b === DEFAULT_FOLDER ? 1 : a.localeCompare(b)));
}
