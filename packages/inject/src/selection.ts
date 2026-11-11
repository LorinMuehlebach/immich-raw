// Immich's multi-select mode: which photos are selected.
//
// Immich only keeps the thumbnails on screen in the page, so after "select all" or a long
// range most selected photos have no element to read. Immich's own download (Shift+D) knows
// them all: it posts their ids to /api/download/info. To get the full list, the export button
// presses Shift+D with that one request caught here and answered with "nothing to download".
import { SELECTED_THUMB_SELECTOR, SELECTION_BAR_SELECTOR } from './selectors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOWNLOAD_INFO = /\/api\/download\/info(?:\?|$)/;
const DOWNLOAD_ARCHIVE = /\/api\/download\/archive(?:\?|$)/;
const ORIGINAL = /\/api\/assets\/([0-9a-f-]{36})\/original(?:\?|$)/i;

/** The selection toolbar, when photos are selected (it shows their number). */
export function selectionBar(): HTMLElement | null {
  const bar = document.querySelector<HTMLElement>(SELECTION_BAR_SELECTOR);
  return bar && selectedCount(bar) !== null ? bar : null;
}

/** "12" from the toolbar's count (the short form Immich shows on small screens, in any language). */
export function selectedCount(bar: Element): number | null {
  for (const p of bar.querySelectorAll('.text-primary p')) {
    const text = p.textContent?.trim() ?? '';
    if (/^\d+$/.test(text)) return Number(text);
  }
  return null;
}

/** Ids of the selected photos that are on screen. */
export function visibleSelectedIds(): string[] {
  const ids = new Set<string>();
  for (const el of document.querySelectorAll<HTMLElement>(SELECTED_THUMB_SELECTOR)) {
    const id = el.dataset.asset;
    if (id && UUID.test(id)) ids.add(id.toLowerCase());
  }
  return [...ids];
}

/** Ids from the body of Immich's download request; null when it isn't one. */
export function idsFromDownloadBody(body: unknown): string[] | null {
  try {
    const parsed = typeof body === 'string' ? (JSON.parse(body) as { assetIds?: unknown }) : null;
    const ids = parsed?.assetIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && UUID.test(id)).map((id) => id.toLowerCase()) : null;
  } catch {
    return null;
  }
}

let armed: ((ids: string[]) => void) | null = null;

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** Wraps fetch once. Outside a capture every request goes through untouched. */
export function installDownloadCatcher(): void {
  const original = window.fetch;
  window.fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (armed) {
      const url = requestUrl(input);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method === 'POST' && DOWNLOAD_INFO.test(url)) {
        let body: unknown = init?.body;
        if (body === undefined && input instanceof Request) body = await input.clone().text();
        const ids = idsFromDownloadBody(body);
        if (ids) {
          const done = armed;
          armed = null;
          done(ids);
          return new Response(JSON.stringify({ totalSize: 0, archives: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }
      // Never let a download through while capturing.
      const single = method === 'GET' ? ORIGINAL.exec(url) : null;
      if (single) {
        const done = armed;
        armed = null;
        done([single[1]!.toLowerCase()]);
        return new Response(null, { status: 204 });
      }
      if (DOWNLOAD_ARCHIVE.test(url)) return new Response(null, { status: 204 });
    }
    return original.apply(this, [input, init] as Parameters<typeof fetch>);
  } as typeof fetch;
}

/**
 * All selected ids via Immich's download shortcut, or null when Immich didn't ask within the
 * timeout (its shortcut or request changed). Immich clears the selection afterwards, as after
 * a download.
 */
export function captureSelectedIds(timeoutMs = 2000): Promise<string[] | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      armed = null;
      resolve(null);
    }, timeoutMs);
    armed = (ids) => {
      clearTimeout(timer);
      resolve(ids);
    };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'D', code: 'KeyD', shiftKey: true, bubbles: true, cancelable: true }));
  });
}
