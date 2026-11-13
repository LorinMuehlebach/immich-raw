// What the filmstrip shows of each photo besides the culler's verdict, which photos its filters
// let through, and where ← → ↑ ↓ go from the open photo. Pure, so it can be tested.
import type { StripItem } from './cull-view.ts';

/** What the filmstrip knows of a photo (unknown things are null until looked up). */
export interface PhotoFacts {
  /** Immich's stars, 1-5, or null. */
  rating: number | null;
  favorite: boolean;
  /** Has a reject tag (`<root>/Rejected`, or the culler's `<root>/Rejected/...`). */
  rejected: boolean;
  /** Has a saved edit; null while not known yet. */
  edited: boolean | null;
  /** Has a draft in this browser. */
  draft: boolean;
}

export const NO_FACTS: PhotoFacts = { rating: null, favorite: false, rejected: false, edited: null, draft: false };

export type EditFilter = 'any' | 'edited' | 'unedited' | 'draft';

export interface StripFilter {
  /** At least this many stars (0: any). */
  minRating: number;
  favorites: boolean;
  hideRejected: boolean;
  edits: EditFilter;
}

export const NO_FILTER: StripFilter = { minRating: 0, favorites: false, hideRejected: false, edits: 'any' };

export const filterActive = (f: StripFilter): boolean => f.minRating > 0 || f.favorites || f.hideRejected || f.edits !== 'any';

/** The filter as kept in the browser, with anything missing or odd set to "no filter". */
export function normalizeFilter(v: unknown): StripFilter {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const min = typeof o.minRating === 'number' && Number.isInteger(o.minRating) ? Math.min(5, Math.max(0, o.minRating)) : 0;
  const edits = o.edits === 'edited' || o.edits === 'unedited' || o.edits === 'draft' ? o.edits : 'any';
  return { minRating: min, favorites: o.favorites === true, hideRejected: o.hideRejected === true, edits };
}

/** Whether the photo passes the filter. A photo whose edits aren't known yet passes 'edited' and 'unedited'. */
export function passes(f: StripFilter, p: PhotoFacts): boolean {
  if (f.minRating > 0 && (p.rating ?? 0) < f.minRating) return false;
  if (f.favorites && !p.favorite) return false;
  if (f.hideRejected && p.rejected) return false;
  if (f.edits === 'draft') return p.draft;
  if (f.edits === 'edited') return p.edited !== false || p.draft;
  if (f.edits === 'unedited') return p.edited !== true && !p.draft;
  return true;
}

/** The cells the filter lets through; the open photo always stays. A stack keeps its line when some of it stays. */
export function filterStrip<T extends { id: string }>(strip: StripItem<T>[], f: StripFilter, facts: (id: string) => PhotoFacts, currentId: string): StripItem<T>[] {
  if (!filterActive(f)) return strip;
  const kept = strip.filter((s) => s.asset.id === currentId || passes(f, facts(s.asset.id)));
  // A stack's first and last visible cells change when some of its cells are left out.
  return kept.map((s, i) => {
    if (!s.group) return s;
    const gid = s.group.id;
    const first = kept[i - 1]?.group?.id !== gid;
    const last = kept[i + 1]?.group?.id !== gid;
    return first === s.group.first && last === s.group.last ? s : { ...s, group: { ...s.group, first, last } };
  });
}

export interface Neighbours {
  /** ← and →. */
  prev: string | null;
  next: string | null;
  /** ↑ and ↓: the previous and next stack or single photo, past the rest of this stack. */
  prevStack: string | null;
  nextStack: string | null;
  /** The photos to get ready, nearest first: next, previous, then two either way. */
  nearby: string[];
}

export function stripNeighbours<T extends { id: string }>(strip: StripItem<T>[], index: number): Neighbours {
  const at = (k: number) => (index >= 0 && k >= 0 && k < strip.length ? strip[k]!.asset.id : null);
  const nearby = [at(index + 1), at(index - 1), at(index + 2), at(index - 2)].filter((id): id is string => !!id);
  return { prev: at(index - 1), next: at(index + 1), prevStack: jumpTarget(strip, index, -1), nextStack: jumpTarget(strip, index, 1), nearby };
}

/**
 * The first cell of the next (dir 1) or previous (dir -1) stack or single photo. Going back lands
 * on the first cell of that stack, as going forward does.
 */
export function jumpTarget<T extends { id: string }>(strip: StripItem<T>[], index: number, dir: 1 | -1): string | null {
  if (index < 0 || index >= strip.length) return null;
  const gid = strip[index]!.group?.id;
  let k = index + dir;
  // Past the rest of this stack.
  while (gid && k >= 0 && k < strip.length && strip[k]!.group?.id === gid) k += dir;
  if (k < 0 || k >= strip.length) return null;
  const target = strip[k]!.group?.id;
  // Backwards into a stack: to its first cell.
  if (dir === -1 && target) while (k > 0 && strip[k - 1]!.group?.id === target) k--;
  return strip[k]!.asset.id;
}

export interface FactBadge {
  icon: string;
  label: string;
  tone: 'rating' | 'favorite' | 'rejected' | 'edited' | 'draft';
}

/** The small marks along the bottom of a thumbnail. */
export function factBadges(p: PhotoFacts): FactBadge[] {
  const out: FactBadge[] = [];
  if (p.rejected) out.push({ icon: '✕', label: 'Rejected', tone: 'rejected' });
  if (p.favorite) out.push({ icon: '♥', label: 'Favourite', tone: 'favorite' });
  if (p.rating && p.rating > 0) out.push({ icon: `${p.rating}★`, label: `${p.rating} ${p.rating === 1 ? 'star' : 'stars'}`, tone: 'rating' });
  if (p.draft) out.push({ icon: '●', label: 'Unsaved changes, kept in this browser', tone: 'draft' });
  else if (p.edited) out.push({ icon: '✎', label: 'Edited', tone: 'edited' });
  return out;
}

/** "★★★", "♥", "rejected" for the title line. */
export function factsText(p: PhotoFacts): string {
  const parts: string[] = [];
  if (p.rejected) parts.push('rejected');
  if (p.favorite) parts.push('♥');
  if (p.rating && p.rating > 0) parts.push('★'.repeat(p.rating));
  return parts.join(' ');
}
