import { describe, expect, it } from 'vitest';
import { arrangeGroups, badgeFor, describeMetrics, describeRun, metricRows, runPhase, stackCards, tooltipFor, type MetricRow } from './cull-view.ts';
import type { CullInfo, CullRun, ReportFrame, ReportGroup } from './culler.ts';

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
    expect(badgeFor(info('A', 2, 'rejected', 'eyes'))?.label).toBe('Rejected: eyes (half) closed');
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

describe('metricRows', () => {
  const row = (rows: MetricRow[], label: string) => rows.find((r) => r.label === label);

  it('the best shot is the reference', () => {
    const rows = metricRows({ ...info('A', 1, 'best', null, { evVsBest: 0, sharpPct: 100, clipHiPct: 0.4, clipLoPct: 2, lighting: 0.12, faces: 2, closed: 0 }), pinned: true });
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['Verdict', '★ Best of 3 (your pick)'],
      ['Sharpness', 'reference'],
      ['Exposure', 'reference'],
      ['Exposure error', '0.12 (0 = ideal)'],
      ['Blown highlights', '0.4 %'],
      ['Crushed shadows', '2 %'],
      ['Eyes', '2 faces, eyes open'],
    ]);
    expect(rows.some((r) => r.bad)).toBe(false);
  });

  it('shows every measurement of a runner-up, not only the deciding ones', () => {
    const rows = metricRows(info('A', 2, 'runner-up', null, { evVsBest: 0.1, sharpPct: 97, faces: 0 }));
    expect(row(rows, 'Verdict')?.value).toBe('◐ Runner-up · 2 of 3');
    expect(row(rows, 'Exposure')?.value).toBe('+0.1 EV vs best');
    expect(row(metricRows(info('A', 2, 'runner-up', null, { evVsBest: 0.03 })), 'Exposure')?.value).toBe('±0.0 EV vs best');
    expect(row(rows, 'Sharpness')?.value).toBe('97 % of best');
    expect(row(rows, 'Eyes')?.value).toBe('no faces found');
  });

  it('marks the measurement a shot was rejected for', () => {
    const bad = (reason: 'blur' | 'lighting' | 'eyes') =>
      metricRows(info('A', 3, 'rejected', reason, { evVsBest: -1.5, lighting: 0.9, sharpPct: 54, faces: 3, closed: 1 }))
        .filter((r) => r.bad)
        .map((r) => r.label);
    expect(bad('blur')).toEqual(['Verdict', 'Sharpness']);
    expect(bad('lighting')).toEqual(['Verdict', 'Exposure', 'Exposure error']);
    expect(bad('eyes')).toEqual(['Verdict', 'Eyes']);
    expect(metricRows(info('A', 3, 'rejected', 'eyes', { faces: 3, closed: 1 })).at(-1)?.value).toBe('1 of 3 faces with eyes closed');
    expect(metricRows(info('A', 3, 'rejected', 'lighting', { evVsBest: -1.5 }))[1]?.value).toBe('−1.5 EV vs best');
  });
});

describe('people and smiles', () => {
  const people = { evVsBest: -0.3, sharpPct: 92, faces: 2, closed: 0, judgedOn: 'faces' as const, subjectEv: -2.45, subjectClipHiPct: 3.4, subjectClipLoPct: 0, people: 2, smiling: 1, smileFaces: 2 };

  it('shows what the exposure was judged on, smiles and people', () => {
    const rows = metricRows(info('A', 2, 'runner-up', null, people));
    const value = (label: string) => rows.find((r) => r.label === label)?.value;
    expect(value("Faces' exposure")).toBe('−2.5 EV vs ideal · 3 % blown');
    expect(value('Smiles')).toBe('1 of 2 smiling');
    expect(value('People')).toBe('2 found');
    expect(rows.map((r) => r.label)).toEqual(['Verdict', 'Sharpness', 'Exposure', "Faces' exposure", 'Eyes', 'Smiles', 'People']);
  });

  it("marks the people's exposure when a shot lost for lighting", () => {
    const rows = metricRows(info('A', 3, 'rejected', 'lighting', { ...people, judgedOn: 'people', subjectEv: 1.2, subjectClipHiPct: 0 }));
    expect(rows.find((r) => r.label === "People's exposure")).toEqual({ label: "People's exposure", value: '+1.2 EV vs ideal', bad: true });
    expect(describeMetrics(info('A', 3, 'rejected', 'lighting', { ...people, judgedOn: 'people', subjectEv: 1.2 }))).toContain('people +1.2 EV vs ideal');
  });

  it('judged on the whole photo: no extra row; one face: smiling or not', () => {
    const rows = metricRows(info('A', 2, 'runner-up', null, { judgedOn: 'photo', faces: 1, smiling: 0, smileFaces: 1 }));
    expect(rows.some((r) => r.label.endsWith("' exposure"))).toBe(false);
    expect(rows.find((r) => r.label === 'Smiles')?.value).toBe('not smiling');
  });
});

describe('how open the eyes are', () => {
  const eyesOf = (metrics: Record<string, number>, reason: 'eyes' | null = null) =>
    metricRows(info('A', 2, reason ? 'rejected' : 'runner-up', reason, metrics)).find((r) => r.label === 'Eyes');

  it('shows the openness of one face or several', () => {
    expect(eyesOf({ faces: 1, closed: 0, eyesOpen: 92, eyesLeast: 92 })?.value).toBe('eyes 92 % open');
    expect(eyesOf({ faces: 3, closed: 0, eyesOpen: 85, eyesLeast: 40 }, 'eyes')).toEqual({
      label: 'Eyes',
      value: '3 faces, eyes 85 % open (least 40 %)',
      bad: true,
    });
    expect(eyesOf({ faces: 3, closed: 1, eyesOpen: 60, eyesLeast: 5 })?.value).toBe('3 faces, eyes 60 % open (least 5 %), 1 closed');
  });

  it('older results without the openness keep their wording', () => {
    expect(eyesOf({ faces: 2, closed: 0 })?.value).toBe('2 faces, eyes open');
    expect(describeMetrics(info('A', 2, 'rejected', 'eyes', { faces: 1, closed: 0, eyesOpen: 45, eyesLeast: 45 }))).toContain('eyes 45 % open');
  });
});

describe('runs in words', () => {
  it('sums up what a run found', () => {
    expect(describeRun({ groups: 3, photos: 37, runnerUps: 4, rejected: { lighting: 1, blur: 2, eyes: 0 }, pending: 2 })).toBe(
      "3 stacks from 37 photos · 4 runner-ups · 3 set aside (1 lighting, 2 not sharp) · 2 still waiting for Immich's preview",
    );
    expect(describeRun({ groups: 1, photos: 3, runnerUps: 1 })).toBe('1 stack from 3 photos · 1 runner-up');
    expect(describeRun({ groups: 0, photos: 27, excluded: 23, takenApart: 23 })).toBe(
      '0 stacks from 27 photos · 23 left alone (taken out of stacks in Immich before)',
    );
    expect(describeRun(null)).toBe('nothing to do');
  });

  it('says where a running run is', () => {
    const at = (r: Partial<CullRun>) => runPhase({ status: 'running', phase: null, done: 0, total: 0, ...r } as CullRun);
    expect(runPhase(null)).toBe('starting…');
    expect(at({ status: 'queued' })).toBe('waiting for another run…');
    expect(at({ phase: 'measuring', done: 12, total: 37 })).toBe('measuring 12/37');
    expect(at({ phase: null })).toBe('working…');
  });
});

describe('stackCards', () => {
  const frame = (id: string, rank: number, role: ReportFrame['role'], reason: ReportFrame['reason'] = null, files = [id]): ReportFrame => ({
    frameId: `f-${id}`,
    name: `${id}.ARW`,
    assetIds: files,
    faceId: files.at(-1)!,
    taken: null,
    role,
    reason,
    rank,
    pinned: false,
    metrics: {},
  });
  const groups: ReportGroup[] = [
    {
      id: 'g1',
      primaryId: 'a2j',
      frames: [frame('a1', 3, 'rejected', 'blur'), frame('a2', 1, 'best', null, ['a2', 'a2j']), frame('a3', 2, 'runner-up'), frame('a4', 4, 'rejected', 'lighting')],
    },
    { id: 'g2', primaryId: 'b1', frames: [frame('b1', 1, 'best'), frame('b2', 2, 'runner-up')] },
  ];
  const live = (asset: string, frameId: string, role: CullInfo['role'], rank: number, pinned = false): Record<string, CullInfo> => ({
    [asset]: { groupId: 'g1', frameId, role, reason: null, rank, groupSize: 4, pinned, metrics: {} },
  });

  it("shows each stack's best shot, its size and what was set aside", () => {
    expect(stackCards(groups)).toEqual([
      { groupId: 'g1', faceId: 'a2j', name: 'a2.ARW', pinned: false, shots: 4, runnerUps: 1, rejected: { lighting: 1, blur: 1, eyes: 0 }, assetIds: ['a1', 'a2', 'a2j', 'a3', 'a4'] },
      { groupId: 'g2', faceId: 'b1', name: 'b1.ARW', pinned: false, shots: 2, runnerUps: 1, rejected: { lighting: 0, blur: 0, eyes: 0 }, assetIds: ['b1', 'b2'] },
    ]);
  });

  it('follows a shot made the preferred one in the stack window', () => {
    const now = { ...live('a3', 'f-a3', 'best', 1, true), ...live('a2j', 'f-a2', 'runner-up', 2) };
    const [card] = stackCards(groups, now);
    expect(card).toMatchObject({ faceId: 'a3', name: 'a3.ARW', pinned: true, runnerUps: 1, shots: 4 });
  });

  it('leaves out trashed shots, and a stack left with one shot', () => {
    const cards = stackCards(groups, {}, new Set(['a1', 'a4', 'b2']));
    expect(cards.map((c) => [c.groupId, c.shots, c.rejected.blur])).toEqual([['g1', 2, 0]]);
    // A shot with one of its files left is still there.
    expect(stackCards(groups, {}, new Set(['a2']))[0]?.shots).toBe(4);
  });
});
