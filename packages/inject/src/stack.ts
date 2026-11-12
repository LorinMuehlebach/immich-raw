// Decides whether the asset viewer shows the "Compare stack" button: only for photos in a stack
// the culler made, with at least two shots. The culler is optional; without it (or on another
// origin, or for someone else's photos) its lookup fails and the button stays away.

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface AssetLike {
  id: string;
  stack?: { id: string; assetCount?: number } | null;
}

interface LookupItem {
  groupId?: string | null;
  groupSize?: number | null;
}

/** `cullerApi`: the culler's API root, e.g. /immich-raw/culler/api/v1. */
export async function findCullerStack(assetId: string, cullerApi: string, fetchImpl: FetchLike = fetch, api = '/api'): Promise<boolean> {
  try {
    const res = await fetchImpl(`${api}/assets/${assetId}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!res.ok) return false;
    const asset = (await res.json()) as AssetLike;
    if (!asset.stack || (asset.stack.assetCount ?? 0) < 2) return false;

    const lookup = await fetchImpl(`${cullerApi}/assets/lookup`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [assetId] }),
    });
    if (!lookup.ok || !(lookup.headers.get('content-type') ?? '').includes('application/json')) return false;
    const item = ((await lookup.json()) as { items?: Record<string, LookupItem> }).items?.[assetId];
    return !!item?.groupId && (item.groupSize ?? 0) >= 2;
  } catch {
    return false;
  }
}

/** findCullerStack with a per-asset cache (one lookup per asset per page load). */
export function createCullerStackResolver(cullerApi: string, fetchImpl: FetchLike = fetch, api = '/api') {
  const cache = new Map<string, Promise<boolean>>();
  return (assetId: string): Promise<boolean> => {
    let hit = cache.get(assetId);
    if (!hit) {
      hit = findCullerStack(assetId, cullerApi, fetchImpl, api);
      cache.set(assetId, hit);
    }
    return hit;
  };
}
