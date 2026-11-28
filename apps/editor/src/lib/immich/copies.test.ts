import { HISTORY_KEY, RECIPE_KEY, defaultRecipe, normalizeRecipe } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { copiesIn, copyExportName, copyKey, copyRenderFilename, copyValue, historyKeyFor, newCopy, nextCopyIndex, parseCopy, recipeKeyFor } from './copies.ts';

describe('virtual copies', () => {
  it('keys: the original keeps its own, each copy has one', () => {
    expect(recipeKeyFor(null)).toBe(RECIPE_KEY);
    expect(historyKeyFor(null)).toBe(HISTORY_KEY);
    expect(recipeKeyFor('abc')).toBe('raw-editor.copy.abc');
    expect(historyKeyFor('abc')).toBe('raw-editor.history.abc');
  });

  it('a new copy: the next index, the recipe without the original JPEG', () => {
    const r = defaultRecipe();
    r.basic.exposure = 0.7;
    r.render = { assetId: 'jpeg', recipeHash: 'h', checksum: 'c', renderedAt: '' };
    r.pending = { recipeHash: 'h', startedAt: '' };
    const c = newCopy([{ index: 1 }, { index: 3 }], r, new Date('2026-11-12T10:00:00Z'));
    expect(c.index).toBe(4);
    expect(c.name).toBe('Copy 4');
    expect(c.createdAt).toBe('2026-11-12T10:00:00.000Z');
    expect(c.recipe.basic.exposure).toBe(0.7);
    expect(c.recipe.render).toBeUndefined();
    expect(c.recipe.pending).toBeUndefined();
    // The original is untouched.
    expect(r.render?.assetId).toBe('jpeg');
    expect(nextCopyIndex([])).toBe(1);
  });

  it('stored and read back from a metadata listing, in order, other keys ignored', () => {
    const a = newCopy([], defaultRecipe());
    const b = newCopy([a], defaultRecipe());
    b.name = 'Black & white';
    b.recipe.profile = 'monochrome';
    const items = [
      { key: copyKey(b.id), value: JSON.parse(JSON.stringify(copyValue(b))) },
      { key: RECIPE_KEY, value: JSON.parse(JSON.stringify(defaultRecipe())) },
      { key: copyKey(a.id), value: JSON.parse(JSON.stringify(copyValue(a))) },
      { key: 'raw-editor.history', value: {} },
    ];
    const copies = copiesIn(items);
    expect(copies.map((c) => c.name)).toEqual(['Copy 1', 'Black & white']);
    expect(copies[1]!.recipe).toEqual(normalizeRecipe(b.recipe));
  });

  it('broken values: defaults, or not a copy at all', () => {
    expect(parseCopy('raw-editor.recipe', {})).toBeNull();
    expect(parseCopy('raw-editor.copy.', {})).toBeNull();
    expect(parseCopy('raw-editor.copy.x', 'junk')).toBeNull();
    const c = parseCopy('raw-editor.copy.x', { index: -2, name: '  ', recipe: { basic: { exposure: 9 } } })!;
    expect([c.id, c.index, c.name]).toEqual(['x', 1, 'Copy 1']);
    expect(c.recipe.basic.exposure).toBe(5);
  });

  it('file names: the JPEG in the stack, and the export', () => {
    expect(copyRenderFilename('DSC01234.ARW', 2)).toBe('DSC01234.copy-2.edit.jpg');
    expect(copyExportName('DSC01234.ARW', 2)).toBe('DSC01234-copy-2.ARW');
  });
});
