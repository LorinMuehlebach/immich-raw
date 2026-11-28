import { defaultRecipe, type Recipe } from '@immich-raw/recipe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editableJson } from '../state/history.ts';
import { DraftKeeper, type DraftHost } from './draft-keeper.ts';
import { DraftStore, MemoryDraftBackend, draftKey, savedShows, withDraft } from './draft-store.ts';

const brighter = (r: Recipe, ev = 1): Recipe => ({ ...r, basic: { ...r.basic, exposure: ev } });
const saved: Recipe = { ...defaultRecipe(), render: { assetId: 'jpg', recipeHash: 'h', checksum: 'c', renderedAt: '' } };

describe('withDraft', () => {
  it("takes the draft's edits and keeps the saved edit's bookkeeping", () => {
    const draft = { ...brighter(defaultRecipe()), render: { assetId: 'old-jpg', recipeHash: 'x', checksum: 'y', renderedAt: '' } };
    const r = withDraft(saved, { recipe: draft });
    expect(r.basic.exposure).toBe(1);
    expect(r.render?.assetId).toBe('jpg');
  });

  it('compares saved edits by their edited fields', () => {
    expect(savedShows(null)).toBe('unedited');
    expect(savedShows(saved)).toBe(editableJson(defaultRecipe()));
  });
});

describe('DraftStore', () => {
  it('knows which photos have a draft, of the original or of a copy', async () => {
    const store = new DraftStore(new MemoryDraftBackend());
    const seen: string[][] = [];
    store.onChange((p) => seen.push([...p].sort()));
    const d = { recipe: defaultRecipe(), base: 'unedited', updatedAt: 1 };
    await store.put({ ...d, assetId: 'a', copyId: null });
    await store.put({ ...d, assetId: 'a', copyId: 'c1' });
    await store.put({ ...d, assetId: 'b', copyId: null });
    expect([...store.photos()].sort()).toEqual(['a', 'b']);
    await store.remove('a', null);
    expect(store.photos().has('a')).toBe(true);
    await store.remove('a', 'c1');
    expect([...store.photos()]).toEqual(['b']);
    expect(seen.at(-1)).toEqual(['b']);
    expect((await store.get('b', null))?.key).toBe(draftKey('b', null));
    expect(await store.get('a', null)).toBeNull();
  });

  it('lists the drafts kept before, newest first', async () => {
    const backend = new MemoryDraftBackend();
    const d = { recipe: defaultRecipe(), base: 'unedited' };
    await backend.put({ ...d, key: draftKey('a', null), assetId: 'a', copyId: null, updatedAt: 1 });
    await backend.put({ ...d, key: draftKey('b', null), assetId: 'b', copyId: null, updatedAt: 2 });
    const store = new DraftStore(backend);
    await store.load();
    expect([...store.photos()].sort()).toEqual(['a', 'b']);
    expect((await store.list()).map((x) => x.assetId)).toEqual(['b', 'a']);
  });
});

describe('DraftKeeper', () => {
  let store: DraftStore;
  let recipe: Recipe;
  const host = (over: Partial<DraftHost> = {}): DraftHost => ({
    current: () => ({ assetId: 'a', checksum: 'sum', copyId: null }),
    dirty: () => editableJson(recipe) !== editableJson(saved),
    blocked: () => false,
    recipe: () => structuredClone(recipe),
    savedBase: () => savedShows(saved),
    plainCanvas: () => ({}) as HTMLCanvasElement,
    ...over,
  });
  const keeper = (h = host()) =>
    new DraftKeeper(h, {
      store,
      snapshot: async () => new Blob(['jpeg']),
      thumbnail: async () => new Blob(['thumb']),
      delayMs: 100,
    });

  beforeEach(() => {
    store = new DraftStore(new MemoryDraftBackend());
    recipe = structuredClone(saved);
  });
  afterEach(() => vi.useRealTimers());

  it('writes the draft once the edits pause, with its picture', async () => {
    vi.useFakeTimers();
    const k = keeper();
    recipe = brighter(recipe);
    k.changed();
    k.changed();
    expect(k.due).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(k.due).toBe(false);
    const d = await store.get('a', null);
    expect(d?.recipe.basic.exposure).toBe(1);
    expect(d?.base).toBe(savedShows(saved));
    expect(await d?.thumb?.text()).toBe('thumb');
    expect(await d?.look?.text()).toBe('jpeg');
  });

  it("doesn't write the same edits twice", async () => {
    const k = keeper();
    recipe = brighter(recipe);
    await k.keep();
    const first = (await store.get('a', null))?.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 2));
    await k.keep();
    expect((await store.get('a', null))?.updatedAt).toBe(first);
  });

  it('removes the draft when the edit is back to its saved state', async () => {
    const k = keeper();
    recipe = brighter(recipe);
    await k.keep();
    recipe = structuredClone(saved);
    await k.keep();
    expect(await store.get('a', null)).toBeNull();
  });

  it('keeps nothing while the photo opens, for a photo of someone else, or during a save', async () => {
    recipe = brighter(recipe);
    await keeper(host({ current: () => null })).keep();
    await keeper(host({ blocked: () => true })).keep();
    expect(store.photos().size).toBe(0);
  });

  it('keeps the draft without a picture when the view is zoomed or overlaid', async () => {
    const k = keeper(host({ plainCanvas: () => null }));
    recipe = brighter(recipe);
    await k.keep();
    const d = await store.get('a', null);
    expect(d?.thumb).toBeUndefined();
    expect(d?.look).toBeUndefined();
  });

  it('starts from the draft a photo opened with, and drops it after a save', async () => {
    const k = keeper();
    recipe = brighter(recipe);
    await store.put({ assetId: 'a', copyId: null, recipe, base: 'x', updatedAt: 1 });
    k.opened(recipe);
    await k.keep();
    expect((await store.get('a', null))?.base).toBe('x');
    await k.rewrite();
    expect((await store.get('a', null))?.base).toBe(savedShows(saved));
    await k.drop();
    expect(await store.get('a', null)).toBeNull();
  });
});
