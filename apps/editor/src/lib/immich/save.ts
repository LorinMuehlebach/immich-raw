// Loads and saves edits. The RAW file is never touched: the render is uploaded as a new
// asset, stacked on top of the RAW, and the recipe is stored on the RAW's metadata.
import {
  addAssetsToAlbum,
  bulkTagAssets,
  createStack,
  deleteAssetMetadata,
  deleteAssets,
  getAllAlbums,
  getAssetInfo,
  getAssetMetadata,
  getStack,
  restoreAssets,
  searchAssets,
  updateAsset,
  updateAssetMetadata,
  type AssetResponseDto,
  type UpdateAssetDto,
  type UserAdminResponseDto,
} from '@immich/sdk';
import { zoneOffsetMinutes } from '@immich-raw/pipeline';
import { APP_ID, RECIPE_KEY, RENDER_KEY, cloneRecipe, normalizeRecipe, recipeHash, type Recipe } from '@immich-raw/recipe';
import { httpStatus } from './api.ts';
import { cullerStatus } from './culler.ts';
import { keepsOtherCaptureInFront, planStack } from './stack-planner.ts';
import { sha1Base64, uploadAsset } from './upload.ts';

export type SaveStep = 'prepare' | 'upload' | 'metadata' | 'stack' | 'recipe' | 'cleanup';

const STEP_LABELS: Record<SaveStep, string> = {
  prepare: 'preparing the save',
  upload: 'uploading the edited JPEG',
  metadata: 'copying date, location and albums',
  stack: 'stacking the JPEG on the RAW',
  recipe: 'storing the edit settings',
  cleanup: 'moving the previous version to trash',
};

/** The stored recipe for a RAW, or null when it has never been edited here. */
export async function loadRecipe(assetId: string): Promise<Recipe | null> {
  const value = await readMetadata(assetId, RECIPE_KEY);
  return value ? normalizeRecipe(value) : null;
}

/** Save is only possible for the owner (partner and shared assets are read-only). */
export function canEdit(raw: AssetResponseDto, me: UserAdminResponseDto): boolean {
  return raw.ownerId === me.id;
}

export interface SaveOptions {
  raw: AssetResponseDto;
  /** The recipe to save. Its `render` field must be what was loaded (the previous render). */
  recipe: Recipe;
  jpeg: Blob;
  onProgress?: (step: SaveStep, fraction: number) => void;
}

/** Runs the whole save flow and returns the stored recipe (with `render` filled in). */
export async function saveRender({ raw, recipe, jpeg, onProgress }: SaveOptions): Promise<Recipe> {
  let step: SaveStep = 'prepare';
  const progress = (s: SaveStep, f: number) => {
    step = s;
    onProgress?.(s, f);
  };
  progress('prepare', 0);

  const stored = await readMetadata(raw.id, RECIPE_KEY).catch(() => null);
  const hash = await recipeHash(recipe);
  const checksum = await sha1Base64(jpeg);
  const previousRenderId = recipe.render?.assetId ?? (stored ? normalizeRecipe(stored).render?.assetId : undefined) ?? null;

  let renderId: string | null = null;
  try {
    // 0: mark the save as in progress, so an interrupted save can be found again.
    const pending = cloneRecipe(recipe);
    pending.pending = { recipeHash: hash, checksum, startedAt: new Date().toISOString() };
    await writeRecipe(raw.id, pending);
    progress('prepare', 1);

    // 2: upload the render.
    progress('upload', 0);
    const uploaded = await uploadAsset(
      {
        file: jpeg,
        filename: renderFilename(raw.originalFileName),
        fileCreatedAt: raw.fileCreatedAt,
        fileModifiedAt: new Date().toISOString(),
        isFavorite: raw.isFavorite,
        metadata: [{ key: RENDER_KEY, value: { sourceAssetId: raw.id, recipeHash: hash, app: APP_ID } }],
        checksum,
      },
      (f) => progress('upload', f),
    );
    renderId = uploaded.id;
    const isDuplicate = uploaded.status === 'duplicate';

    // 3: copy date/location/rating/description and album membership.
    progress('metadata', 0);
    const dto = renderUpdate(raw);
    if (Object.keys(dto).length) await updateAsset({ id: renderId, updateAssetDto: dto });
    await copyAlbums(raw.id, renderId);
    await copyCullTags(raw, renderId);
    progress('metadata', 1);

    // 4: stack. Re-read the RAW: its stack changes with every save.
    progress('stack', 0);
    const [freshRaw, renderInfo, previous] = await Promise.all([
      getAssetInfo({ id: raw.id }),
      isDuplicate ? getAssetInfo({ id: renderId }) : Promise.resolve(null),
      previousRenderId ? loadRenderInfo(previousRenderId) : Promise.resolve(null),
    ]);
    const rawStack = freshRaw.stack ? { id: freshRaw.stack.id, primaryAssetId: freshRaw.stack.primaryAssetId } : null;
    const keepPrimary =
      !!rawStack && rawStack.primaryAssetId !== raw.id && rawStack.primaryAssetId !== renderId && (await primaryIsOtherCapture(freshRaw, rawStack.id));
    const plan = planStack({
      rawId: raw.id,
      rawStack,
      newRenderId: renderId,
      previousRender: previous,
      uploadWasDuplicate: isDuplicate,
      newRenderIsTrashed: renderInfo?.isTrashed ?? false,
      keepPrimary,
    });
    if (plan.restoreIds.length) await restoreAssets({ bulkIdsDto: { ids: plan.restoreIds } });
    if (plan.createStackIds.length >= 2) await createStack({ stackCreateDto: { assetIds: plan.createStackIds } });
    progress('stack', 1);

    // 5: store the final recipe.
    progress('recipe', 0);
    const final = cloneRecipe(recipe);
    delete final.pending;
    final.render = { assetId: renderId, recipeHash: hash, checksum, renderedAt: new Date().toISOString() };
    await writeRecipe(raw.id, final);
    progress('recipe', 1);

    // 6: trash the previous render. A failure here leaves an extra JPEG, not a broken save.
    progress('cleanup', 0);
    if (plan.trashIds.length) {
      try {
        await deleteAssets({ assetBulkDeleteDto: { ids: plan.trashIds } });
      } catch (e) {
        console.warn('Could not move the previous render to trash', e);
      }
    }
    progress('cleanup', 1);
    return final;
  } catch (e) {
    throw new Error(`Saving failed while ${STEP_LABELS[step]}: ${errorMessage(e)}`);
  } finally {
    // Nothing was created: put the stored recipe back so no stale "pending" remains.
    if (!renderId) {
      try {
        if (stored) await writeMetadata(raw.id, RECIPE_KEY, stored);
        else await deleteAssetMetadata({ id: raw.id, key: RECIPE_KEY });
      } catch {
        // best effort
      }
    }
  }
}

/**
 * If a save was interrupted after the upload, returns the id of the uploaded render
 * (found by checksum), so the caller can offer to finish or discard it.
 */
export async function findPendingRender(recipe: Recipe): Promise<string | null> {
  const checksum = recipe.pending?.checksum;
  if (!checksum) return null;
  // Flat search fields are deprecated since 3.2 but still supported in 3.3.
  const res = await searchAssets({ metadataSearchDto: { checksum, withDeleted: true, size: 1 } });
  return res.assets.items[0]?.id ?? null;
}

export function renderFilename(originalFileName: string): string {
  const dot = originalFileName.lastIndexOf('.');
  const base = dot > 0 ? originalFileName.slice(0, dot) : originalFileName;
  return `${base}.edit.jpg`;
}

/** Fields copied from the RAW to the render. Immich rejects rating 0 and lat without lon. */
/**
 * '2022-12-17T08:03:36.000Z' + 'Asia/Shanghai' -> '2022-12-17T16:03:36.000+08:00'.
 * Immich keeps the photo's local time only when the date carries its offset; a bare UTC
 * instant makes the render's local time drift from the RAW's.
 */
export function withZoneOffset(iso: string, timeZone: string | null | undefined): string {
  if (!timeZone) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const off = zoneOffsetMinutes(d, timeZone);
  if (off === null) return iso;
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 23);
  const a = Math.abs(off);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${local}${off < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export function renderUpdate(raw: AssetResponseDto): UpdateAssetDto {
  const exif = raw.exifInfo;
  const dto: UpdateAssetDto = {};
  if (exif?.dateTimeOriginal) dto.dateTimeOriginal = withZoneOffset(exif.dateTimeOriginal, exif.timeZone);
  if (typeof exif?.latitude === 'number' && typeof exif?.longitude === 'number') {
    dto.latitude = exif.latitude;
    dto.longitude = exif.longitude;
  }
  const rating = exif?.rating;
  if (typeof rating === 'number' && (rating === -1 || (rating >= 1 && rating <= 5))) dto.rating = rating;
  if (exif?.description?.trim()) dto.description = exif.description;
  return dto;
}

export async function copyAlbums(rawId: string, renderId: string): Promise<void> {
  const albums = await getAllAlbums({ assetId: rawId });
  // Shared albums may not allow adding; that shouldn't fail the save.
  await Promise.allSettled(albums.map((a) => addAssetsToAlbum({ id: a.id, bulkIdsDto: { ids: [renderId] } })));
}

/** The RAW sits in a stack of several captures (e.g. a burst stacked by the culler) whose front is another capture. */
async function primaryIsOtherCapture(raw: AssetResponseDto, stackId: string): Promise<boolean> {
  const stack = await getStack({ id: stackId });
  const primary = stack.assets.find((a) => a.id === stack.primaryAssetId);
  if (!primary) return false;
  const source = primary.originalFileName.toLowerCase().endsWith('.edit.jpg') ? (await readMetadata(primary.id, RENDER_KEY))?.sourceAssetId : null;
  return keepsOtherCaptureInFront(raw, primary, stack.assets, typeof source === 'string' ? source : null);
}

/** The culler's tags (best, runner-up, rejected and why) go with the edit, like the rating does. */
export async function copyCullTags(raw: AssetResponseDto, renderId: string): Promise<void> {
  const status = await cullerStatus();
  if (!status) return;
  const prefix = `${status.tagRoot}/`;
  const tagIds = (raw.tags ?? []).filter((t) => t.value.startsWith(prefix)).map((t) => t.id);
  if (!tagIds.length) return;
  try {
    await bulkTagAssets({ tagBulkAssetsDto: { tagIds, assetIds: [renderId] } });
  } catch (e) {
    console.warn('Could not copy the culling tags to the render', e);
  }
}

async function loadRenderInfo(id: string): Promise<{ id: string; isTrashed: boolean; sourceAssetId: string | null } | null> {
  try {
    const [info, meta] = await Promise.all([getAssetInfo({ id }), readMetadata(id, RENDER_KEY)]);
    const source = meta?.sourceAssetId;
    return { id: info.id, isTrashed: info.isTrashed, sourceAssetId: typeof source === 'string' ? source : null };
  } catch (e) {
    const status = httpStatus(e);
    if (status === 400 || status === 404) return null; // deleted for good
    throw e;
  }
}

// Lists all keys instead of asking for one: Immich answers a missing key with 400,
// which the browser logs as an error on every first open.
export async function readMetadata(assetId: string, key: string): Promise<Record<string, unknown> | null> {
  try {
    const items = await getAssetMetadata({ id: assetId });
    return (items.find((i) => i.key === key)?.value as Record<string, unknown> | undefined) ?? null;
  } catch (e) {
    const status = httpStatus(e);
    if (status === 400 || status === 404) return null;
    throw e;
  }
}

export async function writeMetadata(assetId: string, key: string, value: Record<string, unknown>): Promise<void> {
  await updateAssetMetadata({ id: assetId, assetMetadataUpsertDto: { items: [{ key, value }] } });
}

function writeRecipe(assetId: string, recipe: Recipe): Promise<void> {
  // JSON round trip drops undefined fields (render/pending) before sending.
  return writeMetadata(assetId, RECIPE_KEY, JSON.parse(JSON.stringify(recipe)) as Record<string, unknown>);
}

export function errorMessage(e: unknown): string {
  const status = httpStatus(e);
  const data = (e as { data?: { message?: unknown } })?.data;
  if (status !== undefined) {
    const msg = typeof data?.message === 'string' ? data.message : Array.isArray(data?.message) ? data.message.join(', ') : '';
    return `server answered ${status}${msg ? ` (${msg})` : ''}`;
  }
  return e instanceof Error ? e.message : String(e);
}
