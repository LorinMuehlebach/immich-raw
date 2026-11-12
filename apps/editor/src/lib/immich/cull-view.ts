// How the filmstrip shows the culler's stacks. Pure, so it can be tested.
// - A stack's photos sit together where its first photo was taken, best first, then
//   runner-ups, then rejected ones (as the service ranked them).
// - A collapsed stack shows only its best photo (or the photo being edited) plus a "+N" count.
import type { CullInfo, CullMetrics, CullReason, CullRun, ReportFrame, ReportGroup, ReportSingle, RunCounts, RunEdits, RunReport } from './culler.ts';

export interface StripGroup {
  id: string;
  /** Photos of this stack in the filmstrip (all, also when collapsed). */
  size: number;
  /** Position of this cell among the stack's visible cells. */
  index: number;
  first: boolean;
  last: boolean;
  /** Photos hidden because the stack is collapsed (only on the visible cell). */
  hidden: number;
  collapsed: boolean;
}

export interface StripItem<T> {
  asset: T;
  info: CullInfo | null;
  group: StripGroup | null;
}

export function arrangeGroups<T extends { id: string }>(
  items: T[],
  info: Record<string, CullInfo>,
  collapsed: ReadonlySet<string>,
  currentId?: string,
): StripItem<T>[] {
  const members = new Map<string, T[]>();
  for (const a of items) {
    const gid = info[a.id]?.groupId;
    if (!gid) continue;
    members.set(gid, [...(members.get(gid) ?? []), a]);
  }
  const rank = (a: T) => info[a.id]?.rank ?? Number.MAX_SAFE_INTEGER;

  const out: StripItem<T>[] = [];
  const placed = new Set<string>();
  for (const a of items) {
    const gid = info[a.id]?.groupId;
    const group = gid ? members.get(gid)! : null;
    if (!gid || !group || group.length < 2) {
      out.push({ asset: a, info: info[a.id] ?? null, group: null });
      continue;
    }
    if (placed.has(gid)) continue;
    placed.add(gid);
    const sorted = [...group].sort((x, y) => rank(x) - rank(y));
    const isCollapsed = collapsed.has(gid);
    const visible = isCollapsed ? [sorted.find((x) => x.id === currentId) ?? sorted[0]!] : sorted;
    visible.forEach((v, i) =>
      out.push({
        asset: v,
        info: info[v.id] ?? null,
        group: {
          id: gid,
          size: sorted.length,
          index: i,
          first: i === 0,
          last: i === visible.length - 1,
          hidden: isCollapsed ? sorted.length - 1 : 0,
          collapsed: isCollapsed,
        },
      }),
    );
  }
  return out;
}

export interface Badge {
  icon: string;
  label: string;
  tone: 'best' | 'runner-up' | 'rejected';
}

export function badgeFor(info: CullInfo | null): Badge | null {
  if (!info?.role) return null;
  if (info.role === 'best') return { icon: '★', label: info.pinned ? 'Best (your pick)' : 'Best', tone: 'best' };
  if (info.role === 'runner-up') return { icon: '◐', label: 'Runner-up', tone: 'runner-up' };
  switch (info.reason) {
    case 'lighting':
      return { icon: '☀', label: 'Rejected: lighting', tone: 'rejected' };
    case 'blur':
      return { icon: '≋', label: 'Rejected: not sharp', tone: 'rejected' };
    case 'eyes':
      return { icon: '◉', label: 'Rejected: eyes (half) closed', tone: 'rejected' };
    default:
      return { icon: '✕', label: 'Rejected', tone: 'rejected' };
  }
}

/** The measurements that explain the decision, in words. */
export function describeMetrics(info: CullInfo): string[] {
  const m: CullMetrics = info.metrics ?? {};
  const lines: string[] = [];
  if (info.role === 'best') return lines;
  const ev = m.evVsBest ?? 0;
  if (info.reason === 'lighting' || Math.abs(ev) >= 0.3) lines.push(`${ev > 0 ? '+' : ev < 0 ? '−' : '±'}${Math.abs(ev).toFixed(1)} EV vs best`);
  if ((m.clipHiPct ?? 0) >= 1) lines.push(`${Math.round(m.clipHiPct!)} % blown highlights`);
  if ((m.clipLoPct ?? 0) >= 5) lines.push(`${Math.round(m.clipLoPct!)} % crushed shadows`);
  if (m.sharpPct != null && (info.reason === 'blur' || m.sharpPct < 90)) lines.push(`sharpness ${m.sharpPct} % of best`);
  if (info.reason === 'lighting' && m.subjectEv != null && (m.judgedOn === 'faces' || m.judgedOn === 'people')) {
    lines.push(`${m.judgedOn} ${signed(m.subjectEv, 1)} EV vs ideal`);
  }
  if (m.faces) lines.push(eyesText(m));
  if (m.smileFaces) lines.push(smilesText(m.smiling ?? 0, m.smileFaces));
  return lines;
}

/** "2 of 3 faces with eyes closed", or with the openness: "eyes 92 % open", "3 faces, eyes 85 % open (least 40 %)". */
function eyesText(m: CullMetrics): string {
  const faces = m.faces ?? 0;
  const closed = m.closed ? `${m.closed} of ${faces} faces with eyes closed` : '';
  if (m.eyesOpen == null) return closed || `${faces} ${faces === 1 ? 'face' : 'faces'}, eyes open`;
  const open = faces === 1 ? `eyes ${m.eyesOpen} % open` : `${faces} faces, eyes ${m.eyesOpen} % open (least ${m.eyesLeast ?? m.eyesOpen} %)`;
  return closed ? `${open}, ${m.closed} closed` : open;
}

function smilesText(smiling: number, faces: number): string {
  if (faces === 1) return smiling ? 'smiling' : 'not smiling';
  return `${smiling} of ${faces} smiling`;
}

/** "3 % blown" / "8 % crushed", only when there is some. */
function clipText(hi: number | undefined, lo: number | undefined): string {
  const parts = [];
  if ((hi ?? 0) >= 1) parts.push(`${Math.round(hi!)} % blown`);
  if ((lo ?? 0) >= 5) parts.push(`${Math.round(lo!)} % crushed`);
  return parts.length ? ` · ${parts.join(', ')}` : '';
}

export interface MetricRow {
  label: string;
  value: string;
  /** The measurement this photo was rejected for. */
  bad?: boolean;
}

/** "+1.5", "−0.4", and "±0.0" for anything that rounds to zero. */
const signed = (n: number, digits: number) => {
  const r = Number(n.toFixed(digits));
  return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${Math.abs(r).toFixed(digits)}`;
};

/** Everything the culler measured for a photo, for the stack window (also what didn't decide). */
export function metricRows(info: CullInfo): MetricRow[] {
  const m: CullMetrics = info.metrics ?? {};
  const best = info.role === 'best';
  const rows: MetricRow[] = [];
  const badge = badgeFor(info);
  if (badge && best) {
    rows.push({ label: 'Verdict', value: `${badge.icon} Best${info.groupSize ? ` of ${info.groupSize}` : ''}${info.pinned ? ' (your pick)' : ''}` });
  } else if (badge) {
    const place = info.rank && info.groupSize ? ` · ${info.rank} of ${info.groupSize}` : '';
    rows.push({ label: 'Verdict', value: `${badge.icon} ${badge.label}${place}`, bad: badge.tone === 'rejected' });
  }
  if (m.sharpPct != null) rows.push({ label: 'Sharpness', value: best ? 'reference' : `${m.sharpPct} % of best`, bad: info.reason === 'blur' });
  if (m.evVsBest != null) rows.push({ label: 'Exposure', value: best ? 'reference' : `${signed(m.evVsBest, 1)} EV vs best`, bad: info.reason === 'lighting' });
  if (m.subjectEv != null && (m.judgedOn === 'faces' || m.judgedOn === 'people')) {
    rows.push({
      label: m.judgedOn === 'faces' ? "Faces' exposure" : "People's exposure",
      value: `${signed(m.subjectEv, 1)} EV vs ideal${clipText(m.subjectClipHiPct, m.subjectClipLoPct)}`,
      bad: info.reason === 'lighting',
    });
  }
  if (m.lighting != null) rows.push({ label: 'Exposure error', value: `${m.lighting.toFixed(2)} (0 = ideal)`, bad: info.reason === 'lighting' });
  if (m.clipHiPct != null) rows.push({ label: 'Blown highlights', value: `${m.clipHiPct} %` });
  if (m.clipLoPct != null) rows.push({ label: 'Crushed shadows', value: `${m.clipLoPct} %` });
  if (m.faces != null) rows.push({ label: 'Eyes', value: m.faces ? eyesText(m) : 'no faces found', bad: info.reason === 'eyes' });
  if (m.smileFaces) rows.push({ label: 'Smiles', value: smilesText(m.smiling ?? 0, m.smileFaces) });
  if (m.people) rows.push({ label: 'People', value: `${m.people} found` });
  return rows;
}

export function tooltipFor(title: string, info: CullInfo | null): string {
  const badge = badgeFor(info);
  if (!info || !badge) return title;
  const place = info.rank && info.groupSize ? ` (${info.rank} of ${info.groupSize})` : '';
  return [title, `${badge.label}${place}`, ...describeMetrics(info)].join('\n');
}

/** What a run found or did, in one line: "3 stacks from 37 photos · 4 runner-ups · …". */
export function describeRun(c: Partial<RunCounts> | null | undefined): string {
  if (!c) return 'nothing to do';
  const r = c.rejected ?? { lighting: 0, blur: 0, eyes: 0 };
  const rejected = r.lighting + r.blur + r.eyes;
  const parts = [`${c.groups ?? 0} ${c.groups === 1 ? 'stack' : 'stacks'} from ${c.photos ?? 0} photos`];
  if (c.runnerUps) parts.push(`${c.runnerUps} ${c.runnerUps === 1 ? 'runner-up' : 'runner-ups'}`);
  if (rejected) {
    const why = [r.lighting && `${r.lighting} lighting`, r.blur && `${r.blur} not sharp`, r.eyes && `${r.eyes} eyes closed`].filter(Boolean);
    parts.push(`${rejected} set aside (${why.join(', ')})`);
  }
  if (c.pending) parts.push(`${c.pending} still waiting for Immich's preview`);
  if (c.takenApart) parts.push(`${c.takenApart} left alone (taken out of stacks in Immich before)`);
  return parts.join(' · ');
}

/** Where a running run is: "measuring 12/37". */
export function runPhase(r: CullRun | null): string {
  if (!r) return 'starting…';
  if (r.status === 'queued') return 'waiting for another run…';
  return `${r.phase ?? 'working'}${r.total ? ` ${r.done}/${r.total}` : '…'}`;
}

/** A stack on the auto-stack page: its preferred shot, and all its shots in the order taken. */
export interface StackRow {
  kind: 'stack';
  groupId: string;
  best: ReportFrame;
  shots: ReportFrame[];
  runnerUps: number;
  rejected: Record<CullReason, number>;
  /** When its first shot was taken. */
  taken: string;
  frameIds: string[];
  assetIds: string[];
}

/** Shots in no stack, taken one after the other between two stacks. */
export interface SinglesRow {
  kind: 'singles';
  singles: ReportSingle[];
  taken: string;
}

export type ResultRow = StackRow | SinglesRow;

const byTime = <T extends { taken: string | null; name: string }>(a: T, b: T) => (a.taken ?? '').localeCompare(b.taken ?? '') || a.name.localeCompare(b.name);

function stackRow(g: ReportGroup): StackRow {
  const shots = [...g.frames].sort(byTime);
  const best = g.frames.find((f) => f.role === 'best') ?? [...g.frames].sort((a, b) => a.rank - b.rank)[0]!;
  const rejected: Record<CullReason, number> = { lighting: 0, blur: 0, eyes: 0 };
  for (const f of shots) if (f.role === 'rejected' && f.reason) rejected[f.reason]++;
  return {
    kind: 'stack',
    groupId: g.id,
    best,
    shots,
    runnerUps: shots.filter((f) => f.role === 'runner-up').length,
    rejected,
    taken: shots[0]?.taken ?? '',
    frameIds: shots.map((f) => f.frameId),
    assetIds: shots.flatMap((f) => f.assetIds),
  };
}

/** The run's stacks and single shots in the order taken; single shots next to each other share a row. */
export function layoutRows(report: RunReport | null | undefined): ResultRow[] {
  const items: (StackRow | ReportSingle)[] = [...(report?.groups ?? []).map(stackRow), ...(report?.singles ?? [])];
  const key = (x: StackRow | ReportSingle) => ({ taken: x.taken ?? '', name: 'kind' in x ? x.best.name : x.name });
  items.sort((a, b) => byTime(key(a), key(b)));
  const rows: ResultRow[] = [];
  for (const x of items) {
    if ('kind' in x) {
      rows.push(x);
      continue;
    }
    const last = rows.at(-1);
    if (last?.kind === 'singles') last.singles.push(x);
    else rows.push({ kind: 'singles', singles: [x], taken: x.taken ?? '' });
  }
  return rows;
}

/** The stacks right before and right after a single shot, to add it to. */
export function stackChoices(rows: ResultRow[], frameId: string): { before: StackRow | null; after: StackRow | null } {
  const i = rows.findIndex((r) => r.kind === 'singles' && r.singles.some((s) => s.frameId === frameId));
  const at = (j: number) => {
    const r = rows[j];
    return r?.kind === 'stack' ? r : null;
  };
  return i < 0 ? { before: null, after: null } : { before: at(i - 1), after: at(i + 1) };
}

export const NO_EDITS: RunEdits = { remove: [], join: {} };

/** The edits with this shot taken out of its stack (and no longer added to one). */
export function withRemove(e: RunEdits, frameId: string): RunEdits {
  const { [frameId]: _, ...join } = e.join;
  return { remove: e.remove.includes(frameId) ? e.remove : [...e.remove, frameId], join };
}

/** The edits with this shot added to the stack of those shots (and no longer taken out). */
export function withJoin(e: RunEdits, frameId: string, stackFrameIds: string[]): RunEdits {
  return { remove: e.remove.filter((f) => f !== frameId), join: { ...e.join, [frameId]: stackFrameIds.filter((f) => f !== frameId) } };
}

export const sameEdits = (a: RunEdits | null | undefined, b: RunEdits | null | undefined): boolean => {
  const norm = (e: RunEdits | null | undefined) =>
    JSON.stringify({
      remove: [...(e?.remove ?? [])].sort(),
      join: Object.fromEntries(Object.entries(e?.join ?? {}).sort(([x], [y]) => x.localeCompare(y))),
    });
  return norm(a) === norm(b);
};
