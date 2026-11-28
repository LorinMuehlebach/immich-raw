import { describe, expect, it } from 'vitest';
import type { StripItem } from './cull-view.ts';
import { NO_FACTS, NO_FILTER, compareCandidate, factBadges, factsText, filterStrip, jumpTarget, normalizeFilter, passes, stripNeighbours, type PhotoFacts } from './strip-view.ts';

/** a, [s1 s2 s3] (a stack), b, [t1 t2], c */
function strip(): StripItem<{ id: string }>[] {
  const single = (id: string) => ({ asset: { id }, info: null, group: null });
  const stack = (gid: string, ids: string[]) =>
    ids.map((id, i) => ({ asset: { id }, info: null, group: { id: gid, size: ids.length, index: i, first: i === 0, last: i === ids.length - 1, hidden: 0, collapsed: false } }));
  return [single('a'), ...stack('S', ['s1', 's2', 's3']), single('b'), ...stack('T', ['t1', 't2']), single('c')];
}
const ids = (s: StripItem<{ id: string }>[]) => s.map((x) => x.asset.id);
const idx = (id: string) => ids(strip()).indexOf(id);

describe('jumpTarget (↑ ↓)', () => {
  it('goes past the rest of the stack to the next stack or photo', () => {
    expect(jumpTarget(strip(), idx('s1'), 1)).toBe('b');
    expect(jumpTarget(strip(), idx('s2'), 1)).toBe('b');
    expect(jumpTarget(strip(), idx('a'), 1)).toBe('s1');
    expect(jumpTarget(strip(), idx('b'), 1)).toBe('t1');
  });

  it("goes back to the previous stack's first photo", () => {
    expect(jumpTarget(strip(), idx('b'), -1)).toBe('s1');
    expect(jumpTarget(strip(), idx('t2'), -1)).toBe('b');
    expect(jumpTarget(strip(), idx('c'), -1)).toBe('t1');
    expect(jumpTarget(strip(), idx('s3'), -1)).toBe('a');
  });

  it('stops at the ends', () => {
    expect(jumpTarget(strip(), idx('a'), -1)).toBeNull();
    expect(jumpTarget(strip(), idx('c'), 1)).toBeNull();
    expect(jumpTarget(strip(), idx('t1'), 1)).toBe('c');
  });
});

describe('stripNeighbours', () => {
  it('gives ← → ↑ ↓ and the photos to get ready, nearest first', () => {
    expect(stripNeighbours(strip(), idx('s2'))).toMatchObject({ prev: 's1', next: 's3', prevStack: 'a', nextStack: 'b', nearby: ['s3', 's1', 'b', 'a'] });
    expect(stripNeighbours(strip(), idx('s2')).order).toEqual(ids(strip()));
    expect(stripNeighbours(strip(), -1)).toMatchObject({ prev: null, next: null, prevStack: null, nextStack: null, nearby: [] });
  });
});

describe('compareCandidate', () => {
  const n = { ...stripNeighbours(strip(), idx('b')), stack: [] as string[] };

  it('starts with the next photo, and steps along the filmstrip past the open one', () => {
    expect(compareCandidate(n, 'b', null, 1)).toBe('t1');
    expect(compareCandidate(n, 'b', null, -1)).toBe('s3');
    expect(compareCandidate(n, 'b', 's3', 1)).toBe('t1');
    expect(compareCandidate(n, 'b', 'c', 1)).toBe('a');
  });

  it("stays within the open photo's stack", () => {
    const inStack = { ...n, stack: ['s2', 's1', 's3'] };
    expect(compareCandidate(inStack, 's1', null, 1)).toBe('s2');
    expect(compareCandidate(inStack, 's1', 's2', 1)).toBe('s3');
    expect(compareCandidate(inStack, 's1', 's3', 1)).toBe('s2');
    expect(compareCandidate(inStack, 's1', 's2', -1)).toBe('s3');
  });

  it('has nothing to compare with in a filmstrip of one', () => {
    expect(compareCandidate({ order: ['a'], stack: [], next: null, prev: null }, 'a', null, 1)).toBeNull();
  });
});

describe('filters', () => {
  const facts: Record<string, Partial<PhotoFacts>> = {
    a: { rating: 3 },
    s1: { favorite: true, rating: 5 },
    s2: { rejected: true },
    s3: { edited: true },
    b: { draft: true },
    t1: { edited: false },
  };
  const of = (id: string): PhotoFacts => ({ ...NO_FACTS, ...facts[id] });

  it('lets photos through by stars, favourite, reject and edits', () => {
    expect(passes({ ...NO_FILTER, minRating: 3 }, of('a'))).toBe(true);
    expect(passes({ ...NO_FILTER, minRating: 4 }, of('a'))).toBe(false);
    expect(passes({ ...NO_FILTER, favorites: true }, of('s1'))).toBe(true);
    expect(passes({ ...NO_FILTER, hideRejected: true }, of('s2'))).toBe(false);
    expect(passes({ ...NO_FILTER, edits: 'edited' }, of('s3'))).toBe(true);
    expect(passes({ ...NO_FILTER, edits: 'edited' }, of('t1'))).toBe(false);
    expect(passes({ ...NO_FILTER, edits: 'unedited' }, of('b'))).toBe(false);
    expect(passes({ ...NO_FILTER, edits: 'draft' }, of('b'))).toBe(true);
    // Not known yet: shown until it is.
    expect(passes({ ...NO_FILTER, edits: 'edited' }, of('c'))).toBe(true);
    expect(passes({ ...NO_FILTER, edits: 'unedited' }, of('c'))).toBe(true);
  });

  it('keeps the open photo, and the line under what is left of a stack', () => {
    const kept = filterStrip(strip(), { ...NO_FILTER, hideRejected: true, edits: 'unedited' }, of, 's1');
    expect(ids(kept)).toEqual(['a', 's1', 't1', 't2', 'c']);
    const s1 = kept.find((x) => x.asset.id === 's1')!;
    expect([s1.group?.first, s1.group?.last]).toEqual([true, true]);
  });

  it('returns the strip as it is without a filter', () => {
    const s = strip();
    expect(filterStrip(s, NO_FILTER, of, 'a')).toBe(s);
  });

  it('reads a stored filter, dropping what makes no sense', () => {
    expect(normalizeFilter({ minRating: 9, favorites: true, edits: 'x' })).toEqual({ minRating: 5, favorites: true, hideRejected: false, edits: 'any' });
    expect(normalizeFilter(null)).toEqual(NO_FILTER);
  });
});

describe('badges', () => {
  it('marks reject, favourite, stars and a draft (over edited)', () => {
    expect(factBadges({ ...NO_FACTS, rejected: true, favorite: true, rating: 2, edited: true, draft: true }).map((b) => b.icon)).toEqual(['✕', '♥', '2★', '●']);
    expect(factBadges({ ...NO_FACTS, edited: true }).map((b) => b.tone)).toEqual(['edited']);
    expect(factsText({ ...NO_FACTS, favorite: true, rating: 3 })).toBe('♥ ★★★');
  });
});
