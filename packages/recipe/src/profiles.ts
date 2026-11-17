// The profiles a recipe can name. How each one renders lives in @immich-raw/pipeline
// (color/profiles.ts); this table is what the recipe, the UI and XMP import share.

/** In-house profiles, available for every camera. */
export const BASIC_PROFILE_IDS = ['color', 'vivid', 'portrait', 'landscape', 'neutral', 'monochrome', 'linear'] as const;

/**
 * Fujifilm film looks: community look tables (github.com/abpy/FujifilmCameraProfiles) that the
 * editor downloads at run time. They work on every camera; Fujifilm RAWs open with the one
 * chosen in the camera.
 */
export const FUJI_PROFILE_IDS = [
  'fuji-provia',
  'fuji-velvia',
  'fuji-astia',
  'fuji-classic-chrome',
  'fuji-reala-ace',
  'fuji-pro-neg-hi',
  'fuji-pro-neg-std',
  'fuji-classic-neg',
  'fuji-nostalgic-neg',
  'fuji-eterna',
  'fuji-bleach-bypass',
] as const;

/**
 * Adobe's camera profiles (the hue/saturation map of "Adobe Standard", plus the look that makes
 * "Adobe Color"), made from the user's own Lightroom profile file for the camera. Without that
 * file for the photo's camera they render as Color.
 */
export const CAMERA_PROFILE_IDS = ['adobe-color', 'adobe-standard'] as const;

export type BasicProfileId = (typeof BASIC_PROFILE_IDS)[number];
export type FujiProfileId = (typeof FUJI_PROFILE_IDS)[number];
export type CameraProfileId = (typeof CAMERA_PROFILE_IDS)[number];
export type ProfileId = BasicProfileId | FujiProfileId | CameraProfileId;
export type ProfileGroup = 'basic' | 'fuji' | 'camera';

export interface ProfileInfo {
  id: ProfileId;
  label: string;
  group: ProfileGroup;
  /** Has an Amount slider (a look that can be blended in and out, like Lightroom's creative profiles). */
  amount: boolean;
  /** Needs the Fujifilm film looks to be downloaded. */
  download: boolean;
  /** Needs the camera profile converted from the user's Lightroom (see camera-profile.ts in the pipeline). */
  camera: boolean;
}

export const PROFILE_GROUPS: { id: ProfileGroup; label: string }[] = [
  { id: 'basic', label: 'Profiles' },
  { id: 'camera', label: 'Camera profiles' },
  { id: 'fuji', label: 'Fujifilm film looks' },
];

const basic = (id: BasicProfileId, label: string, amount = false): ProfileInfo => ({ id, label, group: 'basic', amount, download: false, camera: false });
const fuji = (id: FujiProfileId, label: string): ProfileInfo => ({ id, label, group: 'fuji', amount: true, download: true, camera: false });
const camera = (id: CameraProfileId, label: string): ProfileInfo => ({ id, label, group: 'camera', amount: true, download: false, camera: true });

export const PROFILES: ProfileInfo[] = [
  basic('color', 'Color'),
  basic('vivid', 'Vivid', true),
  basic('portrait', 'Portrait', true),
  basic('landscape', 'Landscape', true),
  basic('neutral', 'Neutral'),
  basic('monochrome', 'Monochrome'),
  basic('linear', 'Linear'),
  camera('adobe-color', 'Adobe Color'),
  camera('adobe-standard', 'Adobe Standard'),
  fuji('fuji-provia', 'Provia/Standard'),
  fuji('fuji-velvia', 'Velvia/Vivid'),
  fuji('fuji-astia', 'Astia/Soft'),
  fuji('fuji-classic-chrome', 'Classic Chrome'),
  fuji('fuji-reala-ace', 'Reala Ace'),
  fuji('fuji-pro-neg-hi', 'Pro Neg. Hi'),
  fuji('fuji-pro-neg-std', 'Pro Neg. Std'),
  fuji('fuji-classic-neg', 'Classic Neg.'),
  fuji('fuji-nostalgic-neg', 'Nostalgic Neg.'),
  fuji('fuji-eterna', 'Eterna/Cinema'),
  fuji('fuji-bleach-bypass', 'Eterna Bleach Bypass'),
];

const BY_ID = new Map(PROFILES.map((p) => [p.id, p]));

export function isProfileId(v: unknown): v is ProfileId {
  return typeof v === 'string' && BY_ID.has(v as ProfileId);
}

export function profileInfo(id: ProfileId): ProfileInfo {
  return BY_ID.get(id) ?? BY_ID.get('color')!;
}

export function isFujiProfile(id: ProfileId): id is FujiProfileId {
  return id.startsWith('fuji-');
}

export function isCameraProfile(id: ProfileId): id is CameraProfileId {
  return id.startsWith('adobe-');
}
