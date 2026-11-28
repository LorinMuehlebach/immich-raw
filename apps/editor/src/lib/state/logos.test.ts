import { describe, expect, it } from 'vitest';
import { LOGO_LIMITS, MemoryLogoStorage, deleteUnusedLogo, logoFileProblem, newLogoId, type StoredLogo } from './logos.ts';

const PNG_HEAD = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const logo = (id: string): StoredLogo => ({ id, name: `${id}.png`, blob: new Blob([PNG_HEAD]), width: 10, height: 5, addedAt: 1 });

describe('logoFileProblem', () => {
  it('takes PNGs up to the size limit', () => {
    expect(logoFileProblem({ size: 1000 }, PNG_HEAD)).toBeNull();
    expect(logoFileProblem({ size: LOGO_LIMITS.maxBytes }, PNG_HEAD)).toBeNull();
  });

  it('refuses other files and very large ones', () => {
    expect(logoFileProblem({ size: 1000 }, Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0))).toMatch(/PNG/);
    expect(logoFileProblem({ size: 1000 }, PNG_HEAD.subarray(0, 4))).toMatch(/PNG/);
    expect(logoFileProblem({ size: LOGO_LIMITS.maxBytes + 1 }, PNG_HEAD)).toMatch(/16 MB/);
  });
});

describe('logo ids', () => {
  it('are unique and fit what the export settings accept', () => {
    const ids = new Set(Array.from({ length: 50 }, newLogoId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[\w-]{1,64}$/);
  });
});

describe('logo storage', () => {
  it('stores, lists and deletes', async () => {
    const s = new MemoryLogoStorage();
    await s.put(logo('a'));
    await s.put(logo('b'));
    expect((await s.get('a'))?.name).toBe('a.png');
    expect(await s.get('x')).toBeNull();
    expect((await s.list()).map((l) => l.id).sort()).toEqual(['a', 'b']);
    await s.delete('a');
    expect(await s.get('a')).toBeNull();
  });

  it('deletes a removed logo only when no preset still uses it', async () => {
    const s = new MemoryLogoStorage();
    await s.put(logo('a'));
    await s.put(logo('b'));
    expect(await deleteUnusedLogo('a', ['a', null, 'b'], s)).toBe(false);
    expect(await deleteUnusedLogo('a', [null, null, 'b'], s)).toBe(true);
    expect(await deleteUnusedLogo(null, [], s)).toBe(false);
    expect((await s.list()).map((l) => l.id)).toEqual(['b']);
  });
});
