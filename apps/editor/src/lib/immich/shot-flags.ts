// Stars, pick (Immich's favourite) and reject, set on whole shots: the RAW, its camera JPEG and the
// editor's JPEGs, so Immich shows them whichever file is in front of the stack.
// - 0-5: the rating (0 clears it).
// - pick: favourite; a reject goes.
// - reject: the tag `<root>/Rejected` (the culler leaves it alone), no favourite, and rating -1 on
//   photos without stars (Immich 3.4 empties a -1 again; the tag is what lasts).
// - clear: no favourite, no reject (also the culler's `<root>/Rejected/...` tags).
import { getAllTags, getAssetInfo, getStack, tagAssets, untagAssets, updateAssets, upsertTags, type AssetResponseDto } from '@immich/sdk';
import type { PhotoFacts } from './strip-view.ts';

export type FlagAction = { kind: 'rate'; rating: number } | { kind: 'pick' } | { kind: 'reject' } | { kind: 'clear' };

/** The files of a RAW's shot in its stack: the RAW and the files named like it (camera JPEG, edits). */
export function shotFileIds(raw: Pick<AssetResponseDto, 'id' | 'originalFileName'>, stack: readonly Pick<AssetResponseDto, 'id' | 'originalFileName' | 'isTrashed'>[]): string[] {
  const stem = raw.originalFileName.replace(/\.[^.]+$/, '').toLowerCase();
  const same = stack.filter((a) => !a.isTrashed && a.id !== raw.id && a.originalFileName.toLowerCase().startsWith(`${stem}.`));
  return [raw.id, ...same.map((a) => a.id)];
}

/** The tag a manual reject gets, and every reject tag under the root (the culler's too). */
export function rejectTagValue(root: string): string {
  return `${root}/Rejected`;
}

export function rejectTagIds(root: string, tags: readonly { id: string; value: string }[]): string[] {
  const own = rejectTagValue(root);
  return tags.filter((t) => t.value === own || t.value.startsWith(`${own}/`)).map((t) => t.id);
}

/** What the filmstrip shows right away, before Immich has answered. */
export function flagged(action: FlagAction, p: PhotoFacts): PhotoFacts {
  switch (action.kind) {
    case 'rate':
      return { ...p, rating: action.rating > 0 ? action.rating : null };
    case 'pick':
      return { ...p, favorite: true, rejected: false };
    case 'reject':
      return { ...p, favorite: false, rejected: true };
    case 'clear':
      return { ...p, favorite: false, rejected: false };
  }
}

export interface FlagDeps {
  /** The files of the RAW's shot. */
  files(rawId: string): Promise<string[]>;
  update(ids: string[], patch: { rating?: number | null; isFavorite?: boolean }): Promise<void>;
  /** The id of `<root>/Rejected`, made if it isn't there. */
  rejectTag(): Promise<string>;
  /** Every reject tag's id. */
  rejectTags(): Promise<string[]>;
  tag(tagId: string, ids: string[]): Promise<void>;
  untag(tagId: string, ids: string[]): Promise<void>;
}

/** Sets the flag on the shots of these RAWs. `facts`: what is known of each RAW (its stars). */
export async function applyFlag(rawIds: readonly string[], action: FlagAction, facts: (id: string) => PhotoFacts, d: FlagDeps): Promise<void> {
  const shots = await Promise.all(rawIds.map(async (id) => ({ id, files: await d.files(id) })));
  const files = shots.flatMap((s) => s.files);
  if (!files.length) return;
  const unreject = async () => {
    for (const tagId of await d.rejectTags()) await d.untag(tagId, files);
  };
  switch (action.kind) {
    case 'rate':
      await d.update(files, { rating: action.rating > 0 ? action.rating : null });
      return;
    case 'pick':
      await d.update(files, { isFavorite: true });
      await unreject();
      return;
    case 'reject': {
      await d.update(files, { isFavorite: false });
      const unrated = shots.filter((s) => !facts(s.id).rating).flatMap((s) => s.files);
      if (unrated.length) await d.update(unrated, { rating: -1 }).catch(() => {});
      await d.tag(await d.rejectTag(), files);
      return;
    }
    case 'clear':
      await d.update(files, { isFavorite: false });
      await unreject();
      return;
  }
}

/**
 * Which flag change of each file is the latest: a late re-check (settleTag) only puts a tag back
 * when nothing changed the file's flags since.
 */
export class FlagChanges {
  private last = new Map<string, number>();
  private n = 0;

  /** A change of these files; its number. */
  note(ids: readonly string[]): number {
    const at = ++this.n;
    for (const id of ids) this.last.set(id, at);
    return at;
  }

  /** The files no change touched after change `at`. */
  untouchedSince(at: number, ids: readonly string[]): string[] {
    return ids.filter((id) => (this.last.get(id) ?? 0) <= at);
  }
}

/** Immich's side. `root`: the culler's tag root (CullerStatus.tagRoot), or 'Culling'. */
export function immichFlags(root: () => string, changes = new FlagChanges()): FlagDeps {
  return {
    async files(rawId) {
      const raw = await getAssetInfo({ id: rawId });
      if (!raw.stack) return [raw.id];
      const stack = await getStack({ id: raw.stack.id });
      return shotFileIds(raw, stack.assets);
    },
    async update(ids, patch) {
      changes.note(ids);
      await updateAssets({ assetBulkUpdateDto: { ids, ...patch } });
    },
    async rejectTag() {
      const value = rejectTagValue(root());
      const tags = await upsertTags({ tagUpsertDto: { tags: [value] } });
      const tag = tags.find((t) => t.value === value) ?? tags.at(-1);
      if (!tag) throw new Error(`Immich made no "${value}" tag`);
      return tag.id;
    },
    async rejectTags() {
      return rejectTagIds(root(), await getAllTags());
    },
    async tag(tagId, ids) {
      const at = changes.note(ids);
      await tagAssets({ id: tagId, bulkIdsDto: { ids } });
      // Immich 3.4 sometimes loses a new tag a moment later (it writes the photo's sidecar in a
      // background job and reads it back): look again, and put back what went missing, unless
      // the flags changed since (U or P took the reject off).
      setTimeout(() => void settleTag(tagId, () => changes.untouchedSince(at, ids)), 4000);
    },
    async untag(tagId, ids) {
      changes.note(ids);
      await untagAssets({ id: tagId, bulkIdsDto: { ids } });
    },
  };
}

async function settleTag(tagId: string, stillWanted: () => string[]): Promise<void> {
  try {
    const missing: string[] = [];
    for (const id of stillWanted()) {
      const a = await getAssetInfo({ id });
      if (!a.tags?.some((t) => t.id === tagId)) missing.push(id);
    }
    const still = new Set(stillWanted());
    const put = missing.filter((id) => still.has(id));
    if (put.length) await tagAssets({ id: tagId, bulkIdsDto: { ids: put } });
  } catch {
    // best effort
  }
}
