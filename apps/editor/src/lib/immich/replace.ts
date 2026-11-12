// Replaces a RAW in Immich with a DNG made from it (Convert to DNG). Immich can't swap an
// asset's file, so the DNG is uploaded as a new asset, takes over everything that belongs
// to the RAW (albums, shared links, stack, favourite, date, location, rating, description,
// tags, visibility, the edit recipe and history), and the RAW is deleted last. Until that
// last step nothing about the RAW changes; if anything fails before it, the new asset is
// removed again.
import {
  AssetVisibility,
  bulkTagAssets,
  copyAsset,
  createStack,
  deleteAssets,
  getAssetInfo,
  getAssetMetadata,
  restoreAssets,
  updateAsset,
  updateStack,
  type AssetResponseDto,
  type UpdateAssetDto,
  type UserAdminResponseDto,
} from '@immich/sdk';
import { RECIPE_KEY, RENDER_KEY, normalizeRecipe } from '@immich-raw/recipe';
import { httpStatus } from './api.ts';
import { cacheOriginal, forgetOriginal } from './download.ts';
import { copyAlbums, errorMessage, readMetadata, renderUpdate, writeMetadata } from './save.ts';
import { sha1Base64, uploadAsset } from './upload.ts';

export const CONVERTED_KEY = 'raw-editor.converted';

export type DeleteMode = 'permanent' | 'trash';
export type ReplaceStep = 'upload' | 'copy' | 'stack' | 'delete';

const STEP_LABELS: Record<ReplaceStep, string> = {
  upload: 'uploading the DNG',
  copy: 'copying albums, tags and details',
  stack: 'updating the stack',
  delete: 'deleting the original',
};

type RawInfo = Pick<AssetResponseDto, 'id' | 'ownerId' | 'libraryId' | 'isTrashed' | 'visibility' | 'tags' | 'stack' | 'exifInfo'>;

/** Why this RAW can't be converted, or null if it can. */
export function convertBlocked(raw: RawInfo, me: Pick<UserAdminResponseDto, 'id'> | null): string | null {
  if (!me || raw.ownerId !== me.id) return 'Only the owner of a photo can convert it.';
  if (raw.libraryId) return 'This photo is in an external library: Immich can\'t delete its file, so converting would not save space.';
  if (raw.isTrashed) return 'This photo is in the trash.';
  if (raw.visibility === AssetVisibility.Locked) return 'Photos in the locked folder can\'t be converted.';
  return null;
}

export interface ReplacePlan {
  /** Fields set on the DNG after the upload. */
  update: UpdateAssetDto;
  tagIds: string[];
  force: boolean;
}

/** The parts of the replacement that only depend on the RAW (pure, for tests). */
export function planReplace(raw: RawInfo, mode: DeleteMode): ReplacePlan {
  const update: UpdateAssetDto = renderUpdate(raw as AssetResponseDto);
  if (raw.visibility === AssetVisibility.Archive || raw.visibility === AssetVisibility.Hidden) update.visibility = raw.visibility;
  return { update, tagIds: (raw.tags ?? []).map((t) => t.id), force: mode === 'permanent' };
}

export interface ReplaceOptions {
  raw: AssetResponseDto;
  dng: { bytes: Uint8Array; fileName: string };
  deleteMode: DeleteMode;
  /** Stored on the DNG (raw-editor.converted), so it's clear where it came from. */
  conversion: Record<string, unknown>;
  onProgress?: (step: ReplaceStep, fraction: number) => void;
}

/** Runs the replacement; returns the DNG's asset id. */
export async function replaceWithDng({ raw, dng, deleteMode, conversion, onProgress }: ReplaceOptions): Promise<string> {
  let step: ReplaceStep = 'upload';
  const progress = (s: ReplaceStep, f: number) => {
    step = s;
    onProgress?.(s, f);
  };
  const plan = planReplace(raw, deleteMode);
  let dngId: string | null = null;
  let created = false;
  try {
    progress('upload', 0);
    // The RAW's own keys (recipe, history and snapshots) move to the DNG.
    const items = (await getAssetMetadata({ id: raw.id }).catch(() => []))
      .filter((i) => i.key.startsWith('raw-editor.') && i.key !== CONVERTED_KEY)
      .map((i) => ({ key: i.key, value: i.value as Record<string, unknown> }));
    items.push({
      key: CONVERTED_KEY,
      value: { ...conversion, from: { id: raw.id, originalFileName: raw.originalFileName, checksum: raw.checksum }, at: new Date().toISOString() },
    });
    const blob = new Blob([dng.bytes as BlobPart], { type: 'image/x-adobe-dng' });
    const checksum = await sha1Base64(blob);
    const up = await uploadAsset(
      {
        file: blob,
        filename: dng.fileName,
        fileCreatedAt: raw.fileCreatedAt,
        fileModifiedAt: raw.fileModifiedAt,
        isFavorite: raw.isFavorite,
        metadata: items,
        checksum,
      },
      (f) => progress('upload', f),
    );
    dngId = up.id;
    created = up.status === 'created';
    if (!created) {
      // Same bytes uploaded before (an earlier attempt): reuse it, out of the trash if needed.
      const info = await getAssetInfo({ id: dngId });
      if (info.isTrashed) await restoreAssets({ bulkIdsDto: { ids: [dngId] } });
      for (const item of items) await writeMetadata(dngId, item.key, item.value);
    }

    progress('copy', 0);
    try {
      await copyAsset({ assetCopyDto: { sourceId: raw.id, targetId: dngId, albums: true, sharedLinks: true, stack: true, favorite: true, sidecar: true } });
    } catch (e) {
      // API keys without asset.copy: do albums and stack by hand (shared links are lost).
      if (httpStatus(e) !== 403) throw e;
      await copyAlbums(raw.id, dngId);
      if (raw.stack) await createStack({ stackCreateDto: { assetIds: [raw.stack.primaryAssetId, dngId] } });
    }
    if (Object.keys(plan.update).length) await updateAsset({ id: dngId, updateAssetDto: plan.update });
    if (plan.tagIds.length) await bulkTagAssets({ tagBulkAssetsDto: { tagIds: plan.tagIds, assetIds: [dngId] } });
    progress('copy', 1);

    progress('stack', 0);
    const fresh = await getAssetInfo({ id: raw.id });
    if (fresh.stack && fresh.stack.primaryAssetId === raw.id) {
      await updateStack({ id: fresh.stack.id, stackUpdateDto: { primaryAssetId: dngId } });
    }
    // The edited JPEG points back to its source.
    const recipe = await readMetadata(raw.id, RECIPE_KEY).catch(() => null);
    const renderId = recipe ? normalizeRecipe(recipe).render?.assetId : undefined;
    if (renderId) {
      const ref = await readMetadata(renderId, RENDER_KEY).catch(() => null);
      if (ref && ref.sourceAssetId === raw.id) await writeMetadata(renderId, RENDER_KEY, { ...ref, sourceAssetId: dngId });
    }
    progress('stack', 1);
  } catch (e) {
    if (dngId && created) {
      try {
        await deleteAssets({ assetBulkDeleteDto: { ids: [dngId], force: true } });
      } catch {
        // leaves an extra DNG behind; the RAW is untouched either way
      }
    }
    throw new Error(`Converting failed while ${STEP_LABELS[step]}: ${errorMessage(e)}. The original was not changed.`);
  }

  // Point of no return.
  progress('delete', 0);
  try {
    await deleteAssets({ assetBulkDeleteDto: { ids: [raw.id], force: plan.force } });
  } catch (e) {
    throw new Error(`The DNG was added, but deleting the original failed: ${errorMessage(e)}. Delete it in Immich by hand.`);
  }
  progress('delete', 1);
  void forgetOriginal(raw.checksum);
  return dngId;
}

/** After a conversion: the DNG's bytes are known, so opening it needs no download. */
export async function cacheDng(dngId: string, bytes: Uint8Array): Promise<void> {
  try {
    const info = await getAssetInfo({ id: dngId });
    await cacheOriginal(info.checksum, bytes);
  } catch {
    // caching is optional
  }
}
