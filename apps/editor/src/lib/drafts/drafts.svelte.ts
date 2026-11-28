// The drafts of this editor page (draft-store.ts), and which photos have one, for the filmstrip.
import { SvelteSet } from 'svelte/reactivity';
import { DraftStore, MemoryDraftBackend } from './draft-store.ts';

export const drafts = new DraftStore(new MemoryDraftBackend());

/** Photos with a draft (of the original edit or of a virtual copy). */
export const draftPhotos = new SvelteSet<string>();

drafts.onChange((photos) => {
  for (const id of [...draftPhotos]) if (!photos.has(id)) draftPhotos.delete(id);
  for (const id of photos) draftPhotos.add(id);
});
