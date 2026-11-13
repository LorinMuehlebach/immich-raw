import { defaultRecipe } from '@immich-raw/recipe';
import { describe, expect, it } from 'vitest';
import { draftKey, type Draft } from './draft-store.ts';
import { PhotoError, describeDraftsSaved, saveEach } from './save-drafts.ts';

const draft = (assetId: string): Draft => ({ key: draftKey(assetId, null), assetId, copyId: null, recipe: defaultRecipe(), base: 'unedited', updatedAt: 1 });

describe('saveEach', () => {
  it('saves the drafts one after another, and skips a photo that fails', async () => {
    const order: string[] = [];
    let running = 0;
    const r = await saveEach(
      [draft('a'), draft('b'), draft('c')],
      async (d) => {
        if (++running > 1) throw new Error('two at once');
        await new Promise((resolve) => setTimeout(resolve, 2));
        running--;
        order.push(d.assetId);
        if (d.assetId === 'b') throw new PhotoError('b.RAF', 'upload failed');
        return d.assetId === 'c' ? ['c.RAF: no tags', 'c.RAF: no tags'] : [];
      },
      new AbortController().signal,
    );
    expect(order).toEqual(['a', 'b', 'c']);
    expect(r).toEqual({ saved: 2, failed: [{ name: 'b.RAF', error: 'upload failed' }], cancelled: false, warnings: ['c.RAF: no tags'] });
    expect(describeDraftsSaved(r)).toBe('2 drafts saved to Immich · 1 failed (b.RAF: upload failed). c.RAF: no tags');
  });

  it('stops between two photos when cancelled', async () => {
    const stop = new AbortController();
    const r = await saveEach(
      [draft('a'), draft('b')],
      async () => {
        stop.abort();
        return [];
      },
      stop.signal,
    );
    expect(r.saved).toBe(1);
    expect(r.cancelled).toBe(true);
    expect(describeDraftsSaved(r)).toBe('1 draft saved to Immich · stopped before the rest.');
  });
});
