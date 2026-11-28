import { defaultRecipe, pickGroups, type Recipe } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { withDraft, type Draft } from './draft-store.ts';
import { syncInto, type SyncDeps } from './sync.ts';

const source: Recipe = { ...defaultRecipe(), basic: { ...defaultRecipe().basic, exposure: 0.7, vibrance: 20 } };
const tone = pickGroups(source, ['tone']);
const presence = pickGroups(source, ['presence']);

function deps(draft: Draft | null) {
  const put: Omit<Draft, 'key'>[] = [];
  const d: SyncDeps = { draft: async () => draft, put: async (x) => void put.push(x) };
  return { d, put };
}

describe('syncInto', () => {
  it("a photo without a draft gets only the synced settings, put on what it has when it opens", async () => {
    const { d, put } = deps(null);
    const draft = await syncInto('a', tone, d, 5);
    expect(put).toHaveLength(1);
    expect(draft.patch).toEqual(tone);
    // Its starting settings: a film look, say, that the sync didn't know about.
    const defaults: Recipe = { ...defaultRecipe(), profile: 'fuji-provia' as Recipe['profile'], basic: { ...defaultRecipe().basic, vibrance: 5 } };
    const opened = withDraft(defaults, draft);
    expect(opened.profile).toBe('fuji-provia');
    expect(opened.basic.exposure).toBe(0.7);
    expect(opened.basic.vibrance).toBe(5);
    // Or its saved edit, with its JPEG.
    const stored: Recipe = { ...defaultRecipe(), basic: { ...defaultRecipe().basic, clarity: 30 }, render: { assetId: 'jpg', recipeHash: 'h', checksum: 'c', renderedAt: '' } };
    const onSaved = withDraft(stored, draft);
    expect([onSaved.basic.clarity, onSaved.basic.exposure, onSaved.render?.assetId]).toEqual([30, 0.7, 'jpg']);
  });

  it('a second sync adds to the first, also within one part of the recipe', async () => {
    const first = await syncInto('a', presence, deps(null).d, 1);
    const second = await syncInto('a', tone, deps({ ...first, key: 'a|' }).d, 2);
    const opened = withDraft(defaultRecipe(), second);
    expect(opened.basic.exposure).toBe(0.7);
    expect(opened.basic.vibrance).toBe(20);
  });

  it("a photo with a draft from the editor keeps the rest of it, and loses the draft's picture", async () => {
    const old: Draft = { key: 'a|', assetId: 'a', copyId: null, recipe: { ...defaultRecipe(), basic: { ...defaultRecipe().basic, clarity: 40 } }, base: 'unedited', updatedAt: 1, thumb: new Blob(['x']) };
    const draft = await syncInto('a', tone, deps(old).d, 9);
    expect(draft.patch).toBeUndefined();
    expect(draft.recipe.basic.clarity).toBe(40);
    expect(draft.recipe.basic.exposure).toBe(0.7);
    expect(draft.thumb).toBeUndefined();
    expect([draft.base, draft.updatedAt]).toEqual(['unedited', 9]);
  });
});
