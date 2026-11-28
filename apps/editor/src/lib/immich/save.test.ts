import { describe, expect, it } from 'vitest';
import { renderFilename, tagIdsOf } from './save.ts';

describe('tagIdsOf', () => {
  it("takes every one of the RAW's tags, the culler's included, once", () => {
    const tags = [
      { id: 't1', value: 'Travel' },
      { id: 't2', value: 'Culling/Best' },
      { id: 't3', value: 'Places/Asia/Shanghai' },
      { id: 't1', value: 'Travel' },
    ];
    expect(tagIdsOf({ tags } as Parameters<typeof tagIdsOf>[0])).toEqual(['t1', 't2', 't3']);
  });

  it('is empty without tags', () => {
    expect(tagIdsOf({ tags: [] })).toEqual([]);
    expect(tagIdsOf({})).toEqual([]);
  });
});

describe('renderFilename', () => {
  it('names the render after the RAW', () => {
    expect(renderFilename('DSC01234.ARW')).toBe('DSC01234.edit.jpg');
    expect(renderFilename('noext')).toBe('noext.edit.jpg');
  });
});
