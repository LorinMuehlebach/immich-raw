// Keeps the open photo's draft up to date (draft-store.ts): written a moment after the edits
// pause and whenever the photo is left, removed once the edit is back to its saved state. With
// it goes a picture of the canvas: the look shown while the photo opens next time
// (view-cache.ts), and a small one for the filmstrip.
import type { Recipe } from '@immich-raw/recipe';
import { editableJson } from '../state/history.ts';
import type { DraftStore } from './draft-store.ts';

export interface DraftHost {
  /** The photo and edit open and ready, or null (still opening, nothing open). */
  current(): { assetId: string; checksum: string; copyId: string | null } | null;
  /** The edits differ from the saved edit (or from the photo's defaults). */
  dirty(): boolean;
  /** No drafts: not the owner, or a save is running. */
  blocked(): boolean;
  recipe(): Recipe;
  /** The saved edit the edits started from (savedShows()). */
  savedBase(): string;
  /** The canvas right after drawing the whole photo as it is, or null when it shows something else. */
  plainCanvas(): HTMLCanvasElement | null;
}

export interface DraftKeeperDeps {
  store: DraftStore;
  /** Keeps a picture of the photo for its next open (view-cache.ts keepView). */
  keepView(checksum: string, shows: string, jpeg: Blob): Promise<void>;
  /** A JPEG of the canvas, taken now. */
  snapshot(canvas: HTMLCanvasElement): Promise<Blob | null>;
  /** A small JPEG for the filmstrip. */
  thumbnail(jpeg: Blob): Promise<Blob | undefined>;
  delayMs?: number;
}

export class DraftKeeper {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The edits last written as this photo's draft (null: it has none). */
  private written: string | null = null;

  constructor(
    private readonly host: DraftHost,
    private readonly deps: DraftKeeperDeps,
  ) {}

  /** A photo (or one of its virtual copies) opened, with this draft (or none). */
  opened(draft: Recipe | null): void {
    this.cancel();
    this.written = draft ? editableJson(draft) : null;
  }

  /** Something may have changed: the draft is written once the edits pause. */
  changed(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.keep();
    }, this.deps.delayMs ?? 2000);
  }

  /** The draft isn't written yet: leaving the page now would lose the latest edits. */
  get due(): boolean {
    return this.timer !== null;
  }

  /**
   * Writes the draft now, or removes it when the edit is back to its saved state. What it keeps
   * is taken right away (the photo may be put away next); the returned promise ends when it is stored.
   */
  keep(): Promise<void> {
    this.cancel();
    const cur = this.host.current();
    if (!cur || this.host.blocked()) return Promise.resolve();
    if (!this.host.dirty()) {
      if (this.written === null) return Promise.resolve();
      this.written = null;
      return this.deps.store.remove(cur.assetId, cur.copyId).catch(() => {});
    }
    const recipe = this.host.recipe();
    const json = editableJson(recipe);
    if (json === this.written) return Promise.resolve();
    this.written = json;
    const base = this.host.savedBase();
    const canvas = this.host.plainCanvas();
    const picture = canvas ? this.deps.snapshot(canvas).catch(() => null) : Promise.resolve(null);
    return picture.then(async (jpeg) => {
      const thumb = jpeg ? await this.deps.thumbnail(jpeg).catch(() => undefined) : undefined;
      if (jpeg) await this.deps.keepView(cur.checksum, json, jpeg).catch(() => {});
      await this.deps.store.put({ assetId: cur.assetId, copyId: cur.copyId, recipe, base, updatedAt: Date.now(), ...(thumb ? { thumb } : {}) }).catch(() => {});
    });
  }

  /** The edit was saved or the draft discarded: it goes. */
  drop(): Promise<void> {
    this.cancel();
    const cur = this.host.current();
    this.written = null;
    if (!cur) return Promise.resolve();
    return this.deps.store.remove(cur.assetId, cur.copyId).catch(() => {});
  }

  /** Writes it again even if unchanged (with a new saved edit to compare with later). */
  rewrite(): Promise<void> {
    this.written = null;
    return this.keep();
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** A JPEG of the canvas as it is now (the copy is taken at once, the encoding happens later). */
export function canvasJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

/** A JPEG at most 320 px wide, for the filmstrip. */
export async function thumbnailJpeg(jpeg: Blob): Promise<Blob | undefined> {
  const bitmap = await createImageBitmap(jpeg);
  try {
    const scale = Math.min(1, 320 / bitmap.width);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  } finally {
    bitmap.close();
  }
}
