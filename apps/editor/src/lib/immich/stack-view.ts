// The stack window: the shots of one culler stack, best first, and "delete others".
// A shot (the culler's frame) is one press of the shutter: its RAW, the camera JPEG and the
// editor's renders. Immich's stack holds all of them; the culler says which shot each file is.
import { deleteAssets, getAssetInfo, getStack, type AssetResponseDto } from '@immich/sdk';
import { RENDER_KEY } from '@immich-raw/recipe';
import { isRawFilename } from '@immich-raw/inject/raw';
import { lookupCull, recullGroup, waitForRun, type CullInfo } from './culler.ts';
import { readMetadata } from './save.ts';

export interface StackFrame {
  frameId: string;
  info: CullInfo;
  /** A file of the shot the culler knows (what "make preferred" names). */
  pickId: string;
  /** Every file of the shot. */
  assets: AssetResponseDto[];
  /** The file shown for the shot: its edit, else the camera JPEG, else the RAW. */
  face: AssetResponseDto;
  /** The RAW to open in the editor, if the shot has one. */
  raw: AssetResponseDto | null;
}

export interface StackView {
  stackId: string;
  groupId: string;
  /** Best first, in the culler's order. */
  frames: StackFrame[];
  /** Files in the stack the culler doesn't know. They are never deleted. */
  unsorted: AssetResponseDto[];
}

const isRender = (a: Pick<AssetResponseDto, 'originalFileName'>) => a.originalFileName.toLowerCase().endsWith('.edit.jpg');

/** The culler's order for the front of a shot: its edit, the camera JPEG, the RAW. */
function faceOf(assets: AssetResponseDto[], primaryId: string | null): AssetResponseDto {
  const primary = assets.find((a) => a.id === primaryId);
  if (primary) return primary;
  const newest = (list: AssetResponseDto[]) => [...list].sort((x, y) => Date.parse(y.fileCreatedAt) - Date.parse(x.fileCreatedAt))[0];
  return newest(assets.filter(isRender)) ?? assets.find((a) => !isRawFilename(a.originalFileName)) ?? assets[0]!;
}

/**
 * Groups the stack's files into shots.
 * - `cull`: what the culler knows per file; only files of `groupId` count.
 * - `renderSources`: render id -> RAW id, for renders saved after the culler last looked.
 */
export function buildStackView(
  stack: { id: string; primaryAssetId: string; assets: AssetResponseDto[] },
  cull: Record<string, CullInfo>,
  renderSources: Record<string, string>,
  groupId: string,
): StackView {
  const live = stack.assets.filter((a) => !a.isTrashed);
  const frameOf = (a: AssetResponseDto): string | null => {
    const own = cull[a.id];
    if (own) return own.groupId === groupId ? own.frameId : null;
    const source = renderSources[a.id];
    const viaSource = source ? cull[source] : undefined;
    return viaSource?.groupId === groupId ? viaSource.frameId : null;
  };

  const byFrame = new Map<string, AssetResponseDto[]>();
  const unsorted: AssetResponseDto[] = [];
  for (const a of live) {
    const fid = frameOf(a);
    if (fid) byFrame.set(fid, [...(byFrame.get(fid) ?? []), a]);
    else unsorted.push(a);
  }

  const frames: StackFrame[] = [];
  for (const [frameId, assets] of byFrame) {
    const known = assets.find((a) => cull[a.id]);
    if (!known) {
      unsorted.push(...assets);
      continue;
    }
    frames.push({
      frameId,
      info: cull[known.id]!,
      pickId: known.id,
      assets,
      face: faceOf(assets, stack.primaryAssetId),
      raw: assets.find((a) => isRawFilename(a.originalFileName)) ?? null,
    });
  }
  const rank = (f: StackFrame) => f.info.rank ?? Number.MAX_SAFE_INTEGER;
  frames.sort((x, y) => rank(x) - rank(y) || x.face.originalFileName.localeCompare(y.face.originalFileName));
  return { stackId: stack.id, groupId, frames, unsorted };
}

/** An exposure bracket: kept whole, so "delete others" isn't offered. */
export function isBracketView(view: StackView): boolean {
  return view.frames.length > 0 && view.frames.every((f) => f.info.role === 'bracket');
}

/** The best shot (the one "delete others" keeps). */
export function preferredFrame(view: StackView): StackFrame | null {
  return view.frames.find((f) => f.info.role === 'best') ?? view.frames[0] ?? null;
}

export interface DeletePlan {
  /** Files to move to the trash: every file of every other shot. */
  trashIds: string[];
  /** How many shots go. */
  shots: number;
}

export function planDeleteOthers(view: StackView, keepFrameId: string): DeletePlan {
  if (!view.frames.some((f) => f.frameId === keepFrameId)) throw new Error('That shot is not in this stack');
  const others = view.frames.filter((f) => f.frameId !== keepFrameId);
  return { trashIds: others.flatMap((f) => f.assets.map((a) => a.id)), shots: others.length };
}

/** Next index for the arrows: stops at the ends. */
export function step(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, index + delta));
}

/** Index of the shot that holds `assetId` (any of its files), else 0. */
export function frameIndexOf(view: StackView, assetId: string): number {
  return Math.max(0, view.frames.findIndex((f) => f.assets.some((a) => a.id === assetId)));
}

/**
 * The stack window's data for the stack `assetId` is in. Null when the photo isn't stacked,
 * the culler isn't installed, or the culler didn't make this stack.
 */
export async function loadStackView(assetId: string): Promise<StackView | null> {
  const asset = await getAssetInfo({ id: assetId });
  if (!asset.stack) return null;
  const stack = await getStack({ id: asset.stack.id });
  const ids = stack.assets.map((a) => a.id);
  const cull = await lookupCull(ids);
  const groupId = cull?.[assetId]?.groupId ?? Object.values(cull ?? {})[0]?.groupId;
  if (!cull || !groupId) return null;
  const renderSources: Record<string, string> = {};
  await Promise.all(
    stack.assets
      .filter((a) => !a.isTrashed && !cull[a.id] && isRender(a))
      .map(async (a) => {
        const source = (await readMetadata(a.id, RENDER_KEY).catch(() => null))?.sourceAssetId;
        if (typeof source === 'string') renderSources[a.id] = source;
      }),
  );
  return buildStackView(stack, cull, renderSources, groupId);
}

export interface DeleteResult {
  trashed: string[];
  /** The files are in the trash, but the culler couldn't tidy up the stack. */
  warning: string | null;
}

/**
 * Moves every other shot to Immich's trash, then has the culler sort the group again. With one
 * shot left it takes the burst stack apart, pairs RAW + JPEG again and removes its tags.
 */
export async function deleteOthers(view: StackView, keepFrameId: string): Promise<DeleteResult> {
  const { trashIds } = planDeleteOthers(view, keepFrameId);
  if (!trashIds.length) return { trashed: [], warning: null };
  await deleteAssets({ assetBulkDeleteDto: { ids: trashIds } });
  try {
    const run = await waitForRun(await recullGroup(view.groupId));
    if (run.status === 'failed') return { trashed: trashIds, warning: `The culler couldn't update the stack: ${run.error ?? 'unknown error'}` };
  } catch (e) {
    return { trashed: trashIds, warning: `The culler couldn't update the stack: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { trashed: trashIds, warning: null };
}
