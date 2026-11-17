// Puts a merged HDR DNG into Immich: uploaded as a new photo with the reference shot's date,
// place, rating, description, albums and tags, and stacked in front of the bracket it was made
// from. The bracket's own photos are not changed (except that they join the stack).
import { createStack, deleteAssets, getAssetInfo, restoreAssets, updateAsset, type AssetResponseDto } from '@immich/sdk';
import { APP_ID } from '@immich-raw/recipe';
import { copyAlbums, copyTags, errorMessage, renderUpdate, writeMetadata } from '../immich/save.ts';
import { sha1Base64, uploadAsset } from '../immich/upload.ts';
import type { BuiltHdr } from './build.ts';
import type { Deghost } from './merge.ts';

/** Asset metadata on the merged DNG: where it came from and how it was made. */
export const HDR_KEY = 'raw-editor.hdr';

export type HdrSaveStep = 'upload' | 'details' | 'stack';

const STEP_LABELS: Record<HdrSaveStep, string> = {
  upload: 'uploading the DNG',
  details: 'copying albums, tags and details',
  stack: 'stacking it with the bracket',
};

/**
 * createStack ids that put the HDR in front of the whole bracket. Passing a stack's primary
 * pulls in that whole stack (see stack-planner.ts), so for a bracket shot that is already in
 * a stack (with its edited JPEG, or stacked by the culler) its stack's primary goes in.
 */
export function hdrStackIds(hdrId: string, frames: Pick<AssetResponseDto, 'id' | 'stack'>[]): string[] {
  const ids = [hdrId, ...frames.map((f) => f.stack?.primaryAssetId ?? f.id)];
  return [...new Set(ids)];
}

export interface SaveHdrOptions {
  built: BuiltHdr;
  /** The bracket's photos. */
  frames: AssetResponseDto[];
  align: boolean;
  deghost: Deghost;
  onProgress?: (step: HdrSaveStep, fraction: number) => void;
}

/** The value stored under HDR_KEY. */
export function hdrRecord(built: BuiltHdr, align: boolean, deghost: Deghost): Record<string, unknown> {
  return {
    app: APP_ID,
    reference: built.reference.id,
    frames: built.frames.map((f) => ({ id: f.id, fileName: f.fileName, ev: Math.round(f.ev * 1000) / 1000, measured: f.measured, shift: f.shift })),
    align,
    deghost,
    headroom: Math.round(built.headroom * 100) / 100,
    at: new Date().toISOString(),
  };
}

/** Uploads and stacks the merged DNG; returns its asset id. */
export async function saveHdr({ built, frames, align, deghost, onProgress }: SaveHdrOptions): Promise<string> {
  let step: HdrSaveStep = 'upload';
  const progress = (s: HdrSaveStep, f: number) => {
    step = s;
    onProgress?.(s, f);
  };
  const ref = built.reference;
  let id: string | null = null;
  let created = false;
  try {
    progress('upload', 0);
    const record = hdrRecord(built, align, deghost);
    const blob = new Blob([built.bytes as BlobPart], { type: 'image/x-adobe-dng' });
    const up = await uploadAsset(
      {
        file: blob,
        filename: built.fileName,
        fileCreatedAt: ref.fileCreatedAt,
        fileModifiedAt: new Date().toISOString(),
        metadata: [{ key: HDR_KEY, value: record }],
        checksum: await sha1Base64(blob),
      },
      (f) => progress('upload', f),
    );
    id = up.id;
    created = up.status === 'created';
    if (!created) {
      // The same merge was uploaded before: use that photo, out of the trash if needed.
      const info = await getAssetInfo({ id });
      if (info.isTrashed) await restoreAssets({ bulkIdsDto: { ids: [id] } });
      await writeMetadata(id, HDR_KEY, record);
    }

    progress('details', 0);
    // Read fresh: search results (how the bracket was found) carry no tags.
    const refInfo = await getAssetInfo({ id: ref.id });
    const dto = renderUpdate(refInfo);
    if (Object.keys(dto).length) await updateAsset({ id, updateAssetDto: dto });
    await copyAlbums(ref.id, id);
    await copyTags(refInfo, id);
    progress('details', 1);

    progress('stack', 0);
    // Fresh: stacks may have changed since the bracket was found.
    const fresh = await Promise.all(frames.map((f) => getAssetInfo({ id: f.id })));
    const ids = hdrStackIds(id, fresh);
    if (ids.length >= 2) await createStack({ stackCreateDto: { assetIds: ids } });
    progress('stack', 1);
    return id;
  } catch (e) {
    if (id && created) {
      try {
        await deleteAssets({ assetBulkDeleteDto: { ids: [id], force: true } });
      } catch {
        // leaves the DNG behind; the bracket is untouched either way
      }
    }
    throw new Error(`Saving the HDR failed while ${STEP_LABELS[step]}: ${errorMessage(e)}`);
  }
}
