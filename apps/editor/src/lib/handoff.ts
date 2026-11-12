// The selection Immich's toolbar buttons hand to the export and auto-stack pages (see
// packages/inject/src/handoff.ts).
import { HANDOFF_PREFIX, parseHandoff, type SelectionHandoff } from '@immich-raw/inject/handoff';

/** The selection stored under `key`. Kept for this tab, so reloading the page still works. */
export function readHandoff(key: string): SelectionHandoff | null {
  if (!key) return null;
  const name = HANDOFF_PREFIX + key;
  try {
    const raw = localStorage.getItem(name) ?? sessionStorage.getItem(name);
    if (!raw) return null;
    sessionStorage.setItem(name, raw);
    localStorage.removeItem(name);
    return parseHandoff(JSON.parse(raw));
  } catch {
    return null;
  }
}
