import type { AssetResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import type { CullInfo } from './culler.ts';
import { buildStackView, frameIndexOf, isBracketView, planDeleteOthers, preferredFrame, step } from './stack-view.ts';

const asset = (id: string, name: string, extra: Partial<AssetResponseDto> = {}) =>
  ({ id, originalFileName: name, fileCreatedAt: '2024-05-01T10:00:00.000Z', isTrashed: false, ...extra }) as AssetResponseDto;

const info = (frameId: string, rank: number, role: CullInfo['role'], groupId = 'G'): CullInfo => ({
  groupId,
  frameId,
  role,
  reason: role === 'rejected' ? 'blur' : null,
  rank,
  groupSize: 3,
  pinned: false,
  metrics: {},
});

// Three shots: 1 (RAW + JPEG + edit, best), 2 (RAW only, runner-up), 3 (RAW + JPEG, rejected).
const members = [
  asset('r3', 'DSC3.ARW'),
  asset('j3', 'DSC3.JPG'),
  asset('r1', 'DSC1.ARW'),
  asset('j1', 'DSC1.JPG'),
  asset('e1', 'DSC1.edit.jpg'),
  asset('r2', 'DSC2.ARW'),
];
const cull: Record<string, CullInfo> = {
  r1: info('F1', 1, 'best'),
  j1: info('F1', 1, 'best'),
  e1: info('F1', 1, 'best'),
  r2: info('F2', 2, 'runner-up'),
  r3: info('F3', 3, 'rejected'),
  j3: info('F3', 3, 'rejected'),
};
const stack = { id: 'S', primaryAssetId: 'e1', assets: members };

const fileIds = (f: { assets: { id: string }[] }) => f.assets.map((a) => a.id).sort();

describe('buildStackView', () => {
  it('groups the files into shots, best first', () => {
    const v = buildStackView(stack, cull, {}, 'G');
    expect(v.frames.map((f) => f.frameId)).toEqual(['F1', 'F2', 'F3']);
    expect(fileIds(v.frames[0]!)).toEqual(['e1', 'j1', 'r1']);
    expect(v.frames.map((f) => f.raw?.id)).toEqual(['r1', 'r2', 'r3']);
    expect(v.unsorted).toEqual([]);
  });

  it('shows the edit, else the camera JPEG, else the RAW', () => {
    const v = buildStackView({ ...stack, primaryAssetId: 'r2' }, cull, {}, 'G');
    expect(v.frames.map((f) => f.face.id)).toEqual(['e1', 'r2', 'j3']);
  });

  it('the stack front wins within its shot', () => {
    const v = buildStackView({ ...stack, primaryAssetId: 'j1' }, cull, {}, 'G');
    expect(v.frames[0]!.face.id).toBe('j1');
  });

  it('a render saved after the last culler run joins its RAW', () => {
    const late = asset('e2', 'DSC2.edit.jpg');
    const v = buildStackView({ ...stack, assets: [...members, late] }, cull, { e2: 'r2' }, 'G');
    expect(fileIds(v.frames[1]!)).toEqual(['e2', 'r2']);
    expect(v.frames[1]!.face.id).toBe('e2');
    expect(v.frames[1]!.pickId).toBe('r2');
  });

  it("keeps files the culler doesn't know (or of another group) apart, and skips trash", () => {
    const stranger = asset('x', 'other.jpg');
    const foreign = asset('y', 'DSC9.ARW');
    const trashed = asset('t', 'DSC4.ARW', { isTrashed: true });
    const v = buildStackView({ ...stack, assets: [...members, stranger, foreign, trashed] }, { ...cull, y: info('F9', 1, 'best', 'H'), t: info('F4', 4, 'rejected') }, {}, 'G');
    expect(v.unsorted.map((a) => a.id).sort()).toEqual(['x', 'y']);
    expect(v.frames).toHaveLength(3);
  });
});

describe('planDeleteOthers', () => {
  const v = buildStackView({ ...stack, assets: [...members, asset('x', 'other.jpg')] }, cull, {}, 'G');

  it('trashes every file of every other shot', () => {
    const p = planDeleteOthers(v, 'F1');
    expect(p.shots).toBe(2);
    expect(p.trashIds.sort()).toEqual(['j3', 'r2', 'r3']);
  });

  it("never touches the kept shot or files the culler doesn't know", () => {
    const p = planDeleteOthers(v, 'F3');
    expect(p.trashIds.sort()).toEqual(['e1', 'j1', 'r1', 'r2']);
    expect(p.trashIds).not.toContain('x');
  });

  it('refuses an unknown shot', () => {
    expect(() => planDeleteOthers(v, 'nope')).toThrow();
  });
});

describe('navigation', () => {
  const v = buildStackView(stack, cull, {}, 'G');

  it('stops at the ends', () => {
    expect(step(0, -1, 3)).toBe(0);
    expect(step(0, 1, 3)).toBe(1);
    expect(step(2, 1, 3)).toBe(2);
    expect(step(0, 1, 0)).toBe(0);
  });

  it('starts on the shot of any of its files', () => {
    expect(frameIndexOf(v, 'j3')).toBe(2);
    expect(frameIndexOf(v, 'unknown')).toBe(0);
  });

  it('the preferred shot is the best one', () => {
    expect(preferredFrame(v)?.frameId).toBe('F1');
    expect(isBracketView(v)).toBe(false);
  });

  it('an exposure bracket keeps its front shot in front and offers no "delete others"', () => {
    const bracket: Record<string, CullInfo> = {
      r1: info('F1', 2, 'bracket'),
      j1: info('F1', 2, 'bracket'),
      e1: info('F1', 2, 'bracket'),
      r2: info('F2', 1, 'bracket'),
      r3: info('F3', 3, 'bracket'),
      j3: info('F3', 3, 'bracket'),
    };
    const b = buildStackView(stack, bracket, {}, 'G');
    expect(b.frames.map((f) => f.frameId)).toEqual(['F2', 'F1', 'F3']);
    expect(preferredFrame(b)?.frameId).toBe('F2');
    expect(isBracketView(b)).toBe(true);
  });
});
