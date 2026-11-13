import { describe, expect, it } from 'vitest';
import { applyFlag, flagged, rejectTagIds, shotFileIds, type FlagDeps } from './shot-flags.ts';
import { NO_FACTS, type PhotoFacts } from './strip-view.ts';

const file = (id: string, originalFileName: string, isTrashed = false) => ({ id, originalFileName, isTrashed });

describe('shotFileIds', () => {
  it("finds the RAW's camera JPEG and edits in a stack of several shots", () => {
    const stack = [file('r1', 'DSCF7815.RAF'), file('j1', 'DSCF7815.JPG'), file('e1', 'DSCF7815.edit.jpg'), file('c1', 'DSCF7815.copy-2.edit.jpg'), file('r2', 'DSCF7816.RAF'), file('x', 'DSCF78150.RAF'), file('t', 'DSCF7815.old.edit.jpg', true)];
    expect(shotFileIds(stack[0]!, stack)).toEqual(['r1', 'j1', 'e1', 'c1']);
  });
});

describe('rejectTagIds', () => {
  it('takes the manual reject and the culler\'s, under the same root only', () => {
    const tags = [
      { id: '1', value: 'Culling/Rejected' },
      { id: '2', value: 'Culling/Rejected/Blur' },
      { id: '3', value: 'Culling/Best' },
      { id: '4', value: 'Other/Rejected' },
      { id: '5', value: 'Culling/RejectedNot' },
    ];
    expect(rejectTagIds('Culling', tags)).toEqual(['1', '2']);
  });
});

describe('flagged', () => {
  it('pick and reject leave each other out, clear leaves neither', () => {
    const p: PhotoFacts = { ...NO_FACTS, rating: 2 };
    expect(flagged({ kind: 'reject' }, { ...p, favorite: true })).toMatchObject({ favorite: false, rejected: true, rating: 2 });
    expect(flagged({ kind: 'pick' }, { ...p, rejected: true })).toMatchObject({ favorite: true, rejected: false });
    expect(flagged({ kind: 'clear' }, { ...p, favorite: true, rejected: true })).toMatchObject({ favorite: false, rejected: false, rating: 2 });
    expect(flagged({ kind: 'rate', rating: 0 }, p).rating).toBeNull();
  });
});

function fakeImmich() {
  const calls: string[] = [];
  const d: FlagDeps = {
    files: async (id) => [id, `${id}.jpg`],
    update: async (ids, patch) => void calls.push(`update ${ids.join(',')} ${JSON.stringify(patch)}`),
    rejectTag: async () => 'rej',
    rejectTags: async () => ['rej', 'rej-blur'],
    tag: async (t, ids) => void calls.push(`tag ${t} ${ids.join(',')}`),
    untag: async (t, ids) => void calls.push(`untag ${t} ${ids.join(',')}`),
  };
  return { d, calls };
}

describe('applyFlag', () => {
  const facts = (id: string): PhotoFacts => ({ ...NO_FACTS, rating: id === 'b' ? 3 : null });

  it('rates every file of every shot', async () => {
    const { d, calls } = fakeImmich();
    await applyFlag(['a', 'b'], { kind: 'rate', rating: 4 }, facts, d);
    expect(calls).toEqual(['update a,a.jpg,b,b.jpg {"rating":4}']);
  });

  it('rejects: no favourite, -1 only where there are no stars, and the tag', async () => {
    const { d, calls } = fakeImmich();
    await applyFlag(['a', 'b'], { kind: 'reject' }, facts, d);
    expect(calls).toEqual(['update a,a.jpg,b,b.jpg {"isFavorite":false}', 'update a,a.jpg {"rating":-1}', 'tag rej a,a.jpg,b,b.jpg']);
  });

  it('pick and clear take every reject tag off', async () => {
    const { d, calls } = fakeImmich();
    await applyFlag(['a'], { kind: 'pick' }, facts, d);
    await applyFlag(['a'], { kind: 'clear' }, facts, d);
    expect(calls).toEqual([
      'update a,a.jpg {"isFavorite":true}',
      'untag rej a,a.jpg',
      'untag rej-blur a,a.jpg',
      'update a,a.jpg {"isFavorite":false}',
      'untag rej a,a.jpg',
      'untag rej-blur a,a.jpg',
    ]);
  });
});
