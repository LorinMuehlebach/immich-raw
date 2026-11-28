// "Save drafts": the drafts of photos that aren't open go into Immich like a Save of each, rendered
// at full resolution with the Immich copy's preset and put in the RAW's stack. One photo at a time:
// each full-resolution decode needs up to ~2.4 GB (61 MP).
import { getAssetInfo, getAssetMetadata, type AssetResponseDto } from '@immich/sdk';
import { APP_ID, type Recipe } from '@immich-raw/recipe';
import type { RawRenderer, RawStep } from '../export/raw-render.ts';
import { finishExport, outputColor } from '../export/output.ts';
import { copiesIn, storedEdit } from '../immich/copies.ts';
import { saveRender, type SaveStep } from '../immich/save.ts';
import type { ExportPreset, SaveSettings } from '../state/export-settings.ts';
import { withDraft, type Draft } from './draft-store.ts';

export interface DraftsSaved {
  saved: number;
  failed: { name: string; error: string }[];
  /** Stopped before every draft was saved. */
  cancelled: boolean;
  /** Things that didn't stop a save (each said once). */
  warnings: string[];
}

/** A failure while saving one photo, with the photo's file name. */
export class PhotoError extends Error {
  constructor(
    readonly photo: string,
    message: string,
  ) {
    super(message);
  }
}

/** Saves the drafts one after another; stops between two once `signal` is aborted. A failure skips the photo. */
export async function saveEach(list: readonly Draft[], saveOne: (draft: Draft, index: number) => Promise<string[]>, signal: AbortSignal): Promise<DraftsSaved> {
  const result: DraftsSaved = { saved: 0, failed: [], cancelled: false, warnings: [] };
  for (const [i, draft] of list.entries()) {
    if (signal.aborted) {
      result.cancelled = true;
      break;
    }
    try {
      for (const w of await saveOne(draft, i)) if (!result.warnings.includes(w)) result.warnings.push(w);
      result.saved++;
    } catch (e) {
      console.error(e);
      result.failed.push({ name: e instanceof PhotoError ? e.photo : draft.assetId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

/** "3 drafts saved · 1 failed (DSCF7815.RAF: …) · stopped" */
export function describeDraftsSaved(r: DraftsSaved): string {
  const parts = [`${r.saved} ${r.saved === 1 ? 'draft' : 'drafts'} saved to Immich`];
  if (r.failed.length) parts.push(`${r.failed.length} failed (${r.failed.map((f) => `${f.name}: ${f.error}`).join('; ')})`);
  if (r.cancelled) parts.push('stopped before the rest');
  return [parts.join(' · ') + '.', ...r.warnings].join(' ');
}

export interface SavePhotoOptions {
  raws: RawRenderer;
  preset: ExportPreset;
  settings: SaveSettings;
  copyright: string;
  /** The owner's name when Immich doesn't give one with the photo. */
  fallbackOwner: string;
  onStep: (step: RawStep | SaveStep | string, fraction: number, name: string) => void;
}

/** Saves one draft of a photo that isn't open: its JPEG into the RAW's stack, its settings on the RAW. Warnings come back. */
export async function saveDraftPhoto(draft: Draft, o: SavePhotoOptions): Promise<string[]> {
  const raw = await getAssetInfo({ id: draft.assetId });
  const name = raw.originalFileName;
  try {
    return await savePhoto(draft, raw, o);
  } catch (e) {
    throw new PhotoError(name, e instanceof Error ? e.message : String(e));
  }
}

async function savePhoto(draft: Draft, raw: AssetResponseDto, o: SavePhotoOptions): Promise<string[]> {
  const name = raw.originalFileName;
  const step = (s: RawStep | SaveStep | string, f = 0) => o.onStep(s, f, name);
  const items = await getAssetMetadata({ id: raw.id });
  const copy = draft.copyId ? (copiesIn(items).find((c) => c.id === draft.copyId) ?? null) : null;
  if (draft.copyId && !copy) throw new Error('its virtual copy no longer exists');
  const stored = copy ? copy.recipe : storedEdit(items, null);
  // The saved edit's bookkeeping (its JPEG, to replace) with the draft's edits. Settings synced
  // onto a photo without an edit go on its own starting settings, known once it is decoded.
  let recipe: Recipe = stored ? withDraft(stored, draft) : structuredClone(draft.recipe);
  const make = (r: Recipe) => {
    delete r.pending;
    if (!stored) delete r.render;
    return (recipe = r);
  };
  const input = !stored && draft.patch ? (defaults: Recipe) => make(withDraft(defaults, draft)) : make(recipe);
  let decoder: Recipe['decoder'];
  const image = await o.raws.render(raw, input, (s, f) => step(s, f ?? 0), outputColor(o.preset, true), (d) => (decoder = d));
  recipe.decoder = decoder;
  recipe.app = APP_ID;
  const file = await finishExport(image, raw, o.preset, { copyright: o.copyright, owner: raw.owner?.name ?? o.fallbackOwner, forImmich: true, logo: null, onStep: (s) => step(s) });
  const warnings: string[] = [];
  await saveRender({
    raw,
    recipe,
    jpeg: new Blob([file.bytes as BlobPart], { type: 'image/jpeg' }),
    copy: copy && { id: copy.id, name: copy.name, index: copy.index, createdAt: copy.createdAt },
    settings: o.settings,
    onProgress: (s, f) => step(s, f),
    onWarning: (w) => warnings.push(`${name}: ${w}`),
  });
  return warnings;
}
