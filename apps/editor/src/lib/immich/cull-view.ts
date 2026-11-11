// How the filmstrip shows the culler's stacks. Pure, so it can be tested.
// - A stack's photos sit together where its first photo was taken, best first, then
//   runner-ups, then rejected ones (as the service ranked them).
// - A collapsed stack shows only its best photo (or the photo being edited) plus a "+N" count.
import type { CullInfo, CullMetrics } from './culler.ts';

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
      return { icon: '◉', label: 'Rejected: eyes closed', tone: 'rejected' };
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
  if (m.faces) lines.push(m.closed ? `${m.closed} of ${m.faces} faces with eyes closed` : `${m.faces} ${m.faces === 1 ? 'face' : 'faces'}, eyes open`);
  return lines;
}

export function tooltipFor(title: string, info: CullInfo | null): string {
  const badge = badgeFor(info);
  if (!info || !badge) return title;
  const place = info.rank && info.groupSize ? ` (${info.rank} of ${info.groupSize})` : '';
  return [title, `${badge.label}${place}`, ...describeMetrics(info)].join('\n');
}
