// Recipe + camera data -> shader parameters. Pure, so it can be unit-tested.
import type { Recipe } from '@immich-raw/recipe';
import {
  LMS_TO_PROPHOTO,
  LMS_TO_SRGB,
  PROPHOTO_TO_LMS,
  PROPHOTO_TO_SRGB,
  SRGB_TO_LMS,
  calibrationMatrix,
  cameraToProPhoto,
  gradingUniforms,
  mixerUniforms,
  mul3,
  multipliersForTempTint,
  normalizeCamMul,
  profileExposureEv,
  resolveProfile,
  tempTintForMultipliers,
  fromRows,
  type Mat3,
  type ProfileRender,
  type TempTint,
  type Vec3,
} from './color/index.ts';

export interface CameraInfo {
  /** LibRaw flip. */
  flip: number;
  /** Full-resolution sensor size (the export size before cropping). */
  fullWidth: number;
  fullHeight: number;
  /** As-shot multipliers normalised to G = 1. */
  camMul: Vec3;
  camXyz: Mat3;
  camToWork: Mat3;
  baselineExposure: number;
  asShot: TempTint;
  /** EXIF ISO (scales noise reduction to the expected noise); absent = 100. */
  iso?: number;
}

export function cameraInfo(meta: {
  flip: number;
  width: number;
  height: number;
  camMul: number[];
  camXyz: number[][];
  rgbCam: number[][];
  baselineExposure: number;
  iso?: number;
}): CameraInfo {
  const camMul = normalizeCamMul(meta.camMul);
  const camXyz = fromRows(meta.camXyz);
  return {
    flip: meta.flip,
    fullWidth: meta.width,
    fullHeight: meta.height,
    camMul,
    camXyz,
    camToWork: cameraToProPhoto(meta.rgbCam),
    baselineExposure: Number.isFinite(meta.baselineExposure) && Math.abs(meta.baselineExposure) <= 10 ? meta.baselineExposure : 0,
    asShot: tempTintForMultipliers(camXyz, camMul),
    iso: meta.iso && Number.isFinite(meta.iso) && meta.iso > 0 ? meta.iso : undefined,
  };
}

export interface DevelopUniforms {
  uWb: number[];
  uClip: number[];
  uCamToWork: Mat3;
  uExposure: number;
  uTone: number[];
  uContrast: number;
  uPresence: number[];
  uProfile: number;
}

/** White balance multipliers the recipe asks for, normalised to G = 1. */
export function recipeMultipliers(recipe: Recipe, cam: CameraInfo): Vec3 {
  if (recipe.wb.mode === 'asShot') return cam.camMul;
  return multipliersForTempTint(cam.camXyz, recipe.wb.temp, recipe.wb.tint);
}

/**
 * Develop-stage uniforms. `profile` is what renders for recipe.profile (see resolveProfile:
 * a Fujifilm look that isn't downloaded renders as Color); its baseline exposure is like
 * Camera Raw's camera baseline.
 */
export function developUniforms(recipe: Recipe, cam: CameraInfo, profile: ProfileRender = resolveProfile(recipe.profile)): DevelopUniforms {
  const mul = cam.camMul;
  const mx = Math.max(...mul);
  const mn = Math.min(...mul);
  // LibRaw (highlight=1) scaled channel c by mul_c / max(mul); this restores mul_c / min(mul).
  const comp = mx / mn;
  const target = recipeMultipliers(recipe, cam);
  const ratio = [0, 1, 2].map((c) => target[c]! / mul[c]!);
  const b = recipe.basic;
  return {
    uWb: ratio.map((r) => r * comp),
    // channel c clips at mul_c / max(mul) before scaling
    uClip: [0, 1, 2].map((c) => (mul[c]! / mx) * comp * ratio[c]!),
    // Calibration re-interprets the primaries, so it belongs to the camera -> working matrix.
    uCamToWork: mul3(calibrationMatrix(recipe.calibration), cam.camToWork),
    uExposure: 2 ** (b.exposure + cam.baselineExposure + profileExposureEv(profile, recipe.profileAmount)),
    uTone: [b.shadows / 100, b.highlights / 100, b.whites / 100, b.blacks / 100],
    uContrast: b.contrast / 100,
    uPresence: [b.vibrance / 100, b.saturation / 100],
    uProfile: profile.base,
  };
}

/** Color Mixer, B&W mix, Color Grading and Calibration shadow tint (tone pass). */
export function lookUniforms(recipe: Recipe) {
  return {
    ...mixerUniforms(recipe),
    ...gradingUniforms(recipe),
    uShadowTint: recipe.calibration.shadowTint / 100,
  };
}

export const STATIC_UNIFORMS = {
  uWorkToLms: PROPHOTO_TO_LMS,
  uLmsToWork: LMS_TO_PROPHOTO,
  uWorkToSrgb: PROPHOTO_TO_SRGB,
  uSrgbToLms: SRGB_TO_LMS,
  uLmsToSrgb: LMS_TO_SRGB,
};

/**
 * Sharpening in render pixels. `scale` = render pixels per full-resolution pixel (1 for
 * export, ~0.3 for the fitted preview). Noise reduction runs earlier (effects.ts).
 */
export function finishUniforms(recipe: Recipe, scale: number) {
  const d = recipe.detail;
  const sharpenSigma = d.sharpenRadius * 0.6 * scale;
  return {
    // The second sigma blurs the colour difference, which the finish pass no longer uses.
    blurSigma: [sharpenSigma, 0] as [number, number],
    uSharpen: [(d.sharpenAmount / 100) * 1.4, d.sharpenDetail / 100, d.sharpenMasking / 100, d.sharpenAmount > 0 && sharpenSigma > 0.25 ? 1 : 0],
  };
}

/** New multipliers that make the camera colour `rgb` (as decoded, as-shot WB) neutral. */
export function multipliersForNeutral(rgb: Vec3, cam: CameraInfo): Vec3 {
  // decoded_c ∝ raw_c * mul_c, so the raw neutral is decoded_c / mul_c
  const m = [0, 1, 2].map((c) => cam.camMul[c]! / Math.max(rgb[c]!, 1e-6));
  return [m[0]! / m[1]!, 1, m[2]! / m[1]!];
}

export function tempTintForNeutral(rgb: Vec3, cam: CameraInfo): TempTint {
  return tempTintForMultipliers(cam.camXyz, multipliersForNeutral(rgb, cam));
}
