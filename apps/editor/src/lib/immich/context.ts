// Filmstrip: the RAWs around the one being edited, from the place it was opened from.
// The inject script passes ctx as album:<id>, person:<id> or timeline.
import { AssetOrder, AssetTypeEnum, AssetVisibility, SearchOrderField, searchAssets, type AssetResponseDto, type SearchFilter } from '@immich/sdk';
import { isRawFilename, RAW_EXTENSIONS } from '@immich-raw/inject/raw';

export const FILMSTRIP_LIMIT = 300;
const PAGE_SIZE = 1000; // Immich's maximum
const MAX_PAGES = 5;
const SAME_DAY_MS = 12 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FilmstripContext = { kind: 'album'; id: string } | { kind: 'person'; id: string } | { kind: 'timeline' };

export function parseContext(ctx: string | null | undefined): FilmstripContext {
  const m = /^(album|person):(.+)$/.exec(ctx ?? '');
  if (m && UUID.test(m[2]!)) return { kind: m[1] as 'album' | 'person', id: m[2]!.toLowerCase() };
  return { kind: 'timeline' };
}

/** Capture time used for ordering: EXIF date, else Immich's local date, else file date. */
export function captureTime(a: Pick<AssetResponseDto, 'localDateTime' | 'fileCreatedAt' | 'exifInfo'>): number {
  const t = Date.parse(a.localDateTime ?? '') || Date.parse(a.exifInfo?.dateTimeOriginal ?? '') || Date.parse(a.fileCreatedAt ?? '');
  return Number.isFinite(t) ? t : 0;
}

/**
 * Structured search filter (flat fields are deprecated since Immich 3.2). Unlike the flat
 * search, `filter` also returns trashed assets, so trash is excluded explicitly.
 * `originalFileName.endsWith` is case-insensitive.
 */
export function filmstripFilter(ctx: FilmstripContext, current: Pick<AssetResponseDto, 'fileCreatedAt'>): SearchFilter {
  const filter: SearchFilter = {
    trashedAt: { eq: null },
    visibility: { notIn: [AssetVisibility.Locked, AssetVisibility.Hidden] },
    type: { eq: AssetTypeEnum.Image },
    or: RAW_EXTENSIONS.map((ext) => ({ originalFileName: { endsWith: ext } })),
  };
  if (ctx.kind === 'album') filter.albumIds = { any: [ctx.id] };
  else if (ctx.kind === 'person') filter.personIds = { any: [ctx.id] };
  else {
    const t = Date.parse(current.fileCreatedAt);
    if (Number.isFinite(t)) {
      filter.takenAt = { gte: new Date(t - SAME_DAY_MS).toISOString(), lte: new Date(t + SAME_DAY_MS).toISOString() };
    }
  }
  return filter;
}

/** Keeps RAWs, drops trash and duplicates, sorts by capture time, keeps `current` and a window around it. */
export function arrangeFilmstrip(items: AssetResponseDto[], current: AssetResponseDto, limit = FILMSTRIP_LIMIT): AssetResponseDto[] {
  const seen = new Set<string>();
  const list = items.filter((a) => {
    if (seen.has(a.id) || a.isTrashed || !isRawFilename(a.originalFileName)) return false;
    seen.add(a.id);
    return true;
  });
  if (!seen.has(current.id)) list.push(current);
  list.sort((a, b) => captureTime(a) - captureTime(b) || a.originalFileName.localeCompare(b.originalFileName));
  if (list.length <= limit) return list;
  const i = list.findIndex((a) => a.id === current.id);
  const start = Math.max(0, Math.min(list.length - limit, i - Math.floor(limit / 2)));
  return list.slice(start, start + limit);
}

export async function loadFilmstrip(ctx: string | null, current: AssetResponseDto): Promise<AssetResponseDto[]> {
  const filter = filmstripFilter(parseContext(ctx), current);
  const items: AssetResponseDto[] = [];
  try {
    // With `filter`/`orderBy`, Immich 3.3.6 rejects the old `page` field: page with `cursor`.
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const res = await searchAssets({
        metadataSearchDto: {
          filter,
          size: PAGE_SIZE,
          orderBy: { field: SearchOrderField.LocalDateTime, direction: AssetOrder.Asc },
          ...(cursor ? { cursor } : {}),
        },
      });
      items.push(...res.assets.items);
      cursor = res.assets.nextCursor ?? undefined;
      if (!cursor || items.length >= FILMSTRIP_LIMIT * 3) break;
    }
  } catch (e) {
    console.warn('Filmstrip: search failed', e);
    return [current];
  }
  return arrangeFilmstrip(items, current);
}
