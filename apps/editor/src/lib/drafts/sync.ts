// Sync Settings: the chosen groups of the open photo's settings go onto other photos as drafts
// (draft-store.ts), to be saved later (Save N drafts). Nothing is rendered here.
// - A photo with a draft from the editor: the groups go into that draft.
// - Any other photo: a draft of just the groups (added to the groups synced before). They go on
//   whatever the photo has when it opens or is saved: its saved edit, or its starting settings
//   (a Fujifilm RAW's film look, say, which isn't known before it is decoded).
import { applyPatch, defaultRecipe, patchGroups, pickGroups, type SettingsPatch } from '@immich-raw/recipe';
import type { Draft } from './draft-store.ts';

export interface SyncDeps {
  draft(assetId: string): Promise<Draft | null>;
  put(draft: Omit<Draft, 'key'>): Promise<void>;
}

/** The draft a photo gets from the patch, written with deps.put. */
export async function syncInto(assetId: string, patch: SettingsPatch, deps: SyncDeps, now = Date.now()): Promise<Omit<Draft, 'key'>> {
  const draft = await deps.draft(assetId);
  let next: Omit<Draft, 'key'>;
  if (draft && !draft.patch) {
    next = { ...draft, recipe: applyPatch(structuredClone(draft.recipe), patch), updatedAt: now };
    // Its picture shows the draft as it was.
    delete next.thumb;
  } else {
    // The groups synced before and these together.
    const recipe = applyPatch(draft?.patch ? applyPatch(defaultRecipe(), draft.patch) : defaultRecipe(), patch);
    const groups = [...new Set([...(draft?.patch ? patchGroups(draft.patch) : []), ...patchGroups(patch)])];
    next = { assetId, copyId: null, recipe, base: draft?.base ?? '', updatedAt: now, patch: pickGroups(recipe, groups) };
  }
  await deps.put(next);
  return next;
}
