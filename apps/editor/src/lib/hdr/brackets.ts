// Finding the exposure bracket a photo belongs to: shots from the same camera and lens, taken in
// quick succession, each at a different exposure. Cameras shoot a bracket as a burst (auto
// exposure bracketing), usually in the order 0, -, + or -, 0, +, and several brackets in a row
// for panoramas or time lapses, so a run of shots is cut wherever an exposure comes round again.
import { AssetOrder, AssetTypeEnum, AssetVisibility, SearchOrderField, searchAssets, type AssetResponseDto, type SearchFilter } from '@immich/sdk';
import { isRawFilename, RAW_EXTENSIONS } from '@immich-raw/inject/raw';

/** Exposure steps closer than this (in stops) count as the same exposure. */
const SAME_EV = 0.3;
/** Longest pause between two shots of one bracket, on top of the earlier shot's exposure time. */
const MAX_GAP_MS = 2500;
/** Cameras bracket up to 9 frames (some allow more, rarely used for HDR). */
export const MAX_FRAMES = 9;
/** A bracket must span at least this many stops to be worth merging. */
const MIN_SPAN = 0.7;
/** How far around the photo to look for its bracket. */
const SEARCH_MS = 3 * 60 * 1000;

export interface Shot {
  id: string;
  fileName: string;
  /** Capture time, ms (sub-seconds when the camera wrote them). */
  time: number;
  camera: string;
  lens: string;
  focalLength: number;
  width: number;
  height: number;
  /** Seconds. */
  exposureTime: number;
  fNumber: number;
  iso: number;
  /** log2 of the light the shot let in (time x ISO / f²): one stop brighter = +1. */
  ev: number;
}

/** "1/250", "0.5", "2", "1/250 s" -> seconds. */
export function parseExposureTime(v: string | number | null | undefined): number | null {
  if (typeof v === 'number') return v > 0 ? v : null;
  if (!v) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?/.exec(v);
  if (!m) return null;
  const t = m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** Capture time with sub-seconds: EXIF date first (Immich keeps its milliseconds), then the others. */
function shotTime(a: Pick<AssetResponseDto, 'localDateTime' | 'fileCreatedAt' | 'exifInfo'>): number {
  const t = Date.parse(a.exifInfo?.dateTimeOriginal ?? '') || Date.parse(a.localDateTime ?? '') || Date.parse(a.fileCreatedAt ?? '');
  return Number.isFinite(t) ? t : NaN;
}

/**
 * A merged HDR (ours, or Lightroom's: both are named `<shot>-HDR.dng`). It carries its middle
 * shot's time and exposure, so it would look like a shot of its own bracket.
 */
export const isMergedHdr = (fileName: string): boolean => /-HDR(-\d+)?\.dng$/i.test(fileName);

/** The facts about a RAW that bracket detection needs; null if they aren't all known. */
export function shotOf(a: AssetResponseDto): Shot | null {
  const x = a.exifInfo;
  if (!x || a.isTrashed || !isRawFilename(a.originalFileName) || isMergedHdr(a.originalFileName)) return null;
  const exposureTime = parseExposureTime(x.exposureTime);
  const time = shotTime(a);
  if (!exposureTime || !Number.isFinite(time)) return null;
  const fNumber = x.fNumber && x.fNumber > 0 ? x.fNumber : 1;
  const iso = x.iso && x.iso > 0 ? x.iso : 100;
  return {
    id: a.id,
    fileName: a.originalFileName,
    time,
    camera: `${x.make ?? ''} ${x.model ?? ''}`.trim().toLowerCase(),
    lens: (x.lensModel ?? '').trim().toLowerCase(),
    focalLength: x.focalLength ?? 0,
    width: x.exifImageWidth ?? 0,
    height: x.exifImageHeight ?? 0,
    exposureTime,
    fNumber,
    iso,
    ev: Math.log2((exposureTime * iso) / (fNumber * fNumber)),
  };
}

/** Same camera, lens, focal length and image size. */
function sameSetup(a: Shot, b: Shot): boolean {
  return (
    a.camera === b.camera &&
    a.lens === b.lens &&
    Math.abs(a.focalLength - b.focalLength) <= 0.5 &&
    Math.max(a.width, a.height) === Math.max(b.width, b.height) &&
    Math.min(a.width, a.height) === Math.min(b.width, b.height)
  );
}

/**
 * The bracket `currentId` belongs to, in shooting order, or [] when it isn't part of one.
 * `shots` may come in any order and include unrelated photos.
 */
export function findBracket(shots: Shot[], currentId: string): Shot[] {
  const list = [...shots].sort((a, b) => a.time - b.time || a.fileName.localeCompare(b.fileName));
  const at = list.findIndex((s) => s.id === currentId);
  if (at < 0) return [];
  const cur = list[at]!;
  // The run of quick shots with the same setup around the photo.
  const linked = (a: Shot, b: Shot) => sameSetup(a, b) && b.time - a.time <= MAX_GAP_MS + a.exposureTime * 1000;
  let start = at;
  while (start > 0 && linked(list[start - 1]!, list[start]!) && sameSetup(list[start - 1]!, cur)) start--;
  let end = at;
  while (end < list.length - 1 && linked(list[end]!, list[end + 1]!) && sameSetup(list[end + 1]!, cur)) end++;
  // Cut it into brackets: a new one starts when an exposure comes round again.
  let set: Shot[] = [];
  for (let i = start; i <= end; i++) {
    const s = list[i]!;
    const repeats = set.some((o) => Math.abs(o.ev - s.ev) < SAME_EV);
    if (repeats || set.length >= MAX_FRAMES) {
      if (set.some((o) => o.id === currentId)) break;
      set = [];
    }
    set.push(s);
  }
  if (!set.some((o) => o.id === currentId) || set.length < 2) return [];
  const evs = set.map((s) => s.ev);
  return Math.max(...evs) - Math.min(...evs) >= MIN_SPAN ? set : [];
}

/** Exposure of a shot relative to another, in stops, for display ("-2 EV"). */
export const relativeEv = (s: Shot, ref: Shot): number => s.ev - ref.ev;

/** The middle exposure of a bracket (its "normal" shot), which the merged photo takes its look and details from. */
export function referenceShot(bracket: Shot[]): Shot {
  const sorted = [...bracket].sort((a, b) => a.ev - b.ev);
  return sorted[(sorted.length - 1) >> 1]!;
}

/** RAWs shot within a few minutes of the photo (the search), with their EXIF. */
export function bracketFilter(current: Pick<AssetResponseDto, 'localDateTime' | 'fileCreatedAt' | 'exifInfo'>): SearchFilter | null {
  // takenAt compares with fileCreatedAt, the capture instant in UTC (as the filmstrip uses it).
  const t = Date.parse(current.fileCreatedAt ?? '') || shotTime(current);
  if (!Number.isFinite(t)) return null;
  const pad = SEARCH_MS + 60_000;
  return {
    trashedAt: { eq: null },
    visibility: { notIn: [AssetVisibility.Locked] },
    type: { eq: AssetTypeEnum.Image },
    or: RAW_EXTENSIONS.map((ext) => ({ originalFileName: { endsWith: ext } })),
    takenAt: { gte: new Date(t - pad).toISOString(), lte: new Date(t + pad).toISOString() },
  };
}

/** Looks up the photo's bracket in Immich: the assets, in shooting order ([] if none). */
export async function loadBracket(current: AssetResponseDto): Promise<AssetResponseDto[]> {
  const filter = bracketFilter(current);
  const me = shotOf(current);
  if (!filter || !me) return [];
  const res = await searchAssets({
    metadataSearchDto: { filter, size: 1000, withExif: true, orderBy: { field: SearchOrderField.LocalDateTime, direction: AssetOrder.Asc } },
  });
  const byId = new Map<string, AssetResponseDto>(res.assets.items.map((a) => [a.id, a]));
  byId.set(current.id, current);
  const shots = [...byId.values()].map(shotOf).filter((s): s is Shot => !!s && Math.abs(s.time - me.time) <= SEARCH_MS);
  return findBracket(shots, current.id).map((s) => byId.get(s.id)!);
}
