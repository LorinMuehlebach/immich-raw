// Every adjustable number in the recipe, with Lightroom's ranges and defaults.
// The UI builds sliders from this table and normalize() clamps against it.

export interface ParamSpec {
  /** Dotted path into the recipe, e.g. "basic.exposure". */
  path: string;
  label: string;
  min: number;
  max: number;
  default: number;
  /** Slider step; Shift+arrow moves 10 steps. */
  step: number;
  /** Decimal places shown next to the slider. */
  decimals: number;
  /** Show a leading "+" for positive values (Lightroom does for most sliders). */
  signed?: boolean;
}

const p = (
  path: string,
  label: string,
  min: number,
  max: number,
  def: number,
  step = 1,
  decimals = 0,
  signed = true,
): ParamSpec => ({ path, label, min, max, default: def, step, decimals, signed });

export const PARAMS = {
  // Basic › White balance (temp/tint are only used in custom mode; see wb.mode)
  temp: p('wb.temp', 'Temp', 2000, 50000, 5500, 50, 0, false),
  tint: p('wb.tint', 'Tint', -150, 150, 0, 1),
  // Basic › Tone
  exposure: p('basic.exposure', 'Exposure', -5, 5, 0, 0.01, 2),
  contrast: p('basic.contrast', 'Contrast', -100, 100, 0),
  highlights: p('basic.highlights', 'Highlights', -100, 100, 0),
  shadows: p('basic.shadows', 'Shadows', -100, 100, 0),
  whites: p('basic.whites', 'Whites', -100, 100, 0),
  blacks: p('basic.blacks', 'Blacks', -100, 100, 0),
  // Basic › Presence (texture/clarity/dehaze arrive in M2)
  texture: p('basic.texture', 'Texture', -100, 100, 0),
  clarity: p('basic.clarity', 'Clarity', -100, 100, 0),
  dehaze: p('basic.dehaze', 'Dehaze', -100, 100, 0),
  vibrance: p('basic.vibrance', 'Vibrance', -100, 100, 0),
  saturation: p('basic.saturation', 'Saturation', -100, 100, 0),
  // Detail › Sharpening (Lightroom defaults 40 / 1.0 / 25 / 0)
  sharpenAmount: p('detail.sharpenAmount', 'Amount', 0, 150, 40, 1, 0, false),
  sharpenRadius: p('detail.sharpenRadius', 'Radius', 0.5, 3, 1, 0.1, 1, false),
  sharpenDetail: p('detail.sharpenDetail', 'Detail', 0, 100, 25, 1, 0, false),
  sharpenMasking: p('detail.sharpenMasking', 'Masking', 0, 100, 0, 1, 0, false),
  // Detail › Noise reduction (Lightroom defaults: luminance 0 / 50 / 0, color 25 / 50 / 50)
  nrLuminance: p('detail.nrLuminance', 'Luminance', 0, 100, 0, 1, 0, false),
  nrLuminanceDetail: p('detail.nrLuminanceDetail', 'Detail', 0, 100, 50, 1, 0, false),
  nrLuminanceContrast: p('detail.nrLuminanceContrast', 'Contrast', 0, 100, 0, 1, 0, false),
  nrColor: p('detail.nrColor', 'Color', 0, 100, 25, 1, 0, false),
  nrColorDetail: p('detail.nrColorDetail', 'Detail', 0, 100, 50, 1, 0, false),
  nrColorSmoothness: p('detail.nrColorSmoothness', 'Smoothness', 0, 100, 50, 1, 0, false),
  // Tone Curve › parametric regions and split points (Lightroom: splits 25 / 50 / 75)
  curveHighlights: p('toneCurve.parametric.highlights', 'Highlights', -100, 100, 0),
  curveLights: p('toneCurve.parametric.lights', 'Lights', -100, 100, 0),
  curveDarks: p('toneCurve.parametric.darks', 'Darks', -100, 100, 0),
  curveShadows: p('toneCurve.parametric.shadows', 'Shadows', -100, 100, 0),
  curveShadowSplit: p('toneCurve.parametric.shadowSplit', 'Shadow split', 10, 50, 25, 1, 0, false),
  curveMidtoneSplit: p('toneCurve.parametric.midtoneSplit', 'Midtone split', 30, 70, 50, 1, 0, false),
  curveHighlightSplit: p('toneCurve.parametric.highlightSplit', 'Highlight split', 50, 90, 75, 1, 0, false),
  // Crop › straighten angle in degrees
  angle: p('crop.angle', 'Angle', -45, 45, 0, 0.05, 2),
} as const satisfies Record<string, ParamSpec>;

export type ParamId = keyof typeof PARAMS;

// Color Mixer (Lightroom's HSL) and B&W mix: eight hue bands.
export const BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
export type Band = (typeof BANDS)[number];
export const BAND_LABELS: Record<Band, string> = {
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  aqua: 'Aqua',
  blue: 'Blue',
  purple: 'Purple',
  magenta: 'Magenta',
};

export type MixerChannel = 'hue' | 'saturation' | 'luminance';
export const MIXER_CHANNELS: MixerChannel[] = ['hue', 'saturation', 'luminance'];

const bandTable = (prefix: string) =>
  Object.fromEntries(BANDS.map((b) => [b, p(`${prefix}.${b}`, BAND_LABELS[b], -100, 100, 0)])) as Record<Band, ParamSpec>;

export const MIXER_PARAMS: Record<MixerChannel, Record<Band, ParamSpec>> = {
  hue: bandTable('colorMixer.hue'),
  saturation: bandTable('colorMixer.saturation'),
  luminance: bandTable('colorMixer.luminance'),
};

/** B&W mix: how bright each hue band turns out in the monochrome conversion. */
export const BW_PARAMS: Record<Band, ParamSpec> = bandTable('bwMix');

// Color Grading: three tonal wheels plus a global one.
export const WHEELS = ['shadows', 'midtones', 'highlights', 'global'] as const;
export type Wheel = (typeof WHEELS)[number];
export const WHEEL_LABELS: Record<Wheel, string> = { shadows: 'Shadows', midtones: 'Midtones', highlights: 'Highlights', global: 'Global' };

export const GRADING_PARAMS: Record<Wheel, { hue: ParamSpec; sat: ParamSpec; lum: ParamSpec }> = Object.fromEntries(
  WHEELS.map((w) => [
    w,
    {
      hue: p(`colorGrading.${w}.hue`, 'Hue', 0, 359, 0, 1, 0, false),
      sat: p(`colorGrading.${w}.sat`, 'Saturation', 0, 100, 0, 1, 0, false),
      lum: p(`colorGrading.${w}.lum`, 'Luminance', -100, 100, 0),
    },
  ]),
) as Record<Wheel, { hue: ParamSpec; sat: ParamSpec; lum: ParamSpec }>;

export const GRADING_BLENDING = p('colorGrading.blending', 'Blending', 0, 100, 50, 1, 0, false);
export const GRADING_BALANCE = p('colorGrading.balance', 'Balance', -100, 100, 0);

// Calibration: shadow tint and the hue/saturation of the red, green and blue primaries.
export const CALIBRATION_PARAMS = {
  shadowTint: p('calibration.shadowTint', 'Tint', -100, 100, 0),
  redHue: p('calibration.redHue', 'Hue', -100, 100, 0),
  redSaturation: p('calibration.redSaturation', 'Saturation', -100, 100, 0),
  greenHue: p('calibration.greenHue', 'Hue', -100, 100, 0),
  greenSaturation: p('calibration.greenSaturation', 'Saturation', -100, 100, 0),
  blueHue: p('calibration.blueHue', 'Hue', -100, 100, 0),
  blueSaturation: p('calibration.blueSaturation', 'Saturation', -100, 100, 0),
} as const satisfies Record<string, ParamSpec>;

// Lens Corrections (Lightroom ranges: profile amounts 0..200, defringe amounts 0..20).
export const LENS_PARAMS = {
  profileDistortion: p('lens.profileDistortion', 'Distortion', 0, 200, 100, 1, 0, false),
  profileVignetting: p('lens.profileVignetting', 'Vignetting', 0, 200, 100, 1, 0, false),
  distortion: p('lens.distortion', 'Distortion', -100, 100, 0),
  vignetting: p('lens.vignetting', 'Amount', -100, 100, 0),
  vignetteMidpoint: p('lens.vignetteMidpoint', 'Midpoint', 0, 100, 50, 1, 0, false),
  defringePurple: p('lens.defringePurple', 'Purple Amount', 0, 20, 0, 1, 0, false),
  defringePurpleLo: p('lens.defringePurpleLo', 'Purple Hue from', 0, 100, 30, 1, 0, false),
  defringePurpleHi: p('lens.defringePurpleHi', 'Purple Hue to', 0, 100, 70, 1, 0, false),
  defringeGreen: p('lens.defringeGreen', 'Green Amount', 0, 20, 0, 1, 0, false),
  defringeGreenLo: p('lens.defringeGreenLo', 'Green Hue from', 0, 100, 40, 1, 0, false),
  defringeGreenHi: p('lens.defringeGreenHi', 'Green Hue to', 0, 100, 60, 1, 0, false),
} as const satisfies Record<string, ParamSpec>;

// Transform (Lightroom's manual sliders; Upright is not supported).
export const TRANSFORM_PARAMS = {
  vertical: p('transform.vertical', 'Vertical', -100, 100, 0),
  horizontal: p('transform.horizontal', 'Horizontal', -100, 100, 0),
  rotate: p('transform.rotate', 'Rotate', -10, 10, 0, 0.1, 1),
  aspect: p('transform.aspect', 'Aspect', -100, 100, 0),
  scale: p('transform.scale', 'Scale', 50, 150, 100, 1, 0, false),
  offsetX: p('transform.offsetX', 'X Offset', -100, 100, 0, 0.1, 1),
  offsetY: p('transform.offsetY', 'Y Offset', -100, 100, 0, 0.1, 1),
} as const satisfies Record<string, ParamSpec>;

// Effects: Post-Crop Vignetting and Grain (Lightroom ranges and defaults).
export const EFFECTS_PARAMS = {
  vignetteAmount: p('effects.vignetteAmount', 'Amount', -100, 100, 0),
  vignetteMidpoint: p('effects.vignetteMidpoint', 'Midpoint', 0, 100, 50, 1, 0, false),
  vignetteRoundness: p('effects.vignetteRoundness', 'Roundness', -100, 100, 0),
  vignetteFeather: p('effects.vignetteFeather', 'Feather', 0, 100, 50, 1, 0, false),
  vignetteHighlights: p('effects.vignetteHighlights', 'Highlights', 0, 100, 0, 1, 0, false),
  grainAmount: p('effects.grainAmount', 'Amount', 0, 100, 0, 1, 0, false),
  grainSize: p('effects.grainSize', 'Size', 0, 100, 25, 1, 0, false),
  grainRoughness: p('effects.grainRoughness', 'Roughness', 0, 100, 50, 1, 0, false),
} as const satisfies Record<string, ParamSpec>;

/** Every numeric parameter: used for defaults and clamping. */
export const ALL_PARAMS: ParamSpec[] = [
  ...Object.values(PARAMS),
  ...MIXER_CHANNELS.flatMap((c) => Object.values(MIXER_PARAMS[c])),
  ...Object.values(BW_PARAMS),
  ...WHEELS.flatMap((w) => Object.values(GRADING_PARAMS[w])),
  GRADING_BLENDING,
  GRADING_BALANCE,
  ...Object.values(CALIBRATION_PARAMS),
  ...Object.values(LENS_PARAMS),
  ...Object.values(TRANSFORM_PARAMS),
  ...Object.values(EFFECTS_PARAMS),
];

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function setPath<T extends object>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  let cur = obj as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    if (cur[key] === null || typeof cur[key] !== 'object') cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
  return obj;
}

export function clampParam(spec: ParamSpec, value: number): number {
  if (!Number.isFinite(value)) return spec.default;
  return Math.min(spec.max, Math.max(spec.min, value));
}

export function formatParam(spec: ParamSpec, value: number): string {
  const text = value.toFixed(spec.decimals);
  return spec.signed && value > 0 ? `+${text}` : text;
}
