// Which Immich pages show a single asset, and what context they were opened from.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const VIEWER = new RegExp(`/photos/(${UUID})(?:/|$)`, 'i');
const ALBUM = new RegExp(`^/albums/(${UUID})/`, 'i');
const PERSON = new RegExp(`^/people/(${UUID})/`, 'i');
// Shared links, trash and the locked folder: no editing there.
const EXCLUDED = /^\/(share|s|trash|locked)(\/|$)/i;

export interface ViewerRoute {
  assetId: string;
  /** Where the viewer was opened from, for the editor's filmstrip: album:<id>, person:<id> or timeline. */
  context: string;
}

/** Shared links, trash and the locked folder, where the editor's buttons don't appear. */
export function isExcludedPath(pathname: string): boolean {
  return EXCLUDED.test(pathname);
}

const ALBUM_PAGE = new RegExp(`^/albums/(${UUID})(?:/|$)`, 'i');
const PERSON_PAGE = new RegExp(`^/people/(${UUID})(?:/|$)`, 'i');

/** The page a selection was made on: album:<id>, person:<id> or timeline (everything else). */
export function pageContext(pathname: string): string {
  const album = ALBUM_PAGE.exec(pathname);
  if (album) return `album:${album[1]!.toLowerCase()}`;
  const person = PERSON_PAGE.exec(pathname);
  if (person) return `person:${person[1]!.toLowerCase()}`;
  return 'timeline';
}

export function parseViewerRoute(pathname: string): ViewerRoute | null {
  if (EXCLUDED.test(pathname)) return null;
  const match = VIEWER.exec(pathname);
  if (!match) return null;
  const assetId = match[1]!.toLowerCase();
  const album = ALBUM.exec(pathname);
  if (album) return { assetId, context: `album:${album[1]!.toLowerCase()}` };
  const person = PERSON.exec(pathname);
  if (person) return { assetId, context: `person:${person[1]!.toLowerCase()}` };
  return { assetId, context: 'timeline' };
}

/** Accepts only same-origin paths ("/x"), never "//host" or "https://…". */
export function isSafeReturnPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\');
}

export function editorUrl(base: string, rawId: string, context: string, returnPath: string): string {
  const params = new URLSearchParams({ asset: rawId, ctx: context });
  if (isSafeReturnPath(returnPath)) params.set('return', returnPath);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${params.toString()}`;
}

/** The editor's stack window for the stack `assetId` is in, as a page of its own. */
export function stackPageUrl(base: string, assetId: string, context: string, returnPath: string): string {
  const params = new URLSearchParams({ stack: assetId, ctx: context });
  if (isSafeReturnPath(returnPath)) params.set('return', returnPath);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${params.toString()}`;
}
