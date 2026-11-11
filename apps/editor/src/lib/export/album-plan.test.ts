import { describe, expect, it } from 'vitest';
import { mapLimit, planItems, type PlanAsset } from './album-plan.ts';

const a = (id: string, originalFileName: string, extra: Partial<PlanAsset> = {}): PlanAsset => ({
  id,
  originalFileName,
  type: 'IMAGE',
  fileCreatedAt: '2024-05-01T10:00:00.000Z',
  ...extra,
});

describe('planItems', () => {
  it('exports RAWs once, renders as their RAW, and skips videos', () => {
    const { items, renders, skipped } = planItems(
      [
        a('r1', 'DSC001.ARW'),
        a('e1', 'DSC001.edit.jpg', { sourceId: 'r1' }),
        a('e2', 'DSC009.edit.jpg', { sourceId: 'r9' }),
        a('v1', 'clip.mp4', { type: 'VIDEO' }),
        a('p1', 'phone.jpg', { fileCreatedAt: '2024-05-02T10:00:00.000Z' }),
      ],
      true,
    );
    expect(items).toEqual([
      { kind: 'raw', id: 'r1', name: 'DSC001.ARW' },
      { kind: 'raw', id: 'r9', name: 'DSC009.edit.jpg' },
      { kind: 'image', id: 'p1', name: 'phone.jpg' },
    ]);
    expect(renders).toBe(2);
    expect(skipped).toEqual({ videos: 1, jpegTwins: 0 });
  });

  it('skips the camera JPEG of a RAW in the album when asked', () => {
    const assets = [a('r1', 'DSC001.ARW'), a('j1', 'DSC001.JPG', { fileCreatedAt: '2024-05-01T10:00:01.000Z' }), a('j2', 'DSC001.JPG', { fileCreatedAt: '2024-06-01T10:00:00.000Z' })];
    const skip = planItems(assets, true);
    expect(skip.items.map((i) => i.id)).toEqual(['r1', 'j2']);
    expect(skip.skipped.jpegTwins).toBe(1);
    expect(planItems(assets, false).items.map((i) => i.id)).toEqual(['r1', 'j1', 'j2']);
  });

  it('exports a render without a known RAW as an image', () => {
    const plan = planItems([a('e1', 'X.edit.jpg', { sourceId: null })], true);
    expect(plan.items).toEqual([{ kind: 'image', id: 'e1', name: 'X.edit.jpg' }]);
    expect(plan.renders).toBe(0);
  });
});

describe('mapLimit', () => {
  it('keeps order and the limit', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10 + i;
    });
    expect(out).toEqual([50, 11, 42, 23, 34]);
    expect(peak).toBe(2);
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});
