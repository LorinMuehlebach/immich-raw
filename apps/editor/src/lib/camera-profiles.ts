// The camera profiles converted from the user's Lightroom (see docs/lightroom.md): small JSON files
// under camera-profiles/ next to the editor, with an index.json that says which camera each is for.
// They are not part of the repository (Adobe's profiles are Adobe's), so a missing folder, index or
// file just means there is no profile for the camera, and the Adobe profiles render as Color.
import { cameraProfileFromJson, type CameraProfileData } from '@immich-raw/pipeline';

const DIR = `${import.meta.env.BASE_URL}camera-profiles/`;

interface IndexEntry {
  model: string;
  name: string;
  file: string;
}

/** "Fujifilm X-T30" and "FUJIFILM" + "X-T30" are the same camera: compare letters and digits only. */
export const cameraKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

let index: Promise<IndexEntry[]> | null = null;
const profiles = new Map<string, Promise<CameraProfileData | null>>();

function loadIndex(): Promise<IndexEntry[]> {
  index ??= fetch(`${DIR}index.json`)
    .then(async (r) => {
      if (!r.ok) return [];
      // A dev server answers an unknown path with the page itself: that isn't JSON, so no profiles.
      const j = (await r.json()) as { profiles?: IndexEntry[] } | null;
      return Array.isArray(j?.profiles) ? j.profiles.filter((p) => typeof p?.model === 'string' && typeof p.file === 'string') : [];
    })
    .catch(() => []);
  return index;
}

/** The Adobe Standard profile converted for this camera, or null when there is none. */
export async function loadCameraProfile(make: string, model: string): Promise<CameraProfileData | null> {
  const wanted = new Set([cameraKey(`${make} ${model}`), cameraKey(model)]);
  if (!cameraKey(model)) return null;
  const entry = (await loadIndex()).find((p) => p.name === 'Adobe Standard' && wanted.has(cameraKey(p.model)));
  if (!entry) return null;
  let loaded = profiles.get(entry.file);
  if (!loaded) {
    loaded = fetch(`${DIR}${encodeURIComponent(entry.file)}`)
      .then(async (r) => (r.ok ? cameraProfileFromJson(await r.text()) : null))
      .catch((e) => {
        console.warn(`Camera profile ${entry.file} could not be read`, e);
        return null;
      });
    profiles.set(entry.file, loaded);
  }
  return loaded;
}
