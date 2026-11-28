import { RECIPE_KEY, defaultRecipe } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { NO_EDIT, createEditStates, editStateOf } from './edit-state.ts';

const saved = { ...defaultRecipe(), render: { assetId: 'jpg-1', recipeHash: 'h', checksum: 'c', renderedAt: '2026-11-13T10:00:00Z' } };

describe('editStateOf', () => {
  it("reads the RAW's saved edit and its JPEG", () => {
    const state = editStateOf([{ key: RECIPE_KEY, value: saved }]);
    expect(state.stored).not.toBeNull();
    expect(state.renderId).toBe('jpg-1');
  });

  it('is empty without a saved edit (a virtual copy alone does not count)', () => {
    expect(editStateOf([])).toEqual(NO_EDIT);
    expect(editStateOf([{ key: 'raw-editor.copy.abc', value: { index: 1, recipe: saved } }])).toEqual(NO_EDIT);
  });
});

describe('createEditStates', () => {
  it('asks once per photo', async () => {
    const asked: string[] = [];
    const states = createEditStates(async (id) => (asked.push(id), []));
    await Promise.all([states.get('a'), states.get('a'), states.get('b')]);
    await states.get('a');
    expect(asked).toEqual(['a', 'b']);
  });

  it('asks a few at a time', async () => {
    let running = 0;
    let most = 0;
    const states = createEditStates(async () => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return [];
    }, 3);
    await Promise.all(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => states.get(id)));
    expect(most).toBe(3);
  });

  it('answers NO_EDIT when the photo cannot be read, and asks again later', async () => {
    let fail = true;
    const states = createEditStates(async () => {
      if (fail) throw new Error('offline');
      return [{ key: RECIPE_KEY, value: saved }];
    });
    expect(await states.get('a')).toEqual(NO_EDIT);
    fail = false;
    expect((await states.get('a')).renderId).toBe('jpg-1');
  });

  it('takes what the editor read, and asks again after forget()', async () => {
    let asked = 0;
    const states = createEditStates(async () => (asked++, []));
    states.remember('a', [{ key: RECIPE_KEY, value: saved }]);
    expect((await states.get('a')).renderId).toBe('jpg-1');
    expect(asked).toBe(0);
    states.forget('a');
    expect(await states.get('a')).toEqual(NO_EDIT);
    expect(asked).toBe(1);
  });
});
