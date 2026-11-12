// Setting groups, as in Lightroom's Copy Settings dialog. One table used by copy/paste,
// presets, the XMP import report and panel resets.
import { getPath, setPath } from './params.ts';
import type { Recipe } from './recipe.ts';

export type GroupId =
  | 'profile'
  | 'wb'
  | 'tone'
  | 'presence'
  | 'toneCurve'
  | 'colorMixer'
  | 'colorGrading'
  | 'sharpening'
  | 'noise'
  | 'calibration'
  | 'lens'
  | 'transform'
  | 'effects'
  | 'crop'
  | 'masks';

export interface SettingGroup {
  id: GroupId;
  label: string;
  /** Recipe paths copied as a whole (objects are copied deeply). */
  paths: string[];
  /** Lightroom leaves crop unchecked by default when copying settings. */
  defaultOn: boolean;
}

export const GROUPS: SettingGroup[] = [
  { id: 'profile', label: 'Profile', paths: ['profile', 'profileAmount'], defaultOn: true },
  { id: 'wb', label: 'White Balance', paths: ['wb'], defaultOn: true },
  {
    id: 'tone',
    label: 'Basic Tone',
    paths: ['basic.exposure', 'basic.contrast', 'basic.highlights', 'basic.shadows', 'basic.whites', 'basic.blacks'],
    defaultOn: true,
  },
  {
    id: 'presence',
    label: 'Presence',
    paths: ['basic.texture', 'basic.clarity', 'basic.dehaze', 'basic.vibrance', 'basic.saturation'],
    defaultOn: true,
  },
  { id: 'toneCurve', label: 'Tone Curve', paths: ['toneCurve'], defaultOn: true },
  { id: 'colorMixer', label: 'Color Mixer & B&W', paths: ['colorMixer', 'bwMix'], defaultOn: true },
  { id: 'colorGrading', label: 'Color Grading', paths: ['colorGrading'], defaultOn: true },
  {
    id: 'sharpening',
    label: 'Sharpening',
    paths: ['detail.sharpenAmount', 'detail.sharpenRadius', 'detail.sharpenDetail', 'detail.sharpenMasking'],
    defaultOn: true,
  },
  {
    id: 'noise',
    label: 'Noise Reduction',
    paths: ['detail.nrLuminance', 'detail.nrLuminanceDetail', 'detail.nrLuminanceContrast', 'detail.nrColor', 'detail.nrColorDetail', 'detail.nrColorSmoothness'],
    defaultOn: true,
  },
  { id: 'lens', label: 'Lens Corrections', paths: ['lens'], defaultOn: true },
  { id: 'transform', label: 'Transform', paths: ['transform'], defaultOn: false },
  { id: 'effects', label: 'Effects', paths: ['effects'], defaultOn: true },
  { id: 'calibration', label: 'Calibration', paths: ['calibration'], defaultOn: true },
  { id: 'crop', label: 'Crop & Straighten', paths: ['crop'], defaultOn: false },
  // Masks are drawn for one photo's content, so Lightroom leaves them out by default too.
  { id: 'masks', label: 'Masking', paths: ['masks'], defaultOn: false },
];

export const DEFAULT_GROUPS: GroupId[] = GROUPS.filter((g) => g.defaultOn).map((g) => g.id);

/** A partial recipe holding only the chosen groups' values: what presets and the clipboard store. */
export type SettingsPatch = Record<string, unknown>;

export function pickGroups(recipe: Recipe, groups: readonly GroupId[]): SettingsPatch {
  const patch: SettingsPatch = {};
  for (const g of GROUPS) {
    if (!groups.includes(g.id)) continue;
    for (const path of g.paths) {
      const v = getPath(recipe, path);
      if (v !== undefined) setPath(patch, path, structuredClone(v));
    }
  }
  return patch;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Copies `src` into `dst` field by field, so a partial patch only changes what it contains. */
function mergeInto(dst: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (isPlainObject(v) && isPlainObject(dst[k])) mergeInto(dst[k] as Record<string, unknown>, v);
    else dst[k] = structuredClone(v);
  }
}

/**
 * Applies a patch onto a recipe (in place). Only known group paths are taken; objects are
 * merged (a preset with only the shadow wheel leaves the other wheels alone), arrays such
 * as curve points are replaced.
 */
export function applyPatch(recipe: Recipe, patch: SettingsPatch): Recipe {
  for (const g of GROUPS) {
    for (const path of g.paths) {
      const v = getPath(patch, path);
      if (v === undefined) continue;
      const cur = getPath(recipe, path);
      if (isPlainObject(v) && isPlainObject(cur)) mergeInto(cur, v);
      else setPath(recipe, path, structuredClone(v));
    }
  }
  return recipe;
}

/** Which groups a patch touches. */
export function patchGroups(patch: SettingsPatch): GroupId[] {
  return GROUPS.filter((g) => g.paths.some((p) => getPath(patch, p) !== undefined)).map((g) => g.id);
}
