import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpfsLru } from './opfs-lru.ts';

/** An in-memory stand-in for an OPFS folder: files become visible on close(), like the browser's. */
class FakeDir {
  files = new Map<string, Uint8Array>();
  failWrites = false;

  async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!opts?.create) throw new DOMException('not found', 'NotFoundError');
      this.files.set(name, new Uint8Array(0));
    }
    return {
      getFile: async () => {
        const bytes = this.files.get(name);
        if (!bytes) throw new DOMException('not found', 'NotFoundError');
        return new File([bytes as Uint8Array<ArrayBuffer>], name);
      },
      createWritable: async () => {
        const chunks: Uint8Array[] = [];
        return {
          write: async (chunk: string | ArrayBufferView) => {
            if (this.failWrites) throw new DOMException('quota', 'QuotaExceededError');
            chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice());
          },
          close: async () => {
            const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
            let at = 0;
            for (const c of chunks) {
              out.set(c, at);
              at += c.length;
            }
            this.files.set(name, out);
          },
        };
      },
    };
  }

  async removeEntry(name: string) {
    if (!this.files.delete(name)) throw new DOMException('not found', 'NotFoundError');
  }

  index(): Record<string, { size: number }> {
    const raw = this.files.get('index.json');
    return raw ? JSON.parse(new TextDecoder().decode(raw)) : {};
  }
}

const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill) as Uint8Array<ArrayBuffer>;

describe('OpfsLru', () => {
  let dir: FakeDir;
  let cache: OpfsLru;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    dir = new FakeDir();
    const root = { getDirectoryHandle: async () => dir } as unknown as FileSystemDirectoryHandle;
    cache = new OpfsLru('test', 10, async () => root);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads back what it wrote', async () => {
    await cache.write('a', [bytes(4, 7)]);
    const file = await cache.read('a');
    expect(new Uint8Array(await file!.arrayBuffer())).toEqual(bytes(4, 7));
    expect(await cache.has('a')).toBe(true);
    expect(await cache.read('b')).toBeNull();
    expect(dir.index()).toMatchObject({ a: { size: 4 } });
  });

  it('writes the parts one after another', async () => {
    await cache.write('a', [bytes(2, 1), new Uint16Array([0x0302]) as Uint16Array<ArrayBuffer>]);
    expect(dir.files.get('a')).toEqual(new Uint8Array([1, 1, 2, 3]));
  });

  it('removes the least recently used files over the limit', async () => {
    await cache.write('a', [bytes(4)]);
    vi.setSystemTime(1_000_100);
    await cache.write('b', [bytes(4)]);
    vi.setSystemTime(1_000_200);
    // Opening "a" makes "b" the oldest.
    await cache.read('a');
    vi.setSystemTime(1_000_300);
    await cache.write('c', [bytes(4)]);
    expect([...dir.files.keys()].filter((n) => n !== 'index.json').sort()).toEqual(['a', 'c']);
    expect(Object.keys(dir.index()).sort()).toEqual(['a', 'c']);
  });

  it('never goes over the limit: a file bigger than the limit is not kept', async () => {
    await cache.write('a', [bytes(4)]);
    await cache.write('big', [bytes(20)]);
    expect(await cache.has('big')).toBe(false);
    expect(await cache.has('a')).toBe(true);
  });

  it('passes over pinned files, and drops a new file that only fits by removing them', async () => {
    cache.pin('a');
    await cache.write('a', [bytes(4)]);
    vi.setSystemTime(1_000_100);
    await cache.write('b', [bytes(4)]);
    vi.setSystemTime(1_000_200);
    // "a" is the oldest but pinned: "b" goes.
    await cache.write('c', [bytes(4)]);
    expect(await cache.has('a')).toBe(true);
    expect(await cache.has('b')).toBe(false);
    expect(await cache.has('c')).toBe(true);
    cache.pin('c');
    expect(await cache.room()).toBe(2);
    // Only the pinned files are left to remove: the new one isn't kept.
    await cache.write('d', [bytes(4)]);
    expect(await cache.has('d')).toBe(false);
    expect(dir.files.has('d')).toBe(false);
    expect(Object.keys(dir.index()).sort()).toEqual(['a', 'c']);
  });

  it('leaves nothing behind when a write fails', async () => {
    dir.failWrites = true;
    await cache.write('a', [bytes(4)]);
    expect(dir.files.has('a')).toBe(false);
    expect(await cache.read('a')).toBeNull();
  });

  it('forgets a removed file', async () => {
    await cache.write('a', [bytes(4)]);
    await cache.remove('a');
    expect(await cache.has('a')).toBe(false);
    expect(dir.index()).toEqual({});
  });

  it('finds nothing and writes nothing without OPFS', async () => {
    const none = new OpfsLru('test', 10, () => Promise.reject(new Error('no OPFS')));
    await none.write('a', [bytes(4)]);
    expect(await none.read('a')).toBeNull();
    expect(await none.has('a')).toBe(false);
  });
});
