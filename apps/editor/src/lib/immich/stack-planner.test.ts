import { describe, expect, it } from 'vitest';
import { isSameCapture, keepsOtherCaptureInFront, planStack } from './stack-planner.ts';

const RAW = 'raw';
const JPEG = 'camera-jpeg';
const R1 = 'render-1';
const R2 = 'render-2';

describe('planStack', () => {
  it('first save of a lone RAW: stack render over RAW', () => {
    expect(planStack({ rawId: RAW, rawStack: null, newRenderId: R1, previousRender: null, uploadWasDuplicate: false })).toEqual({
      restoreIds: [],
      createStackIds: [R1, RAW],
      trashIds: [],
    });
  });

  it('RAW in a camera RAW+JPEG stack: pass the JPEG (primary) so the whole stack is absorbed', () => {
    const plan = planStack({
      rawId: RAW,
      rawStack: { id: 's1', primaryAssetId: JPEG },
      newRenderId: R1,
      previousRender: null,
      uploadWasDuplicate: false,
    });
    expect(plan.createStackIds).toEqual([R1, JPEG, RAW]);
    expect(plan.trashIds).toEqual([]);
  });

  it('RAW is itself the stack primary: no duplicate ids', () => {
    const plan = planStack({
      rawId: RAW,
      rawStack: { id: 's1', primaryAssetId: RAW },
      newRenderId: R1,
      previousRender: null,
      uploadWasDuplicate: false,
    });
    expect(plan.createStackIds).toEqual([R1, RAW]);
  });

  it('re-save: new render on top, previous render (the current primary) trashed', () => {
    const plan = planStack({
      rawId: RAW,
      rawStack: { id: 's2', primaryAssetId: R1 },
      newRenderId: R2,
      previousRender: { id: R1, isTrashed: false, sourceAssetId: RAW },
      uploadWasDuplicate: false,
    });
    expect(plan).toEqual({ restoreIds: [], createStackIds: [R2, R1, RAW], trashIds: [R1] });
  });

  it('re-save with identical bytes: the duplicate is the current render, nothing to stack or trash', () => {
    const plan = planStack({
      rawId: RAW,
      rawStack: { id: 's2', primaryAssetId: R1 },
      newRenderId: R1,
      previousRender: { id: R1, isTrashed: false, sourceAssetId: RAW },
      uploadWasDuplicate: true,
      newRenderIsTrashed: false,
    });
    expect(plan).toEqual({ restoreIds: [], createStackIds: [], trashIds: [] });
  });

  it('previous render belongs to a different RAW: leave it alone', () => {
    const plan = planStack({
      rawId: RAW,
      rawStack: { id: 's2', primaryAssetId: R1 },
      newRenderId: R2,
      previousRender: { id: R1, isTrashed: false, sourceAssetId: 'other-raw' },
      uploadWasDuplicate: false,
    });
    expect(plan.trashIds).toEqual([]);
    expect(plan.createStackIds).toEqual([R2, R1, RAW]);
  });

  it('previous render without provenance metadata: leave it alone', () => {
    const plan = planStack({
      rawId: RAW,
      rawStack: null,
      newRenderId: R2,
      previousRender: { id: R1, isTrashed: false, sourceAssetId: null },
      uploadWasDuplicate: false,
    });
    expect(plan.trashIds).toEqual([]);
  });

  it('previous render already trashed: no second trash', () => {
    const plan = planStack({
      rawId: RAW,
      rawStack: { id: 's2', primaryAssetId: RAW },
      newRenderId: R2,
      previousRender: { id: R1, isTrashed: true, sourceAssetId: RAW },
      uploadWasDuplicate: false,
    });
    expect(plan.trashIds).toEqual([]);
    expect(plan.createStackIds).toEqual([R2, RAW]);
  });

  it('duplicate of a trashed asset (going back to an older edit): restore it and stack it', () => {
    const plan = planStack({
      rawId: RAW,
      rawStack: { id: 's3', primaryAssetId: R2 },
      newRenderId: R1,
      previousRender: { id: R2, isTrashed: false, sourceAssetId: RAW },
      uploadWasDuplicate: true,
      newRenderIsTrashed: true,
    });
    expect(plan).toEqual({ restoreIds: [R1], createStackIds: [R1, R2, RAW], trashIds: [R2] });
  });

  describe('with the RAW in front', () => {
    it('first save: RAW in front, render behind', () => {
      expect(planStack({ rawId: RAW, rawStack: null, newRenderId: R1, previousRender: null, uploadWasDuplicate: false, front: 'raw' })).toEqual({
        restoreIds: [],
        createStackIds: [RAW, R1],
        trashIds: [],
      });
    });

    it('re-save: the RAW stays in front, the new render joins, the previous one is trashed', () => {
      const plan = planStack({
        rawId: RAW,
        rawStack: { id: 's2', primaryAssetId: RAW },
        newRenderId: R2,
        previousRender: { id: R1, isTrashed: false, sourceAssetId: RAW },
        uploadWasDuplicate: false,
        front: 'raw',
      });
      expect(plan).toEqual({ restoreIds: [], createStackIds: [RAW, R2], trashIds: [R1] });
    });

    it('switching from a render in front: the RAW takes the front, the whole stack comes along', () => {
      const plan = planStack({
        rawId: RAW,
        rawStack: { id: 's2', primaryAssetId: R1 },
        newRenderId: R2,
        previousRender: { id: R1, isTrashed: false, sourceAssetId: RAW },
        uploadWasDuplicate: false,
        front: 'raw',
      });
      expect(plan).toEqual({ restoreIds: [], createStackIds: [RAW, R1, R2], trashIds: [R1] });
    });

    it('same bytes saved again only to move the RAW to the front', () => {
      const plan = planStack({
        rawId: RAW,
        rawStack: { id: 's2', primaryAssetId: R1 },
        newRenderId: R1,
        previousRender: { id: R1, isTrashed: false, sourceAssetId: RAW },
        uploadWasDuplicate: true,
        newRenderIsTrashed: false,
        front: 'raw',
      });
      expect(plan).toEqual({ restoreIds: [], createStackIds: [RAW, R1], trashIds: [] });
    });

    it('same bytes with the RAW in front already: nothing to do', () => {
      const plan = planStack({
        rawId: RAW,
        rawStack: { id: 's2', primaryAssetId: RAW },
        newRenderId: R1,
        previousRender: { id: R1, isTrashed: false, sourceAssetId: RAW },
        uploadWasDuplicate: true,
        newRenderIsTrashed: false,
        front: 'raw',
      });
      expect(plan).toEqual({ restoreIds: [], createStackIds: [], trashIds: [] });
    });

    it('camera RAW+JPEG stack: the RAW goes in front of the JPEG too', () => {
      const plan = planStack({
        rawId: RAW,
        rawStack: { id: 's1', primaryAssetId: JPEG },
        newRenderId: R1,
        previousRender: null,
        uploadWasDuplicate: false,
        front: 'raw',
      });
      expect(plan.createStackIds).toEqual([RAW, JPEG, R1]);
    });
  });

  it('never trashes the RAW itself, even with corrupt recipe data', () => {
    const plan = planStack({
      rawId: RAW,
      rawStack: null,
      newRenderId: R1,
      previousRender: { id: RAW, isTrashed: false, sourceAssetId: RAW },
      uploadWasDuplicate: false,
    });
    expect(plan.trashIds).toEqual([]);
  });
});

describe('burst stacks made by the culler', () => {
  const at = (id: string, name: string, t: string) => ({ id, originalFileName: name, fileCreatedAt: `2024-05-01T10:00:${t}.000Z` });
  const best = at('best-jpg', 'DSC2.JPG', '01');
  const bestRaw = at('best-raw', 'DSC2.ARW', '01');
  const raw = at('raw', 'DSC1.ARW', '00');
  const cameraJpeg = at('jpg', 'DSC1.JPG', '00');
  const members = [best, bestRaw, raw, cameraJpeg];

  it('editing a photo that is not in front keeps the best in front', () => {
    const plan = planStack({
      rawId: 'raw',
      rawStack: { id: 's', primaryAssetId: 'best-jpg' },
      newRenderId: R1,
      previousRender: null,
      uploadWasDuplicate: false,
      keepPrimary: true,
    });
    expect(plan.createStackIds).toEqual(['best-jpg', R1]);
  });

  it('the best shot stays in front even when Save keeps the RAW in front', () => {
    const plan = planStack({
      rawId: 'raw',
      rawStack: { id: 's', primaryAssetId: 'best-jpg' },
      newRenderId: R1,
      previousRender: null,
      uploadWasDuplicate: false,
      keepPrimary: true,
      front: 'raw',
    });
    expect(plan.createStackIds).toEqual(['best-jpg', R1]);
  });

  it('the best photo itself: its edit goes in front', () => {
    expect(keepsOtherCaptureInFront(bestRaw, best, members, null)).toBe(false);
  });

  it('another capture in front of a burst: keep it there', () => {
    expect(keepsOtherCaptureInFront(raw, best, members, null)).toBe(true);
  });

  it('a render of this RAW in front counts as the same capture', () => {
    const render = at('r', 'DSC1.edit.jpg', '30');
    expect(isSameCapture(raw, render, 'raw')).toBe(true);
    expect(keepsOtherCaptureInFront(raw, render, [render, ...members], 'raw')).toBe(false);
  });

  it('a camera RAW + JPEG pair stacked on its own behaves as before', () => {
    expect(isSameCapture(raw, cameraJpeg, null)).toBe(true);
    const oddlyNamed = at('x', 'IMG_0001.jpg', '00');
    // Different names, but the stack holds no other RAW: not a burst, so the edit goes in front.
    expect(keepsOtherCaptureInFront(raw, oddlyNamed, [raw, oddlyNamed], null)).toBe(false);
  });

  it('same name taken at another time is another capture', () => {
    expect(isSameCapture(raw, at('y', 'DSC1.JPG', '09'), null)).toBe(false);
  });
});
