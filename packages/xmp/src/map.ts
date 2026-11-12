// crs: (Lightroom / Camera Raw, Process Version 2012+) <-> recipe paths.
import {
  BANDS,
  BAND_LABELS,
  BW_PARAMS,
  CALIBRATION_PARAMS,
  CURVE_CHANNELS,
  EFFECTS_PARAMS,
  GRADING_BALANCE,
  GRADING_BLENDING,
  GRADING_PARAMS,
  LENS_PARAMS,
  MIXER_PARAMS,
  PARAMS,
  TRANSFORM_PARAMS,
  clampParam,
  isProfileId,
  normalizeCurve,
  patchGroups,
  profileInfo,
  setPath,
  type CurveChannel,
  type GroupId,
  type ParamSpec,
  type ProfileId,
  type SettingsPatch,
} from '@immich-raw/recipe';
import { lrCropToCrop, turnsFromExifOrientation, type CropContext } from './crop.ts';
import { MASK_CONTAINERS, importMasks } from './masks.ts';
import type { CrsSettings } from './parse.ts';

export interface NumberRow {
  key: string;
  spec: ParamSpec;
  /** How Lightroom writes it: decimals and a leading '+' for positive values. */
  decimals: number;
  signed: boolean;
}

const row = (key: string, spec: ParamSpec, decimals = 0, signed = true): NumberRow => ({ key, spec, decimals, signed });

/** Plain numeric settings, mapped 1:1 (values clamped to our ranges). */
export const NUMBER_ROWS: NumberRow[] = [
  row('Exposure2012', PARAMS.exposure, 2),
  row('Contrast2012', PARAMS.contrast),
  row('Highlights2012', PARAMS.highlights),
  row('Shadows2012', PARAMS.shadows),
  row('Whites2012', PARAMS.whites),
  row('Blacks2012', PARAMS.blacks),
  row('Texture', PARAMS.texture),
  row('Clarity2012', PARAMS.clarity),
  row('Dehaze', PARAMS.dehaze),
  row('Vibrance', PARAMS.vibrance),
  row('Saturation', PARAMS.saturation),
  row('ParametricShadows', PARAMS.curveShadows),
  row('ParametricDarks', PARAMS.curveDarks),
  row('ParametricLights', PARAMS.curveLights),
  row('ParametricHighlights', PARAMS.curveHighlights),
  row('ParametricShadowSplit', PARAMS.curveShadowSplit, 0, false),
  row('ParametricMidtoneSplit', PARAMS.curveMidtoneSplit, 0, false),
  row('ParametricHighlightSplit', PARAMS.curveHighlightSplit, 0, false),
  row('Sharpness', PARAMS.sharpenAmount, 0, false),
  row('SharpenRadius', PARAMS.sharpenRadius, 1),
  row('SharpenDetail', PARAMS.sharpenDetail, 0, false),
  row('SharpenEdgeMasking', PARAMS.sharpenMasking, 0, false),
  row('LuminanceSmoothing', PARAMS.nrLuminance, 0, false),
  row('LuminanceNoiseReductionDetail', PARAMS.nrLuminanceDetail, 0, false),
  row('LuminanceNoiseReductionContrast', PARAMS.nrLuminanceContrast, 0, false),
  row('ColorNoiseReduction', PARAMS.nrColor, 0, false),
  row('ColorNoiseReductionDetail', PARAMS.nrColorDetail, 0, false),
  row('ColorNoiseReductionSmoothness', PARAMS.nrColorSmoothness, 0, false),
  // Color Mixer (HSL) and B&W mix: HueAdjustmentRed ... GrayMixerMagenta
  ...BANDS.flatMap((b) => [
    row(`HueAdjustment${BAND_LABELS[b]}`, MIXER_PARAMS.hue[b]),
    row(`SaturationAdjustment${BAND_LABELS[b]}`, MIXER_PARAMS.saturation[b]),
    row(`LuminanceAdjustment${BAND_LABELS[b]}`, MIXER_PARAMS.luminance[b]),
  ]),
  ...BANDS.map((b) => row(`GrayMixer${BAND_LABELS[b]}`, BW_PARAMS[b])),
  // Color Grading. Lightroom keeps the shadow/highlight hue and saturation in the older
  // Split Toning keys; midtones, luminance, global and blending are ColorGrade* keys.
  row('SplitToningShadowHue', GRADING_PARAMS.shadows.hue, 0, false),
  row('SplitToningShadowSaturation', GRADING_PARAMS.shadows.sat, 0, false),
  row('SplitToningHighlightHue', GRADING_PARAMS.highlights.hue, 0, false),
  row('SplitToningHighlightSaturation', GRADING_PARAMS.highlights.sat, 0, false),
  row('SplitToningBalance', GRADING_BALANCE),
  row('ColorGradeMidtoneHue', GRADING_PARAMS.midtones.hue, 0, false),
  row('ColorGradeMidtoneSat', GRADING_PARAMS.midtones.sat, 0, false),
  row('ColorGradeShadowLum', GRADING_PARAMS.shadows.lum),
  row('ColorGradeMidtoneLum', GRADING_PARAMS.midtones.lum),
  row('ColorGradeHighlightLum', GRADING_PARAMS.highlights.lum),
  row('ColorGradeGlobalHue', GRADING_PARAMS.global.hue, 0, false),
  row('ColorGradeGlobalSat', GRADING_PARAMS.global.sat, 0, false),
  row('ColorGradeGlobalLum', GRADING_PARAMS.global.lum),
  row('ColorGradeBlending', GRADING_BLENDING, 0, false),
  // Calibration
  row('ShadowTint', CALIBRATION_PARAMS.shadowTint),
  row('RedHue', CALIBRATION_PARAMS.redHue),
  row('RedSaturation', CALIBRATION_PARAMS.redSaturation),
  row('GreenHue', CALIBRATION_PARAMS.greenHue),
  row('GreenSaturation', CALIBRATION_PARAMS.greenSaturation),
  row('BlueHue', CALIBRATION_PARAMS.blueHue),
  row('BlueSaturation', CALIBRATION_PARAMS.blueSaturation),
  // Lens Corrections
  row('LensProfileDistortionScale', LENS_PARAMS.profileDistortion, 0, false),
  row('LensProfileVignettingScale', LENS_PARAMS.profileVignetting, 0, false),
  row('LensManualDistortionAmount', LENS_PARAMS.distortion),
  row('VignetteAmount', LENS_PARAMS.vignetting),
  row('VignetteMidpoint', LENS_PARAMS.vignetteMidpoint, 0, false),
  row('DefringePurpleAmount', LENS_PARAMS.defringePurple, 0, false),
  row('DefringePurpleHueLo', LENS_PARAMS.defringePurpleLo, 0, false),
  row('DefringePurpleHueHi', LENS_PARAMS.defringePurpleHi, 0, false),
  row('DefringeGreenAmount', LENS_PARAMS.defringeGreen, 0, false),
  row('DefringeGreenHueLo', LENS_PARAMS.defringeGreenLo, 0, false),
  row('DefringeGreenHueHi', LENS_PARAMS.defringeGreenHi, 0, false),
  // Transform (manual sliders; Upright's automatic modes are reported as skipped)
  row('PerspectiveVertical', TRANSFORM_PARAMS.vertical),
  row('PerspectiveHorizontal', TRANSFORM_PARAMS.horizontal),
  row('PerspectiveRotate', TRANSFORM_PARAMS.rotate, 1),
  row('PerspectiveAspect', TRANSFORM_PARAMS.aspect),
  row('PerspectiveScale', TRANSFORM_PARAMS.scale, 0, false),
  row('PerspectiveX', TRANSFORM_PARAMS.offsetX, 1),
  row('PerspectiveY', TRANSFORM_PARAMS.offsetY, 1),
  // Effects
  row('PostCropVignetteAmount', EFFECTS_PARAMS.vignetteAmount),
  row('PostCropVignetteMidpoint', EFFECTS_PARAMS.vignetteMidpoint, 0, false),
  row('PostCropVignetteRoundness', EFFECTS_PARAMS.vignetteRoundness),
  row('PostCropVignetteFeather', EFFECTS_PARAMS.vignetteFeather, 0, false),
  row('PostCropVignetteHighlightContrast', EFFECTS_PARAMS.vignetteHighlights, 0, false),
  row('GrainAmount', EFFECTS_PARAMS.grainAmount, 0, false),
  row('GrainSize', EFFECTS_PARAMS.grainSize, 0, false),
  row('GrainFrequency', EFFECTS_PARAMS.grainRoughness, 0, false),
];

/** On/off settings (Lightroom writes 1/0 or True/False). */
export const BOOL_ROWS: { key: string; path: string }[] = [
  { key: 'LensProfileEnable', path: 'lens.profile' },
  { key: 'AutoLateralCA', path: 'lens.removeCA' },
  { key: 'CropConstrainToWarp', path: 'transform.constrain' },
];

/** Settings stored as a number in XMP and as a name in the recipe. */
export const ENUM_ROWS: { key: string; path: string; values: Record<string, string> }[] = [
  { key: 'PostCropVignetteStyle', path: 'effects.vignetteStyle', values: { '1': 'highlight', '2': 'color', '3': 'paint' } },
];

/** Other spellings some tools write; read only when the main key is missing. */
export const ALIAS_ROWS: { key: string; main: string; spec: ParamSpec }[] = [
  { key: 'ColorGradeShadowHue', main: 'SplitToningShadowHue', spec: GRADING_PARAMS.shadows.hue },
  { key: 'ColorGradeShadowSat', main: 'SplitToningShadowSaturation', spec: GRADING_PARAMS.shadows.sat },
  { key: 'ColorGradeHighlightHue', main: 'SplitToningHighlightHue', spec: GRADING_PARAMS.highlights.hue },
  { key: 'ColorGradeHighlightSat', main: 'SplitToningHighlightSaturation', spec: GRADING_PARAMS.highlights.sat },
];

export const CURVE_KEYS: Record<CurveChannel, string> = {
  master: 'ToneCurvePV2012',
  red: 'ToneCurvePV2012Red',
  green: 'ToneCurvePV2012Green',
  blue: 'ToneCurvePV2012Blue',
};

/** Lightroom's white balance presets for raw files (Temp, Tint), used when a preset has no Temperature. */
const WB_PRESETS: Record<string, [number, number]> = {
  Daylight: [5500, 10],
  Cloudy: [6500, 10],
  Shade: [7500, 10],
  Tungsten: [2850, 0],
  Fluorescent: [3800, 21],
  Flash: [5500, 0],
};

/** Keys that carry no develop setting (bookkeeping, preset metadata, names of mapped things). */
const SILENT = new Set([
  'Version', 'ProcessVersion', 'CompatibleVersion', 'HasSettings', 'AlreadyApplied', 'RawFileName', 'CameraProfileDigest',
  'PresetType', 'UUID', 'Cluster', 'SupportsAmount', 'SupportsAmount2', 'SupportsColor', 'SupportsMonochrome',
  'SupportsHighDynamicRange', 'SupportsNormalDynamicRange', 'SupportsSceneReferred', 'SupportsOutputReferred',
  'RequiresRGBTables', 'CameraModelRestriction', 'Copyright', 'ContactInfo', 'Name', 'ShortName', 'SortName', 'Group',
  'Description', 'ToneCurveName', 'ToneCurveName2012', 'WhiteBalance', 'Temperature', 'Tint', 'CameraProfile',
  'Treatment', 'ConvertToGrayscale', 'HasCrop', 'CropTop', 'CropLeft', 'CropBottom', 'CropRight', 'CropAngle',
  'CropConstrainToUnitSquare', 'CropWidth', 'CropHeight', 'CropUnit', 'OverrideLookVignette',
  'DefaultsSpecificToSerial', 'DefaultsSpecificToISO', 'LookTable', 'Look', 'PresetName', 'AutoGrayscaleMix',
  // Which profile Lightroom picked; the editor finds its own (Lensfun) from the photo.
  'LensProfileName', 'LensProfileFilename', 'LensProfileDigest', 'LensProfileSetup', 'LensProfileIsEmbedded',
  // The random seed of Lightroom's grain pattern; the editor's grain has its own.
  'GrainSeed',
]);

/** Pre-2012 process version settings. */
const LEGACY = new Set(['Exposure', 'Shadows', 'Brightness', 'Contrast', 'FillLight', 'HighlightRecovery', 'Clarity', 'ToneCurve', 'ToneCurveRed', 'ToneCurveGreen', 'ToneCurveBlue']);

/** Lightroom defaults that aren't 0, so an untouched value doesn't count as "skipped". */
const DEFAULTS: Record<string, number> = {
  LuminanceNoiseReductionDetail: 50,
  ColorNoiseReductionDetail: 50,
  ColorNoiseReductionSmoothness: 50,
  VignetteMidpoint: 50,
  PostCropVignetteMidpoint: 50,
  PostCropVignetteFeather: 50,
  PostCropVignetteStyle: 1,
  GrainSize: 25,
  GrainFrequency: 50,
  DefringePurpleHueLo: 30,
  DefringePurpleHueHi: 70,
  DefringeGreenHueLo: 40,
  DefringeGreenHueHi: 60,
  LensProfileDistortionScale: 100,
  LensProfileVignettingScale: 100,
  LensProfileChromaticAberrationScale: 100,
  PerspectiveScale: 100,
  ColorGradeBlending: 50,
  CurveRefineSaturation: 100,
  UprightCenterNormX: 0.5,
  UprightCenterNormY: 0.5,
  UprightFocalLength35mm: 35,
};

const INACTIVE_STRINGS = new Set(['', '0', 'false', 'none', 'linear', 'lensdefaults', 'default', 'off']);

/** Unmapped areas summarised in the warnings (later milestones add rows for them). */
const CATEGORIES: { label: string; test: (k: string) => boolean }[] = [
  { label: 'Color Mixer', test: (k) => /^(Hue|Saturation|Luminance)Adjustment|^GrayMixer|^ColorMixer/.test(k) },
  { label: 'Color Grading', test: (k) => /^(ColorGrade|SplitToning)/.test(k) },
  { label: 'Calibration', test: (k) => /^(ShadowTint|(Red|Green|Blue)(Hue|Saturation))$/.test(k) },
  { label: 'Lens Corrections', test: (k) => /^(LensProfile|LensManual|AutoLateralCA|Defringe|Vignette(Amount|Midpoint))/.test(k) },
  { label: 'Transform', test: (k) => /^(Perspective|Upright)/.test(k) },
  { label: 'Effects', test: (k) => /^(PostCropVignette|Grain)/.test(k) },
];

const RETOUCH_KEYS = /^(RetouchAreas|RetouchInfo|RedEyeInfo)$/;
const MASK_KEYS = new Set<string>(MASK_CONTAINERS);

export interface AppliedSetting {
  key: string;
  value: string;
  path: string;
}

export interface ImportResult {
  patch: SettingsPatch;
  groups: GroupId[];
  applied: AppliedSetting[];
  /** Settings with non-default values that this version can't apply. */
  unmapped: string[];
  warnings: string[];
}

export const parseNumber = (v: string | undefined): number => (v === undefined ? NaN : Number(v.trim().replace(/^\+/, '')));

const isActive = (key: string, value: string): boolean => {
  const n = parseNumber(value);
  if (Number.isFinite(n)) return n !== (DEFAULTS[key] ?? 0);
  return !INACTIVE_STRINGS.has(value.trim().toLowerCase());
};

/** Parses "x, y" curve points (0..255). */
export function parseCurve(items: string[]): [number, number][] {
  return items
    .map((s) => s.split(',').map((p) => parseNumber(p)))
    .filter((p) => p.length >= 2 && p.every(Number.isFinite))
    .map((p) => [p[0]!, p[1]!] as [number, number]);
}

/** Lightroom profile names with a counterpart here, in match order. */
const PROFILE_NAMES: [RegExp, ProfileId][] = [
  [/^Adobe Color$/i, 'color'],
  [/^Adobe Vivid$/i, 'vivid'],
  [/^Adobe Portrait$/i, 'portrait'],
  [/^Adobe Landscape$/i, 'landscape'],
  [/^Adobe Neutral$/i, 'neutral'],
  [/^Adobe Monochrome$/i, 'monochrome'],
  // Fujifilm camera-matching profiles ("Camera PROVIA/Standard", "Camera CLASSIC Neg.", ...).
  [/^Camera PROVIA/i, 'fuji-provia'],
  [/^Camera Velvia/i, 'fuji-velvia'],
  [/^Camera ASTIA/i, 'fuji-astia'],
  [/^Camera CLASSIC CHROME/i, 'fuji-classic-chrome'],
  [/^Camera PRO ?Neg\.? ?Hi/i, 'fuji-pro-neg-hi'],
  [/^Camera PRO ?Neg\.? ?Std/i, 'fuji-pro-neg-std'],
  [/^Camera ETERNA BLEACH BYPASS/i, 'fuji-bleach-bypass'],
  [/^Camera ETERNA/i, 'fuji-eterna'],
  [/^Camera CLASSIC Neg/i, 'fuji-classic-neg'],
  [/^Camera NOSTALGIC Neg/i, 'fuji-nostalgic-neg'],
  [/^Camera REALA ACE/i, 'fuji-reala-ace'],
];

/** The profile for a Lightroom profile name; `exact` when it is the same look, not an approximation. */
export function profileFromName(name: string): { id: ProfileId; exact: boolean } {
  const n = name.trim();
  for (const [re, id] of PROFILE_NAMES) if (re.test(n)) return { id, exact: true };
  const near = (id: ProfileId) => ({ id, exact: false });
  if (/monochrome|acros|sepia|b&w|black\s*&?\s*white/i.test(n)) return near('monochrome');
  if (/neutral|flat/i.test(n)) return near('neutral');
  if (/linear/i.test(n)) return near('linear');
  if (/vivid/i.test(n)) return near('vivid');
  if (/portrait/i.test(n)) return near('portrait');
  if (/landscape/i.test(n)) return near('landscape');
  return near('color');
}

/**
 * Maps crs: settings to a recipe patch. `ctx` is needed for the crop and mask positions
 * (they depend on the photo's orientation and aspect); without it they are skipped with a
 * warning.
 */
export function crsToPatch(crs: CrsSettings, ctx?: CropContext): ImportResult {
  const v = crs.values;
  const patch: SettingsPatch = {};
  const applied: AppliedSetting[] = [];
  const warnings: string[] = [];
  const used = new Set<string>();
  const apply = (key: string, path: string, value: unknown, shown = v[key] ?? '') => {
    setPath(patch, path, value);
    applied.push({ key, value: shown, path });
    used.add(key);
  };

  for (const r of NUMBER_ROWS) {
    if (v[r.key] === undefined) continue;
    const n = parseNumber(v[r.key]);
    if (!Number.isFinite(n)) {
      warnings.push(`Ignored ${r.key}="${v[r.key]}" (not a number)`);
      continue;
    }
    apply(r.key, r.spec.path, clampParam(r.spec, n));
  }
  for (const b of BOOL_ROWS) {
    const raw = v[b.key]?.trim().toLowerCase();
    if (raw === undefined) continue;
    if (raw === '1' || raw === 'true') apply(b.key, b.path, true);
    else if (raw === '0' || raw === 'false') apply(b.key, b.path, false);
    else warnings.push(`Ignored ${b.key}="${v[b.key]}" (not on/off)`);
  }
  for (const e of ENUM_ROWS) {
    const raw = v[e.key]?.trim();
    if (raw === undefined) continue;
    const value = e.values[String(parseNumber(raw))];
    if (value) apply(e.key, e.path, value);
    else warnings.push(`Ignored ${e.key}="${raw}" (unknown value)`);
  }
  for (const a of ALIAS_ROWS) {
    if (v[a.key] === undefined || v[a.main] !== undefined) continue;
    const n = parseNumber(v[a.key]);
    if (Number.isFinite(n)) apply(a.key, a.spec.path, clampParam(a.spec, n));
  }

  // White balance
  const wb = v.WhiteBalance?.trim();
  const temp = parseNumber(v.Temperature);
  const tint = parseNumber(v.Tint);
  if (wb === 'As Shot') {
    apply('WhiteBalance', 'wb', { mode: 'asShot', temp: PARAMS.temp.default, tint: PARAMS.tint.default });
  } else if (Number.isFinite(temp)) {
    const t = clampParam(PARAMS.temp, temp);
    const ti = clampParam(PARAMS.tint, Number.isFinite(tint) ? tint : 0);
    apply('Temperature', 'wb', { mode: 'custom', temp: t, tint: ti }, `${v.Temperature} / ${v.Tint ?? '0'}`);
  } else if (wb && WB_PRESETS[wb]) {
    const [t, ti] = WB_PRESETS[wb];
    apply('WhiteBalance', 'wb', { mode: 'custom', temp: t, tint: ti });
    warnings.push(`White balance "${wb}" approximated as ${t} K / ${ti > 0 ? '+' : ''}${ti}`);
  } else if (wb) {
    warnings.push(`White balance "${wb}" is not supported; kept as is`);
  }

  // Tone curve points
  for (const ch of CURVE_CHANNELS) {
    const key = CURVE_KEYS[ch];
    const list = crs.lists[key];
    if (!list) continue;
    const pts = parseCurve(list);
    if (pts.length < 2) {
      warnings.push(`Ignored ${key} (fewer than two points)`);
      continue;
    }
    apply(key, `toneCurve.point.${ch}`, normalizeCurve(pts), list.join(' | '));
  }

  // Profile: our own id, else B&W, else the profile Lightroom names (a Look such as "Adobe
  // Color", or a camera profile such as "Camera CLASSIC CHROME").
  const lookName = v['Look.Name'];
  let profile: ProfileId | null = null;
  let fromLook = false;
  if (isProfileId(crs.extra.Profile)) {
    profile = crs.extra.Profile;
  } else if (v.Treatment === 'Black & White' || v.ConvertToGrayscale === 'True') {
    profile = 'monochrome';
  } else {
    const named = [lookName, v.CameraProfile].filter((n): n is string => !!n).map((n) => ({ n, ...profileFromName(n) }));
    const hit = named.find((x) => x.exact) ?? named[0];
    if (hit) {
      profile = hit.id;
      fromLook = hit.n === lookName;
      if (!hit.exact) warnings.push(`Profile "${hit.n}" approximated by ${profileInfo(hit.id).label}`);
      else if (lookName && !fromLook) warnings.push(`Profile "${lookName}" not supported; using ${profileInfo(hit.id).label}`);
    } else if (v.Treatment === 'Color') {
      profile = 'color';
    }
  }
  if (profile) apply(crs.extra.Profile ? 'Profile' : v.Treatment !== undefined ? 'Treatment' : 'CameraProfile', 'profile', profile, profile);
  if (profile && profileInfo(profile).amount) {
    // Our own value, else the Look's Amount (Lightroom writes a fraction, 1 = 100 %).
    const own = crs.extra.ProfileAmount !== undefined ? parseNumber(crs.extra.ProfileAmount) : NaN;
    const look = fromLook && v['Look.Amount'] !== undefined ? parseNumber(v['Look.Amount']) * 100 : NaN;
    const amount = Number.isFinite(own) ? own : look;
    if (Number.isFinite(amount)) apply(Number.isFinite(own) ? 'ProfileAmount' : 'Look.Amount', 'profileAmount', clampParam(PARAMS.profileAmount, Math.round(amount)), String(amount));
  }

  // Crop
  if (v.HasCrop === 'True') {
    const lr = {
      left: parseNumber(v.CropLeft ?? '0'),
      top: parseNumber(v.CropTop ?? '0'),
      right: parseNumber(v.CropRight ?? '1'),
      bottom: parseNumber(v.CropBottom ?? '1'),
      angle: parseNumber(v.CropAngle ?? '0'),
    };
    const turns = crs.orientation !== null ? turnsFromExifOrientation(crs.orientation) : null;
    if (![lr.left, lr.top, lr.right, lr.bottom, lr.angle].every(Number.isFinite)) {
      warnings.push('Crop values are not numbers; crop skipped');
    } else if (!ctx) {
      warnings.push('Crop needs the photo size; crop skipped');
    } else if (crs.orientation !== null && turns === null) {
      warnings.push('Mirrored orientation is not supported; crop skipped');
    } else {
      const c = lrCropToCrop(lr, ctx, turns ?? undefined);
      const clamp01 = (x: number, lo = 0) => Math.min(1, Math.max(lo, x));
      apply(
        'HasCrop',
        'crop',
        {
          cx: clamp01(c.cx),
          cy: clamp01(c.cy),
          w: clamp01(c.w, 0.01),
          h: clamp01(c.h, 0.01),
          angle: clampParam(PARAMS.angle, c.angle),
          rotate90: c.rotate90,
          aspect: 'free',
          portrait: false,
        },
        `${v.CropLeft}, ${v.CropTop}, ${v.CropRight}, ${v.CropBottom} @ ${v.CropAngle ?? '0'}°`,
      );
    }
  }

  // Masks: when the XMP has any we can import, they replace ours.
  const maskImport = importMasks(crs, ctx);
  if (maskImport?.masks.length) {
    setPath(patch, 'masks', maskImport.masks);
    for (const [key, n] of Object.entries(maskImport.imported)) {
      applied.push({ key, value: `${n} mask${n === 1 ? '' : 's'}`, path: 'masks' });
      used.add(key);
    }
  }
  if (maskImport) warnings.push(...maskImport.warnings);

  // Report what wasn't applied.
  const pv = parseNumber(v.ProcessVersion);
  const has2012 = Object.keys(v).some((k) => k.endsWith('2012'));
  if ((Number.isFinite(pv) && pv < 6.7) || (!has2012 && Object.keys(v).some((k) => LEGACY.has(k) && isActive(k, v[k]!)))) {
    warnings.push('Settings from an old Lightroom process version (before 2012) are not supported');
  }

  const unmapped: string[] = [...(maskImport?.unmapped ?? [])];
  const categoryCounts = new Map<string, number>();
  let retouchCount = 0;
  let unreadable = 0;
  for (const [key, value] of Object.entries(v)) {
    if (used.has(key) || SILENT.has(key) || LEGACY.has(key) || key.startsWith('Look.') || !isActive(key, value)) continue;
    unmapped.push(key);
    const cat = CATEGORIES.find((c) => c.test(key));
    if (cat) categoryCounts.set(cat.label, (categoryCounts.get(cat.label) ?? 0) + 1);
  }
  for (const [key, items] of Object.entries(crs.lists)) {
    if (used.has(key) || key.includes('.') || LEGACY.has(key) || Object.values(CURVE_KEYS).includes(key) || items.length === 0) continue;
    unmapped.push(key);
    if (RETOUCH_KEYS.test(key)) retouchCount += items.length;
    else if (MASK_KEYS.has(key) && !crs.structs[key]) unreadable += items.length;
  }
  if (unreadable) warnings.push(`${unreadable} local adjustment${unreadable === 1 ? '' : 's'} skipped (not readable)`);
  if (retouchCount) warnings.push(`${retouchCount} spot removal / red eye entr${retouchCount === 1 ? 'y' : 'ies'} skipped (not supported yet)`);
  for (const [label, n] of categoryCounts) warnings.push(`${label}: ${n} setting${n === 1 ? '' : 's'} skipped (not supported yet)`);

  return { patch, groups: patchGroups(patch), applied, unmapped: unmapped.sort(), warnings };
}
