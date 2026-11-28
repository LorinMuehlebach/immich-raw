// Drafts: unsaved edits of the photos opened from the filmstrip, one per photo (and per virtual
// copy of it), so switching to another photo never has to ask. They live in memory while the
// editor page is open: going back to Immich asks to save them, and closing or reloading the page
// drops them (the browser asks first). A photo with a draft opens with the draft instead of its
// saved edit. The draft remembers which saved edit it was made from, so a save in another tab
// meanwhile can be pointed out when the photo opens again.
import { applyPatch, type Recipe, type SettingsPatch } from '@immich-raw/recipe';
import { editable, editableJson } from '../state/history.ts';

export interface Draft {
  key: string;
  assetId: string;
  /** The virtual copy it is a draft of, null for the original edit. */
  copyId: string | null;
  recipe: Recipe;
  /** The saved edit it was made from (savedShows()). */
  base: string;
  /** When it was last written (ms since 1970). */
  updatedAt: number;
  /** A small picture of it for the filmstrip (JPEG), if one could be taken. */
  thumb?: Blob;
  /** The picture shown while the photo opens again (JPEG of the canvas), if one could be taken. */
  look?: Blob;
  /**
   * Only these settings (Sync Settings on a photo without a saved edit, whose starting settings
   * aren't known until it opens): they go on top of its defaults then.
   */
  patch?: SettingsPatch;
}

export const draftKey = (assetId: string, copyId: string | null): string => `${assetId}|${copyId ?? ''}`;

/** What a photo's saved edit is, for comparing: its edited fields, or 'unedited' when it has none. */
export const savedShows = (stored: Recipe | null): string => (stored ? editableJson(stored) : 'unedited');

/** The saved edit (or the photo's defaults) with the draft's edits on top; bookkeeping stays the saved one's. */
export function withDraft(base: Recipe, draft: Pick<Draft, 'recipe' | 'patch'>): Recipe {
  if (draft.patch) return applyPatch(structuredClone(base), draft.patch);
  return { ...structuredClone(base), ...structuredClone(editable(draft.recipe)) };
}

export interface DraftBackend {
  all(): Promise<Draft[]>;
  get(key: string): Promise<Draft | undefined>;
  put(draft: Draft): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryDraftBackend implements DraftBackend {
  private items = new Map<string, Draft>();

  async all(): Promise<Draft[]> {
    return [...this.items.values()].map((d) => structuredClone(d));
  }

  async get(key: string): Promise<Draft | undefined> {
    const d = this.items.get(key);
    return d && structuredClone(d);
  }

  async put(draft: Draft): Promise<void> {
    this.items.set(draft.key, structuredClone(draft));
  }

  async delete(key: string): Promise<void> {
    this.items.delete(key);
  }
}

/** The drafts, and which photos have one (for the filmstrip). */
export class DraftStore {
  /** Draft keys per photo. */
  private keys = new Map<string, Set<string>>();
  private loaded: Promise<void> | null = null;
  private listeners = new Set<(photos: ReadonlySet<string>) => void>();
  private writes = 0;

  constructor(private readonly backend: DraftBackend) {}

  /** Writes not finished yet (leaving the page should wait for them). */
  get pending(): number {
    return this.writes;
  }

  /** Called with the photos that have a draft, now and whenever that changes. */
  onChange(listener: (photos: ReadonlySet<string>) => void): () => void {
    this.listeners.add(listener);
    void this.load().then(() => listener(this.photos()));
    return () => this.listeners.delete(listener);
  }

  /** Photos with a draft of their original edit or of a copy. */
  photos(): ReadonlySet<string> {
    return new Set(this.keys.keys());
  }

  load(): Promise<void> {
    this.loaded ??= this.backend.all().then(
      (all) => {
        for (const d of all) this.note(d.assetId, d.key, true);
      },
      () => {},
    );
    return this.loaded;
  }

  async get(assetId: string, copyId: string | null): Promise<Draft | null> {
    return (await this.backend.get(draftKey(assetId, copyId)).catch(() => undefined)) ?? null;
  }

  /** Every draft, newest first. */
  async list(): Promise<Draft[]> {
    const all = await this.backend.all().catch(() => []);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async put(draft: Omit<Draft, 'key'>): Promise<void> {
    const key = draftKey(draft.assetId, draft.copyId);
    await this.track(() => this.backend.put({ ...draft, key }));
    await this.load();
    this.note(draft.assetId, key, true);
  }

  async remove(assetId: string, copyId: string | null): Promise<void> {
    const key = draftKey(assetId, copyId);
    await this.track(() => this.backend.delete(key));
    await this.load();
    this.note(assetId, key, false);
  }

  private async track(write: () => Promise<void>): Promise<void> {
    this.writes++;
    try {
      await write();
    } finally {
      this.writes--;
    }
  }

  private note(assetId: string, key: string, has: boolean): void {
    const keys = this.keys.get(assetId) ?? new Set<string>();
    const before = this.keys.has(assetId);
    if (has) keys.add(key);
    else keys.delete(key);
    if (keys.size) this.keys.set(assetId, keys);
    else this.keys.delete(assetId);
    if (before !== this.keys.has(assetId)) for (const l of this.listeners) l(this.photos());
  }
}
