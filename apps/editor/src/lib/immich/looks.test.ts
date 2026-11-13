import type { AssetResponseDto } from '@immich/sdk';
import { defaultRecipe } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { NO_EDIT, type EditState } from './edit-state.ts';
import { LookCache, previewSource, resolveLook, viewShows, viewSource, type LookDeps } from './looks.ts';
import type { KeptView } from './view-cache.ts';

const asset = (id: string) => ({ id, checksum: `sum-${id}` }) as AssetResponseDto;
const jpeg = (name: string) => new Blob([name], { type: 'image/jpeg' });
const edited: EditState = { stored: { ...defaultRecipe(), render: { assetId: 'jpg', recipeHash: 'h', checksum: 'c', renderedAt: '' } }, renderId: 'jpg' };

function deps(over: Partial<LookDeps> = {}): LookDeps & { previews: string[] } {
  const previews: string[] = [];
  return {
    previews,
    readView: async () => null,
    editState: async () => NO_EDIT,
    preview: async (id) => (previews.push(id), jpeg(id)),
    ...over,
  };
}

describe('resolveLook', () => {
  it('takes the kept view when it shows the saved edit', async () => {
    const view: KeptView = { shows: viewShows(edited.stored), image: jpeg('view') };
    const d = deps({ readView: async () => view, editState: async () => edited });
    const look = await resolveLook(asset('a'), d);
    expect(look?.source).toBe(viewSource(viewShows(edited.stored)));
    expect(await look?.image.text()).toBe('view');
    expect(d.previews).toEqual([]);
  });

  it("takes the saved JPEG's preview when the kept view shows something else", async () => {
    const d = deps({ readView: async () => ({ shows: 'unedited', image: jpeg('old') }), editState: async () => edited });
    expect((await resolveLook(asset('a'), d))?.source).toBe(previewSource('jpg'));
  });

  it("takes the RAW's preview when the saved JPEG is gone, or there is none", async () => {
    const gone = deps({ editState: async () => edited, preview: async (id) => (id === 'jpg' ? null : jpeg(id)) });
    expect((await resolveLook(asset('a'), gone))?.source).toBe(previewSource('a'));
    expect((await resolveLook(asset('b'), deps()))?.source).toBe(previewSource('b'));
  });

  it('takes the kept view of an unedited photo', async () => {
    const d = deps({ readView: async () => ({ shows: 'unedited', image: jpeg('view') }) });
    expect((await resolveLook(asset('a'), d))?.source).toBe(viewSource('unedited'));
  });

  it('gets by without the photo cache', async () => {
    const d = deps({
      readView: async () => {
        throw new Error('no OPFS');
      },
    });
    expect((await resolveLook(asset('a'), d))?.source).toBe(previewSource('a'));
  });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('LookCache', () => {
  it('gets the looks ready, nearest first, and hands them out', async () => {
    const d = deps();
    const cache = new LookCache(d, 16, 1);
    cache.prefetch([asset('next'), asset('prev')]);
    expect(cache.hint('next').look).toBeUndefined();
    await settle();
    await settle();
    expect(d.previews).toEqual(['next', 'prev']);
    expect(cache.hint('next').look?.source).toBe(previewSource('next'));
    expect(cache.hint('next').asset?.id).toBe('next');
  });

  it("hands out the caller's info when it has no look", () => {
    const cache = new LookCache(deps());
    expect(cache.hint('x', asset('x'))).toEqual({ asset: asset('x'), look: undefined });
    expect(cache.hint('y')).toEqual({ asset: undefined, look: undefined });
  });

  it('keeps at most `max`, never one asked for last', async () => {
    const cache = new LookCache(deps(), 3, 4);
    cache.prefetch([asset('a'), asset('b'), asset('c')]);
    await settle();
    cache.prefetch([asset('d'), asset('e')]);
    await settle();
    expect(cache.hint('d').look).toBeDefined();
    expect(cache.hint('e').look).toBeDefined();
    const kept = ['a', 'b', 'c'].filter((id) => cache.hint(id).look);
    expect(kept).toEqual(['c']);
  });

  it('asks again for a forgotten look, and not for one it has', async () => {
    const d = deps();
    const cache = new LookCache(d);
    cache.prefetch([asset('a')]);
    await settle();
    cache.prefetch([asset('a')]);
    await settle();
    expect(d.previews).toEqual(['a']);
    cache.forget('a');
    cache.prefetch([asset('a')]);
    await settle();
    expect(d.previews).toEqual(['a', 'a']);
  });
});
