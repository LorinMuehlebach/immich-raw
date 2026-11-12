// Decides which Immich calls put a new render on top of its RAW. Pure, so it can be tested.
//
// Immich facts this relies on (checked against v3.3.6 in M0):
// - createStack(ids) makes ids[0] the primary and absorbs every stack whose *primary* is in
//   ids; those stacks are deleted. Passing the RAW's current primary therefore pulls in the
//   whole existing stack (camera JPEG, older renders).
// - A non-primary member of some other stack is moved but leaves that stack behind with one
//   asset, so only the RAW's own stack primary is ever passed.
// - Uploading bytes that match a trashed asset returns that asset (still trashed).
// - The culler (services/culler) stacks several captures of one scene with the best in front.
//   Saving an edit of another capture in such a stack must not move it to the front.
// - A virtual copy's render (copies.ts) joins the stack behind the front photo: the original's
//   edit stays in front, unless the front is still the RAW itself or that copy's own render.
import { captureBaseName, isRawFilename } from '@immich-raw/inject/raw';

export interface StackPlanInput {
  rawId: string;
  /** The RAW's current stack, if any. */
  rawStack: { id: string; primaryAssetId: string } | null;
  newRenderId: string;
  /** The render recorded in the edit's recipe from the last save, if it still exists. */
  previousRender: { id: string; isTrashed: boolean; sourceAssetId: string | null; copyId?: string | null } | null;
  /** The virtual copy being saved; null or absent for the original edit. */
  copyId?: string | null;
  /** The upload returned an existing asset with the same checksum. */
  uploadWasDuplicate: boolean;
  /** For duplicates: the returned asset is in the trash. */
  newRenderIsTrashed?: boolean;
  /** The stack's front photo belongs to another capture (see keepsOtherCaptureInFront). */
  keepPrimary?: boolean;
}

export interface StackPlan {
  /** Restore these from trash first. */
  restoreIds: string[];
  /** createStack with these ids (render first); empty = nothing to do. */
  createStackIds: string[];
  /** Move these to trash last. */
  trashIds: string[];
}

export function planStack(input: StackPlanInput): StackPlan {
  const { rawId, rawStack, newRenderId, previousRender, uploadWasDuplicate, newRenderIsTrashed, keepPrimary } = input;
  const copyId = input.copyId ?? null;

  const restoreIds = uploadWasDuplicate && newRenderIsTrashed ? [newRenderId] : [];

  const currentPrimary = rawStack?.primaryAssetId ?? rawId;
  // A copy's render takes the front only from the RAW itself or from its own previous render.
  const behind = keepPrimary || (!!copyId && currentPrimary !== rawId && currentPrimary !== previousRender?.id);
  // Passing the current primary absorbs the whole stack; only its order decides who is in front.
  const createStackIds =
    currentPrimary === newRenderId ? [] : behind ? unique([currentPrimary, newRenderId]) : unique([newRenderId, currentPrimary, rawId]);

  // Only the same edit's previous render: the original's and each copy's are kept apart.
  const trashIds =
    previousRender &&
    previousRender.id !== newRenderId &&
    previousRender.id !== rawId &&
    !previousRender.isTrashed &&
    previousRender.sourceAssetId === rawId &&
    (previousRender.copyId ?? null) === copyId
      ? [previousRender.id]
      : [];

  return { restoreIds, createStackIds, trashIds };
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

const SAME_CAPTURE_MS = 2000;

export interface StackMemberLike {
  id: string;
  originalFileName: string;
  fileCreatedAt: string;
  isTrashed?: boolean;
}

/** True when `primary` is the RAW itself, a render of it, or its camera JPEG (same name and time). */
export function isSameCapture(raw: StackMemberLike, primary: StackMemberLike, primaryRenderSource: string | null): boolean {
  if (primary.id === raw.id || primaryRenderSource === raw.id) return true;
  if (captureBaseName(primary.originalFileName) !== captureBaseName(raw.originalFileName)) return false;
  return Math.abs(Date.parse(primary.fileCreatedAt) - Date.parse(raw.fileCreatedAt)) <= SAME_CAPTURE_MS;
}

/**
 * A stack of several captures (it holds another RAW) whose front photo is not this RAW's capture:
 * the render joins it without taking the front.
 */
export function keepsOtherCaptureInFront(
  raw: StackMemberLike,
  primary: StackMemberLike,
  members: StackMemberLike[],
  primaryRenderSource: string | null,
): boolean {
  if (isSameCapture(raw, primary, primaryRenderSource)) return false;
  return members.some((m) => m.id !== raw.id && !m.isTrashed && isRawFilename(m.originalFileName));
}
