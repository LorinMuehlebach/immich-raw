// What is known of each photo (strip-view.ts PhotoFacts): its stars, pick, reject, saved edit and
// draft. Shared by the filmstrip (badges, filters) and the editor's keys (0-5, P, X, U), which set
// flags on whole shots (shot-flags.ts). A flag shows at once and goes back if Immich refuses it.
import { SvelteMap } from 'svelte/reactivity';
import { draftPhotos } from '../drafts/drafts.svelte.ts';
import { applyFlag, flagged, immichFlags, type FlagAction } from './shot-flags.ts';
import { NO_FACTS, type PhotoFacts } from './strip-view.ts';

const facts = new SvelteMap<string, PhotoFacts>();
let tagRoot = 'Culling';
const immich = immichFlags(() => tagRoot);

export const flagStatus = $state({ error: null as string | null });

export function factsOf(id: string): PhotoFacts {
  const f = facts.get(id) ?? NO_FACTS;
  const draft = draftPhotos.has(id);
  return f.draft === draft ? f : { ...f, draft };
}

export function noteFacts(id: string, patch: Partial<PhotoFacts>): void {
  const was = facts.get(id) ?? NO_FACTS;
  // Only a real change: the filmstrip redraws on every one.
  if ((Object.keys(patch) as (keyof PhotoFacts)[]).every((k) => patch[k] === was[k]) && facts.has(id)) return;
  facts.set(id, { ...was, ...patch });
}

/** The culler's tag root (CullerStatus.tagRoot): reject tags live under it. */
export function setTagRoot(root: string | null | undefined): void {
  tagRoot = root || 'Culling';
}

export function currentTagRoot(): string {
  return tagRoot;
}

const ACTION_TEXT: Record<FlagAction['kind'], string> = { rate: 'rate', pick: 'pick', reject: 'reject', clear: 'clear the flags of' };

/** Sets a flag on the shots of these RAWs. */
export async function flag(rawIds: string[], action: FlagAction): Promise<void> {
  if (!rawIds.length) return;
  const before = new Map(rawIds.map((id) => [id, facts.get(id)]));
  const known = new Map(rawIds.map((id) => [id, factsOf(id)]));
  for (const id of rawIds) facts.set(id, flagged(action, factsOf(id)));
  flagStatus.error = null;
  try {
    await applyFlag(rawIds, action, (id) => known.get(id) ?? NO_FACTS, immich);
  } catch (e) {
    for (const [id, f] of before) {
      if (f) facts.set(id, f);
      else facts.delete(id);
    }
    flagStatus.error = `Couldn't ${ACTION_TEXT[action.kind]} ${rawIds.length === 1 ? 'the photo' : `${rawIds.length} photos`}: ${e instanceof Error ? e.message : String(e)}`;
  }
}
