// Batch export: every photo of an Immich album, or the photos selected in Immich, with one
// export preset. RAWs get their saved edit (or the default settings). The editor's saved JPEGs
// stand in for their RAW, which is rendered again at full quality; only when that RAW is gone
// is the JPEG itself exported. Other images are exported as they are, at the preset's size and
// type.
import { RENDER_KEY } from '@immich-raw/inject/raw';
import { RECIPE_KEY } from '@immich-raw/recipe';
import {
  AssetOrder,
  AssetVisibility,
  SearchOrderField,
  getAllAlbums,
  getAssetInfo,
  searchAssets,
  type AlbumResponseDto,
  type AssetResponseDto,
} from '@immich/sdk';
import { downloadUncached } from '../immich/download.ts';
import { loadRecipe, readMetadata } from '../immich/save.ts';
import { exportFilename, type ExportPreset, type ExportPresetId } from '../state/export-settings.ts';
import { mapLimit, planItems, type AlbumItem, type PlanAsset } from './album-plan.ts';
import { captureDate } from './metadata.ts';
import { finishExport, type OutputStep } from './output.ts';
import type { Destination } from './destination.ts';
import { RawRenderer, type RawStep } from './raw-render.ts';

const PAGE_SIZE = 1000;
/** Metadata look-ups in flight at once while planning. */
const LOOKUPS = 8;
/** Ids per search when looking up a selection. */
const IDS_PER_SEARCH = 100;

export interface AlbumPlan {
  /** The album's name ({album} in file names), or '' for a selection outside an album. */
  source: { name: string };
  items: AlbumItem[];
  /** RAWs with a saved edit (the rest get the default settings). */
  edited: number;
  /** The editor's saved JPEGs rendered again from their RAW. */
  renders: number;
  skipped: { videos: number; jpegTwins: number };
}

/** Albums the user can open: their own and shared ones, by name. */
export async function listAlbums(): Promise<AlbumResponseDto[]> {
  const albums = await getAllAlbums({});
  return albums.sort((a, b) => a.albumName.localeCompare(b.albumName));
}

async function albumAssets(albumId: string): Promise<AssetResponseDto[]> {
  const items: AssetResponseDto[] = [];
  let cursor: string | undefined;
  for (;;) {
    const res = await searchAssets({
      metadataSearchDto: {
        filter: { albumIds: { any: [albumId] }, trashedAt: { eq: null }, visibility: { notIn: [AssetVisibility.Locked, AssetVisibility.Hidden] } },
        size: PAGE_SIZE,
        orderBy: { field: SearchOrderField.LocalDateTime, direction: AssetOrder.Asc },
        ...(cursor ? { cursor } : {}),
      },
    });
    items.push(...res.assets.items);
    cursor = res.assets.nextCursor ?? undefined;
    if (!cursor) return items;
  }
}

/** The assets with these ids (trash left out), in capture order. */
async function assetsById(ids: string[]): Promise<AssetResponseDto[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += IDS_PER_SEARCH) chunks.push(ids.slice(i, i + IDS_PER_SEARCH));
  const found = await mapLimit(chunks, 2, async (chunk) => {
    try {
      const res = await searchAssets({
        metadataSearchDto: { filter: { trashedAt: { eq: null }, or: chunk.map((id) => ({ id: { eq: id } })) }, size: PAGE_SIZE },
      });
      return res.assets.items;
    } catch {
      // Older servers without id search: one at a time.
      const list = await mapLimit(chunk, LOOKUPS, (id) => getAssetInfo({ id }).catch(() => null));
      return list.filter((a): a is AssetResponseDto => !!a && !a.isTrashed);
    }
  });
  const wanted = new Set(ids);
  const seen = new Set<string>();
  return found
    .flat()
    .filter((a) => wanted.has(a.id) && !seen.has(a.id) && seen.add(a.id))
    .sort((a, b) => (a.localDateTime ?? '').localeCompare(b.localDateTime ?? '') || a.originalFileName.localeCompare(b.originalFileName));
}

export async function planAlbumExport(album: { id: string; albumName: string }, skipJpegTwins: boolean): Promise<AlbumPlan> {
  return planFromAssets(await albumAssets(album.id), album.albumName, skipJpegTwins);
}

/** Photos selected in Immich; `name` is the album they were selected in, if any. */
export async function planSelectionExport(ids: string[], name: string, skipJpegTwins: boolean): Promise<AlbumPlan & { missing: number }> {
  const assets = await assetsById(ids);
  return { ...(await planFromAssets(assets, name, skipJpegTwins)), missing: ids.length - assets.length };
}

/** Whether the RAW a saved JPEG was made from can still be rendered (not deleted or in the trash). */
async function rawAvailable(id: string, listed: Set<string>): Promise<boolean> {
  if (listed.has(id)) return true;
  const raw = await getAssetInfo({ id }).catch(() => null);
  return !!raw && !raw.isTrashed;
}

async function planFromAssets(assets: AssetResponseDto[], name: string, skipJpegTwins: boolean): Promise<AlbumPlan> {
  const listed = new Set(assets.map((a) => a.id));
  const planned: PlanAsset[] = await mapLimit(assets, LOOKUPS, async (a) => {
    const p: PlanAsset = { id: a.id, originalFileName: a.originalFileName, type: a.type, fileCreatedAt: a.fileCreatedAt };
    if (a.originalFileName.toLowerCase().endsWith('.edit.jpg')) {
      const source = (await readMetadata(a.id, RENDER_KEY).catch(() => null))?.sourceAssetId;
      p.sourceId = typeof source === 'string' && source && (await rawAvailable(source, listed)) ? source : null;
    }
    return p;
  });
  const { items, renders, skipped } = planItems(planned, skipJpegTwins);
  const hasEdit = await mapLimit(items, LOOKUPS, async (it) => it.kind === 'raw' && !!(await readMetadata(it.id, RECIPE_KEY).catch(() => null)));
  return { source: { name }, items, edited: hasEdit.filter(Boolean).length, renders, skipped };
}

export type PhotoStep = RawStep | OutputStep | 'write';

/** One photo being exported. */
export interface PhotoProgress {
  index: number;
  name: string;
  step: PhotoStep;
  fraction: number;
}

export interface AlbumProgress {
  /** Photos finished (written, copied or failed). */
  done: number;
  total: number;
  /** The photos in progress, in plan order. */
  active: PhotoProgress[];
}

export interface AlbumResult {
  written: string[];
  /** Images the browser can't read (e.g. HEIC), copied unchanged. */
  copied: string[];
  failed: { name: string; error: string }[];
  cancelled: boolean;
}

export interface AlbumRunOptions {
  preset: ExportPreset;
  presetId: ExportPresetId;
  copyright: string;
  /** Owner name for assets that don't carry one. */
  fallbackOwner: string;
  destination: Destination;
  /** Photos worked on at once (download and decode overlap; the GPU renders one at a time). */
  parallel: number;
  /** Stops starting new photos; the ones in progress are finished. */
  signal: AbortSignal;
  onProgress: (p: AlbumProgress) => void;
}

async function decodeImage(blob: Blob): Promise<ImageData | null> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Exports every item of the plan into the destination, `parallel` photos at a time. Files are
 * written as each photo finishes, so a ZIP lists them in that order; names with {seq} follow
 * the plan. Errors skip the photo.
 */
export async function runAlbumExport(plan: AlbumPlan, o: AlbumRunOptions): Promise<AlbumResult> {
  const result: AlbumResult = { written: [], copied: [], failed: [], cancelled: false };
  const raws = new RawRenderer();
  const total = plan.items.length;
  const seqDigits = String(total).length;
  const active = new Map<number, PhotoProgress>();
  let done = 0;
  let next = 0;
  const emit = () => o.onProgress({ done, total, active: [...active.values()].sort((a, b) => a.index - b.index) });

  const exportItem = async (i: number) => {
    const item = plan.items[i]!;
    const report = (step: PhotoStep, fraction = 0) => {
      active.set(i, { index: i, name: item.name, step, fraction });
      emit();
    };
    const asset = await getAssetInfo({ id: item.id });
    const owner = asset.owner?.name ?? o.fallbackOwner;
    const names = { originalFileName: asset.originalFileName, preset: o.presetId, date: captureDate(asset), seq: i + 1, seqDigits, album: plan.source.name, owner };
    let image: ImageData | null;
    if (item.kind === 'raw') {
      image = await raws.render(asset, await loadRecipe(asset.id), (s, f) => report(s, f));
    } else {
      report('download');
      const bytes = await downloadUncached(asset.id, (f) => report('download', f));
      image = await decodeImage(new Blob([bytes as BlobPart]));
      if (!image) {
        report('write');
        result.copied.push(await o.destination.write(asset.originalFileName, bytes));
        return;
      }
    }
    const file = await finishExport(image, asset, o.preset, { copyright: o.copyright, owner, onStep: (s) => report(s) });
    image = null;
    report('write');
    result.written.push(await o.destination.write(exportFilename(o.preset, names), file.bytes));
  };

  const worker = async () => {
    while (next < total) {
      if (o.signal.aborted) {
        result.cancelled = true;
        return;
      }
      const i = next++;
      active.set(i, { index: i, name: plan.items[i]!.name, step: 'download', fraction: 0 });
      emit();
      try {
        await exportItem(i);
      } catch (e) {
        console.error(e);
        result.failed.push({ name: plan.items[i]!.name, error: e instanceof Error ? e.message : String(e) });
      }
      active.delete(i);
      done++;
      emit();
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(o.parallel, total)) }, worker));
  } finally {
    raws.dispose();
  }
  return result;
}
