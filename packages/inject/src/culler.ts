// Whether the culler (services/culler) works for the logged-in Immich user, for the auto-stack
// button: its /me only answers the owner of the library it runs on. Not installed (the proxy's
// HTML 404), someone else's library (403) or another origin (the userscript): no button.

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** `cullerApi`: the culler's API root, e.g. /immich-raw/culler/api/v1. */
export async function cullerAvailable(cullerApi: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${cullerApi}/me`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    return res.ok && (res.headers.get('content-type') ?? '').includes('application/json');
  } catch {
    return false;
  }
}

/** cullerAvailable, asked again after `ttlMs` (Immich can switch users without a page load). */
export function createCullerCheck(cullerApi: string, fetchImpl: FetchLike = fetch, ttlMs = 5 * 60_000, now = () => Date.now()) {
  let cached: { at: number; result: Promise<boolean> } | null = null;
  return (): Promise<boolean> => {
    if (!cached || now() - cached.at > ttlMs) cached = { at: now(), result: cullerAvailable(cullerApi, fetchImpl) };
    return cached.result;
  };
}
