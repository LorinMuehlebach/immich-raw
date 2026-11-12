// Saves an AI-upscaled copy of an edit to Immich: a new JPEG in the RAW's stack, behind whatever
// is in front. Unlike Save, it is not the RAW's render: the next Save leaves it alone. It carries
// the render tag pointing at the RAW, and its name ends in .edit.jpg, so Immich's Edit button,
// the culler, the stack window and the album export all treat it as made from that RAW.
import { createStack, getAssetInfo, restoreAssets, updateAsset, type AssetResponseDto } from '@immich/sdk';
import { APP_ID, RENDER_KEY } from '@immich-raw/recipe';
import { copyAlbums, copyCullTags, errorMessage, renderUpdate } from './save.ts';
import { sha1Base64, uploadAsset } from './upload.ts';

export type UpscaleSaveStep = 'upload' | 'metadata' | 'stack';

const STEP_LABELS: Record<UpscaleSaveStep, string> = {
  upload: 'uploading the upscaled JPEG',
  metadata: 'copying date, location and albums',
  stack: 'stacking it with the RAW',
};

export interface UpscaledInfo {
  scale: number;
  /** 'sharp' or 'natural'. */
  style: string;
  /** Hash of the edit it was rendered from. */
  recipeHash: string;
}

export interface SaveUpscaledOptions {
  raw: AssetResponseDto;
  jpeg: Blob;
  info: UpscaledInfo;
  onProgress?: (step: UpscaleSaveStep, fraction: number) => void;
}

/** `rawName` 'DSC01234.ARW', 2 -> 'DSC01234.upscaled-2x.edit.jpg'. */
export function upscaledFilename(rawName: string, scale: number): string {
  const dot = rawName.lastIndexOf('.');
  return `${dot > 0 ? rawName.slice(0, dot) : rawName}.upscaled-${scale}x.edit.jpg`;
}

/**
 * The createStack call that adds `newId` to the RAW's stack without changing its front photo:
 * passing the current primary first pulls in its whole stack and keeps it in front (see
 * stack-planner.ts). Empty when the copy is in that stack already (a re-upload of the same bytes).
 */
export function upscaleStackIds(rawId: string, rawStack: { id: string; primaryAssetId: string } | null, newId: string, newStackId: string | null): string[] {
  if (rawStack && newStackId === rawStack.id) return [];
  const primary = rawStack?.primaryAssetId ?? rawId;
  return primary === newId ? [] : [primary, newId];
}

/** Uploads the copy and stacks it; returns its asset id. */
export async function saveUpscaled({ raw, jpeg, info, onProgress }: SaveUpscaledOptions): Promise<string> {
  let step: UpscaleSaveStep = 'upload';
  const progress = (s: UpscaleSaveStep, f: number) => {
    step = s;
    onProgress?.(s, f);
  };
  try {
    progress('upload', 0);
    const uploaded = await uploadAsset(
      {
        file: jpeg,
        filename: upscaledFilename(raw.originalFileName, info.scale),
        fileCreatedAt: raw.fileCreatedAt,
        fileModifiedAt: new Date().toISOString(),
        isFavorite: raw.isFavorite,
        metadata: [{ key: RENDER_KEY, value: { sourceAssetId: raw.id, recipeHash: info.recipeHash, app: APP_ID, upscale: { scale: info.scale, style: info.style } } }],
        checksum: await sha1Base64(jpeg),
      },
      (f) => progress('upload', f),
    );
    const id = uploaded.id;

    progress('metadata', 0);
    const dto = renderUpdate(raw);
    if (Object.keys(dto).length) await updateAsset({ id, updateAssetDto: dto });
    await copyAlbums(raw.id, id);
    await copyCullTags(raw, id);
    progress('metadata', 1);

    progress('stack', 0);
    // Re-read both: the RAW's stack may have changed, and a re-upload can be in the trash.
    const [freshRaw, copy] = await Promise.all([getAssetInfo({ id: raw.id }), getAssetInfo({ id })]);
    if (copy.isTrashed) await restoreAssets({ bulkIdsDto: { ids: [id] } });
    const rawStack = freshRaw.stack ? { id: freshRaw.stack.id, primaryAssetId: freshRaw.stack.primaryAssetId } : null;
    const ids = upscaleStackIds(raw.id, rawStack, id, copy.stack?.id ?? null);
    if (ids.length >= 2) await createStack({ stackCreateDto: { assetIds: ids } });
    progress('stack', 1);
    return id;
  } catch (e) {
    throw new Error(`Saving the upscaled copy failed while ${STEP_LABELS[step]}: ${errorMessage(e)}`);
  }
}
