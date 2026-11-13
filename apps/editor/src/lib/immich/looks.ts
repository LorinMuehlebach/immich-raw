// The picture that stands in for a photo while it opens, got ready ahead for the photos around the
// open one (the filmstrip asks), so switching to one of them shows it at once instead of after
// three requests. The choice is the editor's (showPreview()), the first of:
// - what the editor showed last time, if the saved edit (or the photo's draft) is still the same
//   (view-cache.ts);
// - the saved JPEG's preview in Immich;
// - Immich's preview of the RAW.
import type { AssetResponseDto } from '@immich/sdk';
import type { Recipe } from '@immich-raw/recipe';
import { savedShows } from '../drafts/draft-store.ts';
import { drafts } from '../drafts/drafts.svelte.ts';
import { editableJson } from '../state/history.ts';
import { apiUrl, authHeaders } from './api.ts';
import { editStates, type EditState } from './edit-state.ts';
import { readView, type KeptView } from './view-cache.ts';

export interface Look {
  image: Blob;
  /** Which picture it is (lookFromView/lookFromPreview): the editor doesn't swap it for the same one. */
  source: string;
}

/** What a kept view has to show to stand in for the photo: its draft, else its saved edit, else 'unedited'. */
export const viewShows = (stored: Recipe | null, draft: Recipe | null = null): string => (draft ? editableJson(draft) : savedShows(stored));
export const viewSource = (shows: string): string => `view:${shows}`;
export const previewSource = (assetId: string): string => `preview:${assetId}`;

export interface LookDeps {
  readView(checksum: string): Promise<KeptView | null>;
  editState(id: string): Promise<EditState>;
  /** The photo's draft in this browser (of its original edit), or null. */
  draft(id: string): Promise<Recipe | null>;
  /** Immich's preview of an asset, or null. */
  preview(id: string): Promise<Blob | null>;
}

/** The picture to show while the photo opens, or null when there is none. */
export async function resolveLook(asset: Pick<AssetResponseDto, 'id' | 'checksum'>, deps: LookDeps): Promise<Look | null> {
  const [view, state, draft] = await Promise.all([
    deps.readView(asset.checksum).catch(() => null),
    deps.editState(asset.id),
    deps.draft(asset.id).catch(() => null),
  ]);
  const shows = viewShows(state.stored, draft);
  if (view && view.shows === shows) return { image: view.image, source: viewSource(shows) };
  // The saved JPEG may be gone (deleted in Immich): then the RAW's preview.
  for (const id of [state.renderId, asset.id]) {
    if (!id) continue;
    const image = await deps.preview(id).catch(() => null);
    if (image) return { image, source: previewSource(id) };
  }
  return null;
}

/** What the filmstrip knows about the photo to open next: its info and, if ready, its look. */
export interface LookHint {
  asset?: AssetResponseDto;
  look?: Look;
}

interface Entry {
  asset: AssetResponseDto;
  /** undefined while it is being looked for; null when there is none. */
  look: Look | null | undefined;
}

/**
 * The looks of the photos around the open one, a few at a time, nearest first. Keeps up to `max`
 * (the ones asked for last stay); a look is a JPEG of a few hundred kB.
 */
export class LookCache {
  /** Least recently asked for first. */
  private entries = new Map<string, Entry>();
  private queue: AssetResponseDto[] = [];
  private wanted = new Set<string>();
  private running = 0;

  constructor(
    private readonly deps: LookDeps,
    private readonly max = 16,
    private readonly concurrency = 2,
  ) {}

  /** Gets these photos' looks ready, nearest first. Replaces the photos asked for before. */
  prefetch(assets: readonly AssetResponseDto[]): void {
    this.wanted = new Set(assets.map((a) => a.id));
    for (const a of assets) {
      const e = this.entries.get(a.id);
      if (!e) continue;
      this.entries.delete(a.id);
      this.entries.set(a.id, { ...e, asset: a });
    }
    this.queue = assets.filter((a) => !this.entries.has(a.id));
    this.trim();
    this.pump();
  }

  /** What is known about this photo now; `asset`: its info, when the caller has it. */
  hint(id: string, asset?: AssetResponseDto): LookHint {
    const e = this.entries.get(id);
    return { asset: asset ?? e?.asset, look: e?.look ?? undefined };
  }

  /** The photo's look may have changed (it was saved): look for it again when asked. */
  forget(id: string): void {
    this.entries.delete(id);
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length) {
      const asset = this.queue.shift()!;
      if (this.entries.has(asset.id)) continue;
      const entry: Entry = { asset, look: undefined };
      this.entries.set(asset.id, entry);
      this.trim();
      this.running++;
      void resolveLook(asset, this.deps)
        .then(
          (look) => {
            if (this.entries.get(asset.id) === entry) entry.look = look;
          },
          () => {
            if (this.entries.get(asset.id) === entry) this.entries.delete(asset.id);
          },
        )
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  /** Drops the least recently asked for looks over `max`, never one asked for last. */
  private trim(): void {
    for (const id of [...this.entries.keys()]) {
      if (this.entries.size <= this.max) return;
      if (!this.wanted.has(id)) this.entries.delete(id);
    }
  }
}

function fetchPreview(id: string): Promise<Blob | null> {
  // Low priority: the photo being opened needs the network more.
  const init: RequestInit & { priority?: 'low' } = { headers: authHeaders(), credentials: 'same-origin', priority: 'low' };
  return fetch(apiUrl(`/assets/${id}/thumbnail?size=preview`), init).then((r) => (r.ok ? r.blob() : null));
}

export const looks = new LookCache({
  readView,
  editState: (id) => editStates.get(id),
  draft: async (id) => (await drafts.get(id, null))?.recipe ?? null,
  preview: fetchPreview,
});
