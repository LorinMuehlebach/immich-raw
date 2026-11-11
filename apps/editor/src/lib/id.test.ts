import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from './id.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newId', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses crypto.randomUUID where it exists', () => {
    expect(newId()).toMatch(UUID);
  });

  it('builds a UUID without randomUUID (plain HTTP pages)', () => {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal('crypto', { getRandomValues });
    const ids = new Set(Array.from({ length: 200 }, newId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(UUID);
  });

  it('still works without any crypto', () => {
    vi.stubGlobal('crypto', undefined);
    expect(newId()).toMatch(UUID);
  });
});
