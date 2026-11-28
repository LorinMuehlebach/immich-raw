// Decides which RAW the "Edit RAW" button opens for the asset being viewed.

// Immich v3.3.6/v3.4.0 server/src/utils/mime-types.ts `raw`, minus .psd, .ari and .cin.
export const RAW_EXTENSIONS = [
  '.3fr', '.arw', '.cap', '.cr2', '.cr3', '.crw', '.dcr', '.dng', '.erf', '.fff', '.iiq', '.k25', '.kdc', '.mrw',
  '.nef', '.nrw', '.orf', '.ori', '.pef', '.raf', '.raw', '.rw2', '.rwl', '.sr2', '.srf', '.srw', '.x3f',
] as const;

const RAW_SET = new Set<string>(RAW_EXTENSIONS);

export function isRawFilename(name: string | null | undefined): boolean {
  if (!name) return false;
  const dot = name.lastIndexOf('.');
  return dot >= 0 && RAW_SET.has(name.slice(dot).toLowerCase());
}

export const RENDER_KEY = 'raw-editor.render';

/**
 * 'DSC01234.ARW', 'DSC01234.JPG' and the editor's 'DSC01234.edit.jpg' -> 'dsc01234' (a virtual
 * copy's 'DSC01234.copy-2.edit.jpg' too).
 */
export function captureBaseName(name: string | null | undefined): string {
  let lower = (name ?? '').toLowerCase();
  if (lower.endsWith('.edit.jpg')) lower = lower.slice(0, -'.edit.jpg'.length);
  const dot = lower.lastIndexOf('.');
  return dot > 0 ? lower.slice(0, dot) : lower;
}

const SAME_CAPTURE_MS = 2000;

interface AssetLike {
  id: string;
  originalFileName?: string;
  fileCreatedAt?: string;
  isTrashed?: boolean;
  stack?: { id: string; primaryAssetId?: string; assetCount?: number } | null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function getJson<T>(fetchImpl: FetchLike, url: string): Promise<T | null> {
  try {
    const res = await fetchImpl(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** What the Edit RAW button opens: the RAW, and the virtual copy a render was made from (null: the original edit). */
export interface EditTarget {
  rawId: string;
  copyId: string | null;
}

/**
 * Returns what to edit, or null when the button should not show:
 * - a RAW opens itself;
 * - a render made by the editor opens the RAW it came from, and the virtual copy if it is one's;
 * - a camera JPEG stacked with a RAW opens that RAW (in a burst stack: the RAW of its capture).
 */
export async function findEditTarget(assetId: string, fetchImpl: FetchLike = fetch, api = '/api'): Promise<EditTarget | null> {
  const asset = await getJson<AssetLike>(fetchImpl, `${api}/assets/${assetId}`);
  if (!asset) return null;
  if (isRawFilename(asset.originalFileName)) return { rawId: asset.id, copyId: null };

  const render = await getJson<{ value?: { sourceAssetId?: unknown; copyId?: unknown } }>(
    fetchImpl,
    `${api}/assets/${assetId}/metadata/${encodeURIComponent(RENDER_KEY)}`,
  );
  const source = render?.value?.sourceAssetId;
  const copyId = render?.value?.copyId;
  if (typeof source === 'string' && source) return { rawId: source, copyId: typeof copyId === 'string' && copyId ? copyId : null };

  if (asset.stack?.id) {
    const stack = await getJson<{ assets?: AssetLike[] }>(fetchImpl, `${api}/stacks/${asset.stack.id}`);
    const rawId = rawOfCapture(asset, stack?.assets ?? []);
    return rawId ? { rawId, copyId: null } : null;
  }
  return null;
}

/**
 * The RAW in a stack that belongs to `asset`'s capture. A stack can hold several captures (the
 * culler stacks a whole burst): prefer the same file name, then the same moment; else none.
 */
export function rawOfCapture(asset: AssetLike, members: AssetLike[]): string | null {
  const raws = members.filter((a) => !a.isTrashed && isRawFilename(a.originalFileName));
  if (raws.length <= 1) return raws[0]?.id ?? null;
  const base = captureBaseName(asset.originalFileName);
  const named = raws.filter((r) => captureBaseName(r.originalFileName) === base);
  if (named.length === 1) return named[0]!.id;
  const t = Date.parse(asset.fileCreatedAt ?? '');
  const near = Number.isFinite(t) ? raws.filter((r) => Math.abs(Date.parse(r.fileCreatedAt ?? '') - t) <= SAME_CAPTURE_MS) : [];
  return near.length === 1 ? near[0]!.id : null;
}

/** findEditTarget with a per-asset cache (one lookup per asset per page load). */
export function createEditTargetResolver(fetchImpl: FetchLike = fetch, api = '/api') {
  const cache = new Map<string, Promise<EditTarget | null>>();
  return (assetId: string): Promise<EditTarget | null> => {
    let hit = cache.get(assetId);
    if (!hit) {
      hit = findEditTarget(assetId, fetchImpl, api);
      cache.set(assetId, hit);
    }
    return hit;
  };
}
