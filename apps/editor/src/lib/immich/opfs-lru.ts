// A folder in the browser's private storage (the Origin Private File System) used as a cache:
// its files never add up to more than a limit. A new file pushes out the least recently used ones,
// except the files this page has pinned (the photo being edited); if it still doesn't fit, it isn't
// kept. Everything is best effort. Without OPFS (plain HTTP, some private windows) nothing is
// found and nothing is written.

const INDEX_FILE = 'index.json';

interface CacheEntry {
  size: number;
  lastUsed: number;
}
type CacheIndex = Record<string, CacheEntry>;

/** What can be written: binary parts, written one after another. */
export type CachePart = ArrayBufferView<ArrayBuffer>;

export class OpfsLru {
  /** This page's index updates (read, change, write back) run one after another. */
  private queue: Promise<void> = Promise.resolve();
  /** Files this page keeps until it closes: eviction passes them over. */
  private readonly pinned = new Set<string>();

  constructor(
    private readonly dirName: string,
    private readonly limitBytes: number,
    /** The storage's root folder (tests pass their own). */
    private readonly root: () => Promise<FileSystemDirectoryHandle> = () => navigator.storage.getDirectory(),
  ) {}

  /** The cached file, or null. Marks it as just used, in the background. */
  async read(name: string): Promise<File | null> {
    const dir = await this.dir();
    if (!dir) return null;
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      if (file.size === 0) return null;
      this.touch(dir, name, file.size);
      return file;
    } catch {
      return null;
    }
  }

  /** Whether a file is cached. `touch`: also mark it as just used. */
  async has(name: string, touch = false): Promise<boolean> {
    const dir = await this.dir();
    if (!dir) return false;
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      if (file.size === 0) return false;
      if (touch) this.touch(dir, name, file.size);
      return true;
    } catch {
      return false;
    }
  }

  /** Keeps these files for as long as this page is open (they may not exist yet). */
  pin(...names: string[]): void {
    for (const n of names) this.pinned.add(n);
  }

  /** Lets go of every pinned file (another photo is opened in the page). */
  unpinAll(): void {
    this.pinned.clear();
  }

  /** Bytes a new file may take without pushing out a pinned one. */
  async room(): Promise<number> {
    const dir = await this.dir();
    if (!dir) return 0;
    const index = await readIndex(dir);
    const kept = Object.entries(index).reduce((sum, [n, e]) => sum + (this.pinned.has(n) ? e.size : 0), 0);
    return Math.max(0, this.limitBytes - kept);
  }

  /**
   * Writes a file, then removes the least recently used ones over the limit. A file that doesn't
   * fit even then, or can't be written (quota), is removed again.
   */
  async write(name: string, parts: CachePart[]): Promise<void> {
    const size = parts.reduce((sum, p) => sum + p.byteLength, 0);
    if (size > this.limitBytes) return;
    const dir = await this.dir();
    if (!dir) return;
    try {
      // The browser makes the file visible on close(): a reader never sees half of it.
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      for (const part of parts) await writable.write(part);
      await writable.close();
      let fits = true;
      await this.update(dir, async (index) => {
        index[name] = { size, lastUsed: Date.now() };
        fits = await this.evict(dir, index, name);
        if (!fits) delete index[name];
      });
      if (!fits) await dir.removeEntry(name);
    } catch {
      try {
        await dir.removeEntry(name);
      } catch {
        // nothing to clean up
      }
    }
  }

  async remove(name: string): Promise<void> {
    const dir = await this.dir();
    if (!dir) return;
    try {
      await dir.removeEntry(name);
    } catch {
      // not cached
    }
    try {
      await this.update(dir, (index) => {
        delete index[name];
      });
    } catch {
      // best effort
    }
  }

  private async dir(): Promise<FileSystemDirectoryHandle | null> {
    try {
      return await (await this.root()).getDirectoryHandle(this.dirName, { create: true });
    } catch {
      return null;
    }
  }

  /** Marks a file as just used, so eviction keeps it longest. Nobody waits for it. */
  private touch(dir: FileSystemDirectoryHandle, name: string, size: number): void {
    this.update(dir, (index) => {
      index[name] = { size, lastUsed: Date.now() };
    }).catch(() => {
      // the file still opens; it just keeps its old place in the eviction order
    });
  }

  private update(dir: FileSystemDirectoryHandle, change: (index: CacheIndex) => void | Promise<void>): Promise<void> {
    const run = async () => {
      const index = await readIndex(dir);
      await change(index);
      const writable = await (await dir.getFileHandle(INDEX_FILE, { create: true })).createWritable();
      await writable.write(JSON.stringify(index));
      await writable.close();
    };
    const done = this.queue.then(run, run);
    this.queue = done.catch(() => {});
    return done;
  }

  /**
   * Removes least-recently-used files, except `keep` and the pinned ones, until the folder fits
   * the limit. Changes `index`. False if it still doesn't fit.
   */
  private async evict(dir: FileSystemDirectoryHandle, index: CacheIndex, keep: string): Promise<boolean> {
    let total = Object.values(index).reduce((sum, e) => sum + e.size, 0);
    const oldestFirst = Object.entries(index)
      .filter(([n]) => n !== keep && !this.pinned.has(n))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [n, entry] of oldestFirst) {
      if (total <= this.limitBytes) break;
      try {
        await dir.removeEntry(n);
      } catch {
        // already gone
      }
      delete index[n];
      total -= entry.size;
    }
    return total <= this.limitBytes;
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
