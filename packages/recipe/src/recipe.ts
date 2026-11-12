// The edit recipe: everything needed to re-render a RAW. Stored on the RAW asset in
// Immich under RECIPE_KEY; the rendered JPEG carries RENDER_KEY pointing back to it.
import { sha256 } from '@noble/hashes/sha2.js';
import { normalizeMasks, type Mask } from './masks.ts';
import { ALL_PARAMS, PARAMS, clampParam, getPath, setPath, type Band, type Wheel } from './params.ts';
import { isProfileId, type ProfileId } from './profiles.ts';

export const RECIPE_SCHEMA = 1;
export const RECIPE_KEY = 'raw-editor.recipe';
export const RENDER_KEY = 'raw-editor.render';
export const HISTORY_KEY = 'raw-editor.history';

/** Crop aspect presets. 'original' = the photo's own aspect; 'free' = unconstrained. */
export const ASPECTS = ['original', 'free', '1:1', '4:5', '5:7', '2:3', '3:4', '9:16'] as const;
export type AspectId = (typeof ASPECTS)[number];

export interface WhiteBalance {
  /** asShot = camera multipliers; custom = temp/tint below. */
  mode: 'asShot' | 'custom';
  /** Kelvin. Kept in sync with the as-shot value so switching to custom starts there. */
  temp: number;
  tint: number;
}

export interface BasicParams {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  texture: number;
  clarity: number;
  dehaze: number;
  vibrance: number;
  saturation: number;
}

/** Point on a tone curve, in Lightroom's 0..255 units (input, output). */
export type CurvePoint = [number, number];
export type CurveChannel = 'master' | 'red' | 'green' | 'blue';
export const CURVE_CHANNELS: CurveChannel[] = ['master', 'red', 'green', 'blue'];

export interface ToneCurveParams {
  parametric: {
    highlights: number;
    lights: number;
    darks: number;
    shadows: number;
    shadowSplit: number;
    midtoneSplit: number;
    highlightSplit: number;
  };
  point: Record<CurveChannel, CurvePoint[]>;
}

export const LINEAR_CURVE: CurvePoint[] = [
  [0, 0],
  [255, 255],
];

/** Color Mixer (HSL): per hue band, -100..100. */
export interface ColorMixerParams {
  hue: Record<Band, number>;
  saturation: Record<Band, number>;
  luminance: Record<Band, number>;
}

/** B&W mix (monochrome profile): brightness of each hue band, -100..100. */
export type BwMixParams = Record<Band, number>;

export interface GradingWheel {
  /** 0..359, Lightroom's hue angle (0 red, 120 green, 240 blue). */
  hue: number;
  /** 0..100 */
  sat: number;
  /** -100..100 */
  lum: number;
}

export type ColorGradingParams = Record<Wheel, GradingWheel> & {
  /** How far the shadow and highlight ranges overlap, 0..100 (Lightroom default 50). */
  blending: number;
  /** Moves the shadows/highlights split, -100..100. */
  balance: number;
};

export interface CalibrationParams {
  shadowTint: number;
  redHue: number;
  redSaturation: number;
  greenHue: number;
  greenSaturation: number;
  blueHue: number;
  blueSaturation: number;
}

/** Lightroom's Lens Corrections panel. */
export interface LensParams {
  /** Apply the lens profile (Lensfun, or the correction a DNG carries). */
  profile: boolean;
  /** Lensfun lens chosen by hand; '' = found automatically from the photo's EXIF. */
  lensId: string;
  /** Profile strength, 0..200 % (Lightroom's Distortion / Vignetting amounts). */
  profileDistortion: number;
  profileVignetting: number;
  /** Measure and remove lateral chromatic aberration from the photo itself. */
  removeCA: boolean;
  /** Manual: -100 (barrel) .. 100 (pincushion) correction. */
  distortion: number;
  /** Manual vignetting: -100 darkens .. 100 lightens the corners; midpoint 0..100. */
  vignetting: number;
  vignetteMidpoint: number;
  /** Defringe: amount 0..20 and hue range (degrees) for purple and green fringes. */
  defringePurple: number;
  defringePurpleLo: number;
  defringePurpleHi: number;
  defringeGreen: number;
  defringeGreenLo: number;
  defringeGreenHi: number;
}

/** Lightroom's Transform panel (manual perspective). */
export interface TransformParams {
  /** -100..100: keystone around the horizontal axis (negative widens the top). */
  vertical: number;
  /** -100..100: keystone around the vertical axis (negative widens the left side). */
  horizontal: number;
  /** Degrees, -10..10, clockwise. */
  rotate: number;
  /** -100..100: negative stretches horizontally, positive vertically. */
  aspect: number;
  /** 50..150 % */
  scale: number;
  /** -100..100: moves the image (percent of half its width/height). */
  offsetX: number;
  offsetY: number;
  /** Keep the crop inside the transformed image (no blank areas). */
  constrain: boolean;
}

export interface DetailParams {
  sharpenAmount: number;
  sharpenRadius: number;
  sharpenDetail: number;
  sharpenMasking: number;
  /** Noise reduction, all 0..100: luminance strength, detail kept, contrast kept. */
  nrLuminance: number;
  nrLuminanceDetail: number;
  nrLuminanceContrast: number;
  /** Color noise reduction strength, colour edges kept, low-frequency mottling removed. */
  nrColor: number;
  nrColorDetail: number;
  nrColorSmoothness: number;
}

/** Lightroom's post-crop vignette styles (crs:PostCropVignetteStyle 1, 2, 3). */
export type VignetteStyle = 'highlight' | 'color' | 'paint';
export const VIGNETTE_STYLES: { id: VignetteStyle; label: string }[] = [
  { id: 'highlight', label: 'Highlight Priority' },
  { id: 'color', label: 'Color Priority' },
  { id: 'paint', label: 'Paint Overlay' },
];

/** Lightroom's Effects panel: post-crop vignetting and grain. */
export interface EffectsParams {
  vignetteStyle: VignetteStyle;
  /** -100 darkens .. 100 lightens the corners of the crop. */
  vignetteAmount: number;
  vignetteMidpoint: number;
  /** -100 rounded rectangle .. 0 ellipse of the crop's aspect .. 100 circle. */
  vignetteRoundness: number;
  vignetteFeather: number;
  /** Highlight recovery inside a darkening vignette (priority styles only). */
  vignetteHighlights: number;
  grainAmount: number;
  /** Grain size and roughness, relative to the full-resolution image. */
  grainSize: number;
  grainRoughness: number;
}

/**
 * Crop in the frame of the upright image (camera orientation + rotate90 applied).
 * cx/cy/w/h are fractions of that image's width/height; the rectangle is axis-aligned
 * on screen, and the image is rotated by -angle underneath it (Lightroom's straighten).
 */
export interface CropParams {
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
  /** Extra clockwise quarter turns on top of the camera orientation. */
  rotate90: 0 | 1 | 2 | 3;
  aspect: AspectId;
  /** When the aspect is not 'free' or 'original': true = portrait (swapped). */
  portrait: boolean;
}

export interface RenderRef {
  assetId: string;
  recipeHash: string;
  checksum: string;
  renderedAt: string;
}

export interface PendingSave {
  recipeHash: string;
  checksum?: string;
  startedAt: string;
}

export interface Recipe {
  schema: typeof RECIPE_SCHEMA;
  app: string;
  decoder?: { name: string; version: string; demosaic: string };
  profile: ProfileId;
  /** Profile Amount in % (0..200): how strongly a look-based profile applies. */
  profileAmount: number;
  wb: WhiteBalance;
  basic: BasicParams;
  toneCurve: ToneCurveParams;
  colorMixer: ColorMixerParams;
  bwMix: BwMixParams;
  colorGrading: ColorGradingParams;
  detail: DetailParams;
  effects: EffectsParams;
  calibration: CalibrationParams;
  lens: LensParams;
  transform: TransformParams;
  crop: CropParams;
  masks: Mask[];
  render?: RenderRef;
  pending?: PendingSave;
}

export const APP_ID = 'immich-raw@0.1.0';

export function defaultRecipe(): Recipe {
  const r = {
    schema: RECIPE_SCHEMA,
    app: APP_ID,
    profile: 'color',
    wb: { mode: 'asShot', temp: PARAMS.temp.default, tint: PARAMS.tint.default },
    basic: {},
    toneCurve: {
      parametric: {},
      point: { master: [...LINEAR_CURVE], red: [...LINEAR_CURVE], green: [...LINEAR_CURVE], blue: [...LINEAR_CURVE] },
    },
    detail: {},
    effects: { vignetteStyle: 'highlight' },
    lens: { profile: true, lensId: '', removeCA: true },
    transform: { constrain: false },
    crop: { cx: 0.5, cy: 0.5, w: 1, h: 1, angle: 0, rotate90: 0, aspect: 'original', portrait: false },
    masks: [],
  } as unknown as Recipe;
  for (const spec of ALL_PARAMS) {
    if (getPath(r, spec.path) === undefined) setPath(r, spec.path, spec.default);
  }
  return r;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Turns anything (stored JSON, an older schema, a hand-edited value) into a valid Recipe:
 * unknown fields are dropped, missing ones get defaults, numbers are clamped.
 */
export function normalizeRecipe(input: unknown): Recipe {
  const src = isObject(input) ? migrate(input) : {};
  const r = defaultRecipe();

  for (const spec of ALL_PARAMS) {
    const v = getPath(src, spec.path);
    if (typeof v === 'number') setPath(r, spec.path, clampParam(spec, v));
  }

  if (isProfileId(src.profile)) r.profile = src.profile;
  const wb = isObject(src.wb) ? src.wb : {};
  if (wb.mode === 'custom' || wb.mode === 'asShot') r.wb.mode = wb.mode;

  const lens = isObject(src.lens) ? src.lens : {};
  if (isObject(src.lens)) {
    r.lens.profile = lens.profile === true;
    r.lens.removeCA = lens.removeCA === true;
  } else if (typeof src.schema === 'number') {
    // Saved before lens corrections existed: keep rendering it the way it was saved.
    r.lens.profile = false;
    r.lens.removeCA = false;
  }
  r.lens.lensId = typeof lens.lensId === 'string' ? lens.lensId.slice(0, 200) : '';

  const effects = isObject(src.effects) ? src.effects : {};
  if (VIGNETTE_STYLES.some((s) => s.id === effects.vignetteStyle)) r.effects.vignetteStyle = effects.vignetteStyle as VignetteStyle;

  r.transform.constrain = isObject(src.transform) && src.transform.constrain === true;
  r.masks = normalizeMasks(src.masks);

  const crop = isObject(src.crop) ? src.crop : {};
  const frac = (v: unknown, def: number, min = 0, max = 1) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
  r.crop.w = frac(crop.w, 1, 0.01);
  r.crop.h = frac(crop.h, 1, 0.01);
  r.crop.cx = frac(crop.cx, 0.5);
  r.crop.cy = frac(crop.cy, 0.5);
  if (crop.rotate90 === 1 || crop.rotate90 === 2 || crop.rotate90 === 3) r.crop.rotate90 = crop.rotate90;
  if (typeof crop.aspect === 'string' && (ASPECTS as readonly string[]).includes(crop.aspect)) r.crop.aspect = crop.aspect as AspectId;
  r.crop.portrait = crop.portrait === true;

  const point = isObject(src.toneCurve) && isObject(src.toneCurve.point) ? src.toneCurve.point : {};
  for (const ch of CURVE_CHANNELS) r.toneCurve.point[ch] = normalizeCurve(point[ch]);

  if (isObject(src.decoder)) {
    const d = src.decoder;
    r.decoder = { name: String(d.name ?? ''), version: String(d.version ?? ''), demosaic: String(d.demosaic ?? '') };
  }
  if (isObject(src.render) && typeof src.render.assetId === 'string') {
    r.render = {
      assetId: src.render.assetId,
      recipeHash: String(src.render.recipeHash ?? ''),
      checksum: String(src.render.checksum ?? ''),
      renderedAt: String(src.render.renderedAt ?? ''),
    };
  }
  if (isObject(src.pending) && typeof src.pending.recipeHash === 'string') {
    r.pending = {
      recipeHash: src.pending.recipeHash,
      checksum: typeof src.pending.checksum === 'string' ? src.pending.checksum : undefined,
      startedAt: String(src.pending.startedAt ?? ''),
    };
  }
  return r;
}

/**
 * Valid point curve: numbers clamped to 0..255, sorted by input, inputs unique,
 * at least two points. Anything unusable becomes the linear curve.
 */
export function normalizeCurve(input: unknown): CurvePoint[] {
  if (!Array.isArray(input)) return LINEAR_CURVE.map((p) => [...p] as CurvePoint);
  const pts: CurvePoint[] = [];
  for (const item of input) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const [x, y] = item.map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push([Math.min(255, Math.max(0, x!)), Math.min(255, Math.max(0, y!))]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  const unique = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1]![0]);
  return unique.length >= 2 ? unique : LINEAR_CURVE.map((p) => [...p] as CurvePoint);
}

export function isLinearCurve(points: CurvePoint[]): boolean {
  return points.every(([x, y]) => x === y) && points.length >= 2;
}

/** Upgrades older stored schemas in place. Only schema 1 exists so far. */
function migrate(src: Record<string, unknown>): Record<string, unknown> {
  return src;
}

/** The parts of the recipe that change the rendered pixels. */
export function renderRelevant(r: Recipe): Omit<Recipe, 'render' | 'pending' | 'app'> {
  const { render: _render, pending: _pending, app: _app, ...rest } = r;
  return rest;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 (hex) of the render-relevant recipe; equal hashes mean identical renders. */
export async function recipeHash(r: Recipe): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(renderRelevant(r)));
  // WebCrypto exists only on secure pages (HTTPS, localhost); on plain HTTP the JS SHA-256
  // gives the same hash.
  const digest = globalThis.crypto?.subtle ? new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)) : sha256(bytes);
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function cloneRecipe(r: Recipe): Recipe {
  return structuredClone(r);
}

/** True when the recipe renders the same as a fresh default (ignoring as-shot temp/tint). */
export function isDefaultRecipe(r: Recipe): boolean {
  const a = renderRelevant(r);
  const b = renderRelevant(defaultRecipe());
  if (a.wb.mode === 'asShot') {
    a.wb = b.wb;
  }
  delete (a as { decoder?: unknown }).decoder;
  return canonicalJson(a) === canonicalJson(b);
}
