import { describe, expect, it } from 'vitest';
import { arrangeGroups, badgeFor, describeMetrics, tooltipFor } from './cull-view.ts';
import type { CullInfo } from './culler.ts';

const info = (groupId: string, rank: number, role: CullInfo['role'], reason: CullInfo['reason'] = null, metrics = {}): CullInfo => ({
  groupId,
  frameId: `f${rank}`,
  role,
  reason,
  rank,
  groupSize: 3,
  pinned: false,
  metrics,
});

// Time order: a1 x a2 b1 a3 b2 (two stacks interleaved with a loose photo x).
const items = ['a1', 'x', 'a2', 'b1', 'a3', 'b2'].map((id) => ({ id }));
const cull: Record<string, CullInfo> = {
  a1: info('A', 3, 'rejected', 'blur'),
  a2: info('A', 1, 'best'),
  a3: info('A', 2, 'runner-up'),
  b1: info('B', 2, 'rejected', 'lighting'),
  b2: info('B', 1, 'best'),
};

const ids = (s: { asset: { id: string } }[]) => s.map((x) => x.asset.id);

describe('arrangeGroups', () => {
  it('puts a stack together where it starts, best first', () => {
    const strip = arrangeGroups(items, cull, new Set());
    expect(ids(strip)).toEqual(['a2', 'a3', 'a1', 'x', 'b2', 'b1']);
    expect(strip.map((s) => s.group?.first ?? null)).toEqual([true, false, false, null, true, false]);
    expect(strip[2]!.group).toMatchObject({ last: true, size: 3 });
  });

  it('a collapsed stack shows its best photo with the hidden count', () => {
    const strip = arrangeGroups(items, cull, new Set(['A']));
    expect(ids(strip)).toEqual(['a2', 'x', 'b2', 'b1']);
    expect(strip[0]!.group).toMatchObject({ collapsed: true, hidden: 2, first: true, last: true });
  });

  it('a collapsed stack shows the photo being edited instead of the best', () => {
    expect(ids(arrangeGroups(items, cull, new Set(['A']), 'a1'))).toEqual(['a1', 'x', 'b2', 'b1']);
  });

  it('a stack with only one photo in the strip is shown as a plain photo', () => {
    const strip = arrangeGroups([{ id: 'a1' }, { id: 'x' }], cull, new Set());
    expect(strip.map((s) => s.group)).toEqual([null, null]);
    expect(strip[0]!.info?.reason).toBe('blur');
  });

  it('without culler data the order is unchanged', () => {
    expect(ids(arrangeGroups(items, {}, new Set()))).toEqual(['a1', 'x', 'a2', 'b1', 'a3', 'b2']);
  });
});

describe('badges and tooltips', () => {
  it('names the reason', () => {
    expect(badgeFor(cull.a2!)?.icon).toBe('★');
    expect(badgeFor(cull.a3!)?.tone).toBe('runner-up');
    expect(badgeFor(cull.a1!)?.label).toBe('Rejected: not sharp');
    expect(badgeFor(info('A', 2, 'rejected', 'eyes'))?.label).toBe('Rejected: eyes closed');
    expect(badgeFor(null)).toBeNull();
  });

  it('explains the measurements', () => {
    const dark = info('A', 3, 'rejected', 'lighting', { evVsBest: -1.5, clipHiPct: 0, sharpPct: 98 });
    expect(describeMetrics(dark)).toEqual(['−1.5 EV vs best']);
    const soft = info('A', 3, 'rejected', 'blur', { evVsBest: 0.1, sharpPct: 54, faces: 3, closed: 0 });
    expect(describeMetrics(soft)).toEqual(['sharpness 54 % of best', '3 faces, eyes open']);
    const blink = info('A', 2, 'rejected', 'eyes', { faces: 3, closed: 2 });
    expect(describeMetrics(blink)).toEqual(['2 of 3 faces with eyes closed']);
    expect(tooltipFor('DSC1.ARW', soft)).toBe('DSC1.ARW\nRejected: not sharp (3 of 3)\nsharpness 54 % of best\n3 faces, eyes open');
    expect(tooltipFor('DSC1.ARW', null)).toBe('DSC1.ARW');
  });
});
