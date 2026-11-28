// Virtual copies (Lightroom's): several edits of one RAW, each saving its own JPEG into the
// RAW's stack. The original edit stays under RECIPE_KEY; each copy is a metadata key of its own
// on the RAW (`raw-editor.copy.<id>`), with its snapshots under `raw-editor.history.<id>`. One
// key per copy keeps every value small, and two tabs on different copies can't overwrite each
// other. The copy's JPEG carries its id in RENDER_KEY (`copyId`) and is called
// '<name>.copy-<n>.edit.jpg', so everything that finds renders by name keeps working.
import { HISTORY_KEY, RECIPE_KEY, normalizeRecipe, shortId, type Recipe } from '@immich-raw/recipe';

export const COPY_PREFIX = 'raw-editor.copy.';

export const copyKey = (id: string): string => `${COPY_PREFIX}${id}`;

/** Where an edit's recipe is stored: the original's key, or its copy's. */
export const recipeKeyFor = (copyId: string | null): string => (copyId ? copyKey(copyId) : RECIPE_KEY);

/** Where an edit's snapshots are stored. */
export const historyKeyFor = (copyId: string | null): string => (copyId ? `${HISTORY_KEY}.${copyId}` : HISTORY_KEY);

export interface CopyMeta {
  id: string;
  name: string;
  /** 1, 2, ...: in the name of its JPEG; never reused while the copy exists. */
  index: number;
  createdAt: string;
}

export interface StoredCopy extends CopyMeta {
  recipe: Recipe;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The copy stored under `key`, or null when the key isn't a copy's. */
export function parseCopy(key: string, value: unknown): StoredCopy | null {
  if (!key.startsWith(COPY_PREFIX)) return null;
  const id = key.slice(COPY_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || !isObject(value)) return null;
  const index = typeof value.index === 'number' && Number.isInteger(value.index) && value.index >= 1 && value.index < 1000 ? value.index : 1;
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 60) : `Copy ${index}`;
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : '';
  return { id, name, index, createdAt, recipe: normalizeRecipe(value.recipe) };
}

/** Every copy in a metadata listing, in the order they were made. */
export function copiesIn(items: readonly { key: string; value: unknown }[]): StoredCopy[] {
  return items
    .map((i) => parseCopy(i.key, i.value))
    .filter((c): c is StoredCopy => !!c)
    .sort((a, b) => a.index - b.index || a.createdAt.localeCompare(b.createdAt));
}

/** What the editor lists of a copy: its name and its JPEG in the stack, if saved. */
export interface CopyInfo extends CopyMeta {
  renderId: string | null;
}

export const copyInfo = (c: StoredCopy): CopyInfo => ({ id: c.id, name: c.name, index: c.index, createdAt: c.createdAt, renderId: c.recipe.render?.assetId ?? null });

/** The stored recipe of the original (copyId null) or of a copy, from a metadata listing. */
export function storedEdit(items: readonly { key: string; value: unknown }[], copyId: string | null): Recipe | null {
  const key = recipeKeyFor(copyId);
  const item = items.find((i) => i.key === key);
  if (!item) return null;
  return copyId ? (parseCopy(key, item.value)?.recipe ?? null) : normalizeRecipe(item.value);
}

/** The value stored for a copy. */
export function copyValue(c: StoredCopy): Record<string, unknown> {
  // JSON round trip drops undefined fields (render/pending).
  return { schema: 1, name: c.name, index: c.index, createdAt: c.createdAt, recipe: JSON.parse(JSON.stringify(c.recipe)) };
}

/** The next free index: one more than the highest. */
export function nextCopyIndex(copies: readonly Pick<CopyMeta, 'index'>[]): number {
  return copies.reduce((m, c) => Math.max(m, c.index), 0) + 1;
}

/** A new copy holding `recipe` (without the original's JPEG or a pending save). */
export function newCopy(copies: readonly Pick<CopyMeta, 'index'>[], recipe: Recipe, now = new Date()): StoredCopy {
  const index = nextCopyIndex(copies);
  const r = structuredClone(recipe);
  delete r.render;
  delete r.pending;
  return { id: shortId(), name: `Copy ${index}`, index, createdAt: now.toISOString(), recipe: r };
}

/** 'DSC01234.ARW', 2 -> 'DSC01234.copy-2.edit.jpg'. */
export function copyRenderFilename(originalFileName: string, index: number): string {
  const dot = originalFileName.lastIndexOf('.');
  return `${dot > 0 ? originalFileName.slice(0, dot) : originalFileName}.copy-${index}.edit.jpg`;
}

/** A copy's name in exported file names: 'DSC01234.ARW', 2 -> 'DSC01234-copy-2.ARW'. */
export function copyExportName(originalFileName: string, index: number): string {
  const dot = originalFileName.lastIndexOf('.');
  return dot > 0 ? `${originalFileName.slice(0, dot)}-copy-${index}${originalFileName.slice(dot)}` : `${originalFileName}-copy-${index}`;
}
