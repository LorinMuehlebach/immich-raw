// What the editor has stored on a RAW: its saved edit and that edit's JPEG, read from Immich's
// asset metadata. Immich can't read the metadata of many photos in one request, so this asks one
// photo at a time, a few at once, and remembers the answer for as long as the page is open (the
// filmstrip asks for the photos it shows; the editor tells it what it read or saved itself).
import { getAssetMetadata } from '@immich/sdk';
import type { Recipe } from '@immich-raw/recipe';
import { storedEdit } from './copies.ts';

export interface EditState {
  /** The saved edit of the RAW (not of a virtual copy), or null when it has none. */
  stored: Recipe | null;
  /** The JPEG that edit saved into the RAW's stack, if any. */
  renderId: string | null;
}

type Items = readonly { key: string; value: unknown }[];

export const NO_EDIT: EditState = { stored: null, renderId: null };

export function editStateOf(items: Items): EditState {
  const stored = storedEdit(items, null);
  return { stored, renderId: stored?.render?.assetId ?? null };
}

export interface EditStates {
  /** The photo's state; NO_EDIT when it can't be read (not remembered, so it is asked again later). */
  get(id: string): Promise<EditState>;
  /** The state from a metadata listing the caller read anyway. */
  remember(id: string, items: Items): void;
  /** Its stored edit changed (a save): ask again next time. */
  forget(id: string): void;
}

export function createEditStates(read: (id: string) => Promise<Items>, concurrency = 8): EditStates {
  const known = new Map<string, Promise<EditState>>();
  let running = 0;
  const waiting: (() => void)[] = [];

  async function inTurn<T>(job: () => Promise<T>): Promise<T> {
    if (running >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await job();
    } finally {
      running--;
      waiting.shift()?.();
    }
  }

  return {
    get(id) {
      let state = known.get(id);
      if (!state) {
        state = inTurn(() => read(id)).then(editStateOf, () => {
          if (known.get(id) === state) known.delete(id);
          return NO_EDIT;
        });
        known.set(id, state);
      }
      return state;
    },
    remember(id, items) {
      known.set(id, Promise.resolve(editStateOf(items)));
    },
    forget(id) {
      known.delete(id);
    },
  };
}

export const editStates = createEditStates((id) => getAssetMetadata({ id }));
