import { describe, expect, it } from 'vitest';
import { HANDOFF_MAX_AGE_MS, HANDOFF_PREFIX, exportPageUrl, newHandoffKey, parseHandoff, staleHandoffKeys } from './handoff.ts';

const A = '1801b1cb-a19e-4e11-95f0-1324647e05c2';
const B = '5F545228-F581-46FA-AA2D-B117D3CD4047';

describe('handoff', () => {
  it('builds the export page URL', () => {
    expect(exportPageUrl('/immich-raw/', 'abc')).toBe('/immich-raw/?export=abc');
    expect(exportPageUrl('/immich-raw/?x=1', 'abc')).toBe('/immich-raw/?x=1&export=abc');
  });

  it('makes random hex keys', () => {
    const k = newHandoffKey();
    expect(k).toMatch(/^[0-9a-f]{18}$/);
    expect(newHandoffKey()).not.toBe(k);
  });

  it('reads a handoff, keeping valid unique ids', () => {
    const h = parseHandoff({ ids: [A, B, A.toUpperCase(), 'nope', 3], context: 'album:x', expected: 4, returnPath: '/albums/x', createdAt: 5 });
    expect(h).toEqual({ ids: [A, B.toLowerCase()], context: 'album:x', expected: 4, returnPath: '/albums/x', createdAt: 5 });
  });

  it('falls back for missing or unsafe fields', () => {
    expect(parseHandoff(null)).toBeNull();
    expect(parseHandoff({ ids: 'x' })).toBeNull();
    expect(parseHandoff({ ids: [A], returnPath: '//evil.example' })).toEqual({ ids: [A], context: 'timeline', expected: 1, returnPath: '/', createdAt: 0 });
  });

  it('finds old and broken handoffs to remove', () => {
    const now = 10 * HANDOFF_MAX_AGE_MS;
    const fresh = JSON.stringify({ ids: [A], createdAt: now - 1000 });
    const old = JSON.stringify({ ids: [A], createdAt: now - HANDOFF_MAX_AGE_MS - 1 });
    const keys = staleHandoffKeys(
      [
        [`${HANDOFF_PREFIX}fresh`, fresh],
        [`${HANDOFF_PREFIX}old`, old],
        [`${HANDOFF_PREFIX}broken`, '{'],
        ['raw-editor.export', old],
      ],
      now,
    );
    expect(keys).toEqual([`${HANDOFF_PREFIX}old`, `${HANDOFF_PREFIX}broken`]);
  });
});
