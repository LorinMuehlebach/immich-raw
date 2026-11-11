// How the Immich button hands a selection to the editor's export page: the asset ids go into
// localStorage (Immich and the editor share the origin) under a one-off key, and the page is
// opened with ?export=<key>. A URL would be too long for thousands of ids.

export const HANDOFF_PREFIX = 'immich-raw.export.';
/** Handoffs older than this are removed (the page reads its own right away). */
export const HANDOFF_MAX_AGE_MS = 24 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExportHandoff {
  ids: string[];
  /** Where the selection was made: album:<id>, person:<id> or timeline. */
  context: string;
  /** How many photos Immich said were selected (ids can be fewer when some couldn't be read). */
  expected: number;
  /** Immich page to go back to. */
  returnPath: string;
  createdAt: number;
}

export function exportPageUrl(base: string, key: string): string {
  return `${base}${base.includes('?') ? '&' : '?'}export=${encodeURIComponent(key)}`;
}

export function newHandoffKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Checks a stored handoff; null when it isn't one. Ids are lower-cased and de-duplicated. */
export function parseHandoff(value: unknown): ExportHandoff | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (!Array.isArray(o.ids)) return null;
  const ids = [...new Set(o.ids.filter((id): id is string => typeof id === 'string' && UUID.test(id)).map((id) => id.toLowerCase()))];
  const returnPath = typeof o.returnPath === 'string' && o.returnPath.startsWith('/') && !o.returnPath.startsWith('//') ? o.returnPath : '/';
  return {
    ids,
    context: typeof o.context === 'string' ? o.context : 'timeline',
    expected: typeof o.expected === 'number' && Number.isFinite(o.expected) ? Math.max(0, Math.round(o.expected)) : ids.length,
    returnPath,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
  };
}

/** Keys of handoffs to remove: older than the max age, or unreadable. */
export function staleHandoffKeys(entries: [key: string, value: string | null][], now: number): string[] {
  return entries
    .filter(([key]) => key.startsWith(HANDOFF_PREFIX))
    .filter(([, value]) => {
      try {
        const h = parseHandoff(JSON.parse(value ?? ''));
        return !h || now - h.createdAt > HANDOFF_MAX_AGE_MS;
      } catch {
        return true;
      }
    })
    .map(([key]) => key);
}
