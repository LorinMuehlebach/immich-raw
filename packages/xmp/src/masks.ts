// Lightroom local corrections -> our masks.
//
// Two formats:
// - crs:MaskGroupBasedCorrections (Lightroom Classic 11+ / Camera Raw 14+): one entry per
//   mask with its sliders and crs:CorrectionMasks, the components in order. Each component
//   has a MaskBlendMode (0 add, 1 subtract), MaskInverted and MaskValue. Lightroom writes
//   Subtract as MaskBlendMode 1 + MaskValue 0, and Intersect as a subtracted inverted
//   component. A brush is a Mask/Aggregate whose crs:Masks are the Mask/Paint strokes.
// - Process version 2012 (Lightroom 4-10): GradientBasedCorrections,
//   CircularGradientBasedCorrections and PaintBasedCorrections. One shape per correction,
//   optionally refined with brush strokes (MaskValue 0 erases) and a correction-wide
//   CorrectionRangeMask.
//
// Coordinates: like the crop (crop.ts), every position is normalised to the uncropped
// image in SENSOR orientation, x by width and y by height. Our mask frame is the same
// image scaled so its longer side is 1, so a position only needs the sensor aspect, and
// Lightroom's own rotation of the photo (tiff:Orientation) doesn't matter. A brush radius
// is a fraction of the longer side, as our brush size is.
import {
  BRUSH_FEATHER,
  LOCAL_PARAMS,
  MAX_AI,
  MAX_BRUSHES,
  MAX_BRUSH_POINTS,
  MAX_COLOR_SAMPLES,
  MAX_COMPONENTS,
  MAX_MASKS,
  PERSON_PART_LABELS,
  clampParam,
  defaultAdjustments,
  newAiComponent,
  normalizeMasks,
  shortId,
  type AiComponent,
  type AiTarget,
  type BrushComponent,
  type LandscapeClass,
  type PersonPart,
  type BrushStroke,
  type ColorSample,
  type LocalAdjustments,
  type LocalKey,
  type Mask,
  type MaskComponent,
  type MaskMode,
} from '@immich-raw/recipe';
import { turnsFromFlip, type CropContext } from './crop.ts';
import type { CrsSettings, XmpStruct, XmpValue } from './parse.ts';

export const MASK_CONTAINERS = ['MaskGroupBasedCorrections', 'GradientBasedCorrections', 'CircularGradientBasedCorrections', 'PaintBasedCorrections'] as const;
export type MaskContainer = (typeof MASK_CONTAINERS)[number];

/**
 * crs:Local* slider -> [our slider, factor]. Lightroom stores the ±100 sliders divided by
 * 100, Exposure divided by 4 (±4 EV) and Hue divided by 180 (±180°); the colour swatch hue
 * is in degrees.
 */
export const LOCAL_ROWS: Record<string, [LocalKey, number]> = {
  LocalTemperature: ['temp', 100],
  LocalTint: ['tint', 100],
  LocalExposure2012: ['exposure', 4],
  LocalContrast2012: ['contrast', 100],
  LocalHighlights2012: ['highlights', 100],
  LocalShadows2012: ['shadows', 100],
  LocalWhites2012: ['whites', 100],
  LocalBlacks2012: ['blacks', 100],
  LocalTexture: ['texture', 100],
  LocalClarity2012: ['clarity', 100],
  LocalDehaze: ['dehaze', 100],
  LocalHue: ['hue', 180],
  LocalSaturation: ['saturation', 100],
  LocalSharpness: ['sharpness', 100],
  LocalToningHue: ['colorHue', 1],
  LocalToningSaturation: ['colorSat', 100],
};

/** Process version 2010 sliders; Lightroom writes them next to the 2012 ones, which win. */
const LEGACY_LOCALS = new Set(['LocalExposure', 'LocalBrightness', 'LocalContrast', 'LocalClarity']);
/** Unsupported local sliders whose untouched value isn't 0. */
const LOCAL_NEUTRAL: Record<string, number> = { LocalCurveRefineSaturation: 100 };
/** A mask's own point curves (Lightroom 13+). */
const LOCAL_CURVES = new Set(['MainCurve', 'RedCurve', 'GreenCurve', 'BlueCurve']);

/**
 * Brush CenterWeight -> Lightroom's Feather slider. Lightroom Classic 15 wrote 0.035858,
 * 0.16214 and 0.501304 for Feather 80, 50 and 20; the ends (0 = fully soft, 1 = hard)
 * are assumed. In between we interpolate linearly.
 */
export const BRUSH_FEATHER_BY_CENTER_WEIGHT: [number, number][] = [
  [0, 100],
  [0.035858, 80],
  [0.16214, 50],
  [0.501304, 20],
  [1, 0],
];

/**
 * Lightroom's AI selections (crs:What "Mask/Image"). Lightroom stores what was selected, not
 * the pixels, and so do we: the editor finds it again in the photo. The codes, as Lightroom
 * writes them:
 * - MaskSubType 1: Subject; 2: Sky.
 * - MaskSubType 3 + MaskSubCategoryID: a part of everyone (PERSON_PART_IDS).
 * - MaskSubType 0 + MaskSubCategoryID 50001-50008: a Landscape category (LANDSCAPE_IDS);
 *   + 2-13 (with InstanceIDs): a part of one person; without a category: Background.
 */
const PERSON_PART_IDS: Record<number, PersonPart> = {
  2: 'faceSkin',
  3: 'iris',
  4: 'bodySkin',
  5: 'hair',
  6: 'lips',
  7: 'facialHair',
  8: 'eyeSclera',
  9: 'eyebrows',
  11: 'clothes',
  12: 'teeth',
  13: 'person',
};
const LANDSCAPE_IDS: Record<number, LandscapeClass> = {
  50001: 'architecture',
  50002: 'mountains',
  50003: 'artificialGround',
  50004: 'naturalGround',
  50005: 'vegetation',
  50006: 'sky',
  50007: 'water',
  50008: 'snow',
};
/** When the codes are missing: the mask's name (English Lightroom names). */
const AI_NAMES: [RegExp, AiTarget][] = [
  [/\bsubject\b/i, 'subject'],
  [/\bsky\b/i, 'sky'],
  [/\bbackground\b/i, 'background'],
  [/\b(people|person)\b/i, 'people'],
];

function aiFromImage(e: XmpStruct, notes: string[]): Built {
  const sub = num(e, 'MaskSubType');
  const cat = num(e, 'MaskSubCategoryID');
  const name = text(e.MaskName) ?? '';
  if (/\bobject/i.test(name)) return { skip: 'Select Objects (AI)' };
  if (sub === 1) return { comp: newAiComponent('subject') };
  if (sub === 2) return { comp: newAiComponent('sky') };
  if (sub === 3) {
    const part = Number.isNaN(cat) ? 'person' : PERSON_PART_IDS[cat];
    return part ? { comp: newAiComponent('people', 'add', { parts: [part] }) } : { skip: `People part ${cat} (AI)` };
  }
  if (sub === 0 || Number.isNaN(sub)) {
    const landscape = LANDSCAPE_IDS[cat];
    if (landscape) return { comp: newAiComponent('landscape', 'add', { classes: [landscape] }) };
    const part = PERSON_PART_IDS[cat];
    if (part) {
      // One person's part: Lightroom names people by an id of its own, which means nothing here.
      notes.push(`${PERSON_PART_LABELS[part]} of one person applies to everyone`);
      return { comp: newAiComponent('people', 'add', { parts: [part] }) };
    }
    if (sub === 0 && Number.isNaN(cat)) return { comp: newAiComponent('background') };
  }
  const byName = AI_NAMES.find(([re]) => re.test(name))?.[1];
  if (byName && Number.isNaN(sub)) return { comp: newAiComponent(byName) };
  return { skip: Number.isNaN(cat) ? 'AI selection' : `AI selection ${sub}/${cat}` };
}

/**
 * Lightroom writes each People part and Landscape category as a part of its own; parts
 * added one after the other become one (they add up anyway), so they fit our limits.
 */
function mergeAi(comps: MaskComponent[]): MaskComponent[] {
  const out: MaskComponent[] = [];
  for (const c of comps) {
    const prev = out[out.length - 1];
    const joinable = (x: MaskComponent | undefined): x is AiComponent =>
      x?.kind === 'ai' && (x.target === 'people' || x.target === 'landscape') && !x.invert && !x.person;
    // Adding A then B adds A or B, and subtracting both subtracts A or B; intersections don't join.
    const sameOp = (prev?.mode === 'add' && c.mode === 'add') || (prev?.mode === 'subtract' && c.mode === 'subtract');
    if (joinable(prev) && joinable(c) && prev.target === c.target && sameOp) {
      if (c.target === 'people') prev.parts = [...new Set([...(prev.parts ?? []), ...(c.parts ?? [])])];
      else prev.classes = [...new Set([...(prev.classes ?? []), ...(c.classes ?? [])])];
      continue;
    }
    out.push(c);
  }
  return out;
}

/** A per-dab radius change bigger than this starts a new stroke (pen pressure). */
const RADIUS_STEP = 0.1;

export interface MaskImport {
  masks: Mask[];
  /** Masks taken from each container. */
  imported: Partial<Record<MaskContainer, number>>;
  warnings: string[];
  /** Local sliders we have no counterpart for, as "Container.Field". */
  unmapped: string[];
}

interface Frame {
  sx: number;
  sy: number;
}

/** Sensor-orientation size -> mask frame scale (the longer side is 1). */
function maskFrame(ctx: CropContext): Frame | null {
  const odd = turnsFromFlip(ctx.flip) % 2 === 1;
  const w = odd ? ctx.uprightHeight : ctx.uprightWidth;
  const h = odd ? ctx.uprightWidth : ctx.uprightHeight;
  const m = Math.max(w, h);
  return m > 0 && w > 0 && h > 0 ? { sx: w / m, sy: h / m } : null;
}

const isStruct = (v: XmpValue | undefined): v is XmpStruct => v !== undefined && typeof v === 'object' && !Array.isArray(v);
const items = (v: XmpValue | undefined): XmpValue[] => (Array.isArray(v) ? v : []);
const text = (v: XmpValue | undefined): string | undefined => (typeof v === 'string' ? v.trim() : undefined);
const toNumber = (t: string | undefined): number => (t === undefined || t === '' ? NaN : Number(t.replace(/^\+/, '')));
const num = (s: XmpStruct, key: string, def = NaN): number => {
  const n = toNumber(text(s[key]));
  return Number.isFinite(n) ? n : def;
};
const flag = (s: XmpStruct, key: string): boolean | undefined => {
  const t = text(s[key])?.toLowerCase();
  if (t === 'true' || t === '1') return true;
  if (t === 'false' || t === '0') return false;
  return undefined;
};
const numbers = (t: string | undefined): number[] => (t ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function featherFromCenterWeight(cw: number): number {
  const t = BRUSH_FEATHER_BY_CENTER_WEIGHT;
  const x = clamp(cw, 0, 1);
  for (let i = 1; i < t.length; i++) {
    const [x1, y1] = t[i]!;
    if (x <= x1) {
      const [x0, y0] = t[i - 1]!;
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return 0;
}

/** Why a component wasn't imported. `frame` = it needs the photo size we don't have. */
type Built = { comp: MaskComponent } | { skip: string } | { frame: true };

const base = (kind: MaskComponent['kind']) => ({ id: shortId(), kind, mode: 'add' as MaskMode, invert: false });

/** Mask/Paint -> strokes. Dabs are "d x y" (or "M x y" with Auto Mask); "r", "h" and "f" change radius, CenterWeight and flow for the dabs that follow. */
function strokesFromPaint(p: XmpStruct, frame: Frame, erase: boolean): BrushStroke[] {
  let radius = num(p, 'Radius');
  let cw = num(p, 'CenterWeight');
  let flow = num(p, 'Flow', 1);
  // Whole slider steps, as the brush settings are shown.
  const density = erase ? 100 : Math.round(clamp(num(p, 'MaskValue', 1), 0, 1) * 100);
  const feather = () => (Number.isFinite(cw) ? Math.round(featherFromCenterWeight(cw)) : BRUSH_FEATHER.default);
  const flowPct = () => Math.round(clamp(flow, 0, 1) * 100);
  const strokes: BrushStroke[] = [];
  let cur: BrushStroke | null = null;
  let last: [number, number] | null = null;
  for (const item of items(p.Dabs)) {
    const [cmd, ...rest] = (text(item) ?? '').split(/\s+/);
    const [a, b] = rest.map(Number);
    if ((cmd === 'd' || cmd === 'M') && Number.isFinite(a) && Number.isFinite(b)) {
      if (!(radius > 0)) continue;
      const x = a! * frame.sx;
      const y = b! * frame.sy;
      if (!cur) {
        // A new stroke after a change starts where the last one ended, so the line stays whole.
        cur = { erase, size: radius, feather: feather(), flow: flowPct(), density, points: last ? [...last] : [] };
        strokes.push(cur);
      }
      if (last && last[0] === x && last[1] === y) continue;
      cur.points.push(x, y);
      last = [x, y];
    } else if (cmd === 'r' && a! > 0) {
      radius = a!;
      if (cur && Math.abs(radius - cur.size) > RADIUS_STEP * cur.size) cur = null;
    } else if (cmd === 'h' && Number.isFinite(a)) {
      cw = a!;
      if (cur && feather() !== cur.feather) cur = null;
    } else if (cmd === 'f' && Number.isFinite(a)) {
      flow = a!;
      if (cur && flowPct() !== cur.flow) cur = null;
    }
  }
  return strokes.filter((s) => s.points.length >= 2);
}

/** Erasing strokes paint mask value 0. */
const isErase = (p: XmpStruct) => num(p, 'MaskBlendMode', 0) === 1 || num(p, 'MaskValue', 1) <= 0;

/**
 * Luminance range. Lightroom 11+ stores four handles, LumRange "a b c d": full selection
 * between b and c, fading out to a and d. Ours has one smoothness for both sides, so it is
 * the mean fall-off and lo/hi are placed to keep each side's half-way point.
 */
function luminanceFromRange(r: XmpStruct): Built {
  const q = numbers(text(r.LumRange));
  if (q.length >= 4 && q.slice(0, 4).every(Number.isFinite)) {
    const [a, b, c, d] = q.map((v) => clamp(v, 0, 1)) as [number, number, number, number];
    const openLo = b <= 0.001;
    const openHi = c >= 0.999;
    const falloffs = [...(openLo ? [] : [Math.max(0, b - a)]), ...(openHi ? [] : [Math.max(0, d - c)])];
    const s = clamp(falloffs.length ? falloffs.reduce((x, y) => x + y, 0) / falloffs.length : 0.1, 0.001, 0.5);
    let lo = openLo ? 0 : clamp((a + b) / 2 + s / 2, 0, 1);
    let hi = openHi ? 1 : clamp((c + d) / 2 - s / 2, 0, 1);
    if (lo > hi) lo = hi = (lo + hi) / 2;
    return { comp: { ...base('luminance'), kind: 'luminance', lo: lo * 100, hi: hi * 100, smooth: s * 200 } };
  }
  // Lightroom 7-10: LumMin / LumMax and one Smoothness (LumFeather), all 0..1.
  const lo = num(r, 'LumMin', 0);
  const hi = num(r, 'LumMax', 1);
  return { comp: { ...base('luminance'), kind: 'luminance', lo: clamp(lo, 0, 1) * 100, hi: clamp(hi, 0, 1) * 100, smooth: clamp(num(r, 'LumFeather', 0.5), 0, 1) * 100 } };
}

/**
 * Colour range: sample points (PointModels "c1 c2 c3 x y index") or dragged areas
 * (AreaModels[].ColorRangeMaskAreaSampleInfo "cx cy x1 y1 x2 y2 x3 y3 x4 y4 index"). We keep
 * the positions and read the colours from the photo; an area becomes a disc of the same size.
 */
function colorFromRange(r: XmpStruct, frame: Frame | null, notes: string[]): Built {
  if (!frame) return { frame: true };
  const samples: ColorSample[] = [];
  for (const item of items(r.PointModels)) {
    const v = numbers(text(item));
    if (v.length >= 5 && Number.isFinite(v[3]) && Number.isFinite(v[4])) samples.push({ x: v[3]! * frame.sx, y: v[4]! * frame.sy, r: 0 });
  }
  for (const item of items(r.AreaModels)) {
    if (!isStruct(item)) continue;
    const v = numbers(text(item.ColorRangeMaskAreaSampleInfo));
    if (v.length < 2 || !Number.isFinite(v[0]) || !Number.isFinite(v[1])) continue;
    let radius = 0;
    if (v.length >= 10 && v.slice(2, 10).every(Number.isFinite)) {
      // Shoelace area of the four corners, in mask-frame units.
      let area = 0;
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        area += v[2 + 2 * i]! * frame.sx * v[3 + 2 * j]! * frame.sy - v[2 + 2 * j]! * frame.sx * v[3 + 2 * i]! * frame.sy;
      }
      radius = Math.sqrt(Math.abs(area) / 2 / Math.PI);
    }
    samples.push({ x: v[0]! * frame.sx, y: v[1]! * frame.sy, r: radius });
  }
  if (!samples.length) return { skip: 'Color Range without samples' };
  if (samples.length > MAX_COLOR_SAMPLES) notes.push(`only the first ${MAX_COLOR_SAMPLES} colour samples kept`);
  // Lightroom 11+ wrote ColorAmount 0.494949 for Refine 50 and 0.79798 for 80 (Refine 1..100);
  // Lightroom 7-10 stored its Amount 0..100 divided by 100.
  const amount = num(r, 'ColorAmount', 0.5);
  const refine = num(r, 'Version', 3) >= 3 ? 1 + 99 * amount : 100 * amount;
  return { comp: { ...base('color'), kind: 'color', samples: samples.slice(0, MAX_COLOR_SAMPLES), refine: clamp(Math.round(refine), 0, 100) } };
}

function rangeComponent(r: XmpStruct, frame: Frame | null, notes: string[]): Built | null {
  switch (num(r, 'Type', 0)) {
    case 0:
      return null;
    case 1:
      return colorFromRange(r, frame, notes);
    case 2:
      return luminanceFromRange(r);
    case 3:
      return { skip: 'Depth Range' };
    default:
      return { skip: 'Range Mask' };
  }
}

/**
 * One shape (not a brush stroke) -> component, without mode/invert. `container` decides
 * what Flipped means on a radial: the process 2012 Radial Filter worked outside the
 * ellipse unless Flipped ("Invert Mask"); in mask groups Lightroom keeps Flipped as the
 * complement of MaskInverted, which alone says outside.
 */
function shapeComponent(e: XmpStruct, what: string, container: MaskContainer, frame: Frame | null, notes: string[]): { built: Built; outside?: boolean } {
  switch (what) {
    case 'Mask/Gradient': {
      if (!frame) return { built: { frame: true } };
      const [fx, fy, zx, zy] = ['FullX', 'FullY', 'ZeroX', 'ZeroY'].map((k) => num(e, k));
      if (![fx, fy, zx, zy].every(Number.isFinite)) return { built: { skip: 'Linear Gradient without a position' } };
      return { built: { comp: { ...base('linear'), kind: 'linear', x0: fx! * frame.sx, y0: fy! * frame.sy, x1: zx! * frame.sx, y1: zy! * frame.sy } } };
    }
    case 'Mask/CircularGradient': {
      if (!frame) return { built: { frame: true } };
      const [l, t, r, b] = ['Left', 'Top', 'Right', 'Bottom'].map((k) => num(e, k));
      if (![l, t, r, b].every(Number.isFinite)) return { built: { skip: 'Radial Gradient without a position' } };
      // (Left, Top) and (Right, Bottom) are the ellipse box's corners turned by Angle:
      // half the corner-to-corner vector is R(angle) (rx, ry).
      const angle = num(e, 'Angle', 0);
      const a = (angle * Math.PI) / 180;
      const X = ((r! - l!) / 2) * frame.sx;
      const Y = ((b! - t!) / 2) * frame.sy;
      const rx = Math.abs(X * Math.cos(a) + Y * Math.sin(a));
      const ry = Math.abs(-X * Math.sin(a) + Y * Math.cos(a));
      const outside = container === 'MaskGroupBasedCorrections' ? false : flag(e, 'Flipped') !== true;
      return {
        built: {
          comp: {
            ...base('radial'),
            kind: 'radial',
            cx: ((l! + r!) / 2) * frame.sx,
            cy: ((t! + b!) / 2) * frame.sy,
            rx,
            ry,
            angle,
            feather: clamp(num(e, 'Feather', 50), 0, 100),
          },
        },
        outside,
      };
    }
    case 'Mask/Aggregate': {
      if (!frame) return { built: { frame: true } };
      const comp: BrushComponent = { ...base('brush'), kind: 'brush', strokes: [] };
      for (const child of items(e.Masks)) {
        if (!isStruct(child) || flag(child, 'MaskActive') === false || text(child.What) !== 'Mask/Paint') continue;
        comp.strokes.push(...strokesFromPaint(child, frame, isErase(child)));
      }
      return { built: comp.strokes.length ? { comp } : { skip: 'empty Brush' } };
    }
    case 'Mask/RangeMask': {
      const r = isStruct(e.CorrectionRangeMask) ? e.CorrectionRangeMask : e;
      return { built: rangeComponent(r, frame, notes) ?? { skip: 'empty Range Mask' } };
    }
    case 'Mask/Image':
      return { built: aiFromImage(e, notes) };
    default:
      return { built: { skip: what ? what.replace(/^Mask\//, '') : 'unknown mask type' } };
  }
}

interface Collector {
  warnings: string[];
  unmapped: Set<string>;
  unsupportedLocals: Set<string>;
  /** Masks skipped because their shapes need the photo size. */
  noFrame: number;
}

function localAdjustments(c: XmpStruct, container: MaskContainer, out: Collector): LocalAdjustments {
  const adjust = defaultAdjustments();
  for (const [field, value] of Object.entries(c)) {
    const row = LOCAL_ROWS[field];
    if (row) {
      const n = toNumber(text(value));
      if (!Number.isFinite(n)) continue;
      const [key, factor] = row;
      adjust[key] = key === 'colorHue' ? ((Math.round(n) % 360) + 360) % 360 : clampParam(LOCAL_PARAMS[key], n * factor);
      continue;
    }
    let set = false;
    if (LOCAL_CURVES.has(field)) {
      // An untouched curve is the diagonal.
      set = items(value).some((p) => {
        const [x, y] = numbers(text(p));
        return x !== y;
      });
    } else if (field.startsWith('Local') && !LEGACY_LOCALS.has(field)) {
      if (Array.isArray(value)) set = value.some((v) => typeof v !== 'string' || v.trim() !== '');
      else {
        const n = toNumber(text(value));
        set = Number.isFinite(n) && n !== (LOCAL_NEUTRAL[field] ?? 0);
      }
    }
    if (set) {
      out.unmapped.add(`${container}.${field}`);
      out.unsupportedLocals.add(field);
    }
  }
  return adjust;
}

/** Normalises "subtract the inverted shape" (how Lightroom stores Intersect) to Intersect, and back. */
function settle(comp: MaskComponent, mode: MaskMode, invert: boolean): MaskComponent {
  if (invert && mode === 'subtract') return { ...comp, mode: 'intersect', invert: false };
  if (invert && mode === 'intersect') return { ...comp, mode: 'subtract', invert: false };
  return { ...comp, mode, invert };
}

const DEFAULT_NAMES: Record<MaskContainer, string> = {
  MaskGroupBasedCorrections: 'Mask',
  GradientBasedCorrections: 'Linear Gradient',
  CircularGradientBasedCorrections: 'Radial Gradient',
  PaintBasedCorrections: 'Brush',
};

function convertCorrection(c: XmpStruct, container: MaskContainer, index: number, frame: Frame | null, out: Collector): Mask | null {
  const name = (text(c.CorrectionName) || `${DEFAULT_NAMES[container]} ${index + 1}`).slice(0, 60);
  const comps: MaskComponent[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];
  let needsFrame = false;
  // Process 2012 brush strokes after a shape: added strokes and erasing strokes (which
  // remove from the whole mask) go to their own brush components.
  let paint: { pure: BrushComponent | null; add: BrushComponent | null; sub: BrushComponent | null } = { pure: null, add: null, sub: null };

  const push = (comp: MaskComponent) => {
    // Subtracting or intersecting before anything was added leaves the mask empty.
    if (comps.length === 0 && comp.mode !== 'add') return;
    comps.push(comps.length === 0 ? { ...comp, mode: 'add' } : comp);
  };
  const handle = (built: Built, mode: MaskMode, invert: boolean) => {
    if ('frame' in built) needsFrame = true;
    else if ('skip' in built) skipped.push(built.skip);
    else push(settle(built.comp, mode, invert));
  };

  for (const e of items(c.CorrectionMasks)) {
    if (!isStruct(e) || flag(e, 'MaskActive') === false) continue;
    const what = text(e.What) ?? '';
    const blend = num(e, 'MaskBlendMode', 0);
    const inverted = flag(e, 'MaskInverted') === true;
    if (what === 'Mask/Paint') {
      if (!frame) {
        needsFrame = true;
        continue;
      }
      const erase = isErase(e);
      const strokes = strokesFromPaint(e, frame, erase);
      if (!strokes.length) continue;
      if (paint.pure || comps.length === 0) {
        // Strokes on their own: one brush, erasing strokes rasterised in order.
        if (!paint.pure) {
          paint.pure = { ...base('brush'), kind: 'brush', strokes: [] };
          comps.push(paint.pure);
        }
        paint.pure.strokes.push(...strokes);
      } else {
        const key = erase ? 'sub' : 'add';
        if (!paint[key]) {
          paint[key] = { ...base('brush'), kind: 'brush', mode: erase ? 'subtract' : 'add', strokes: [] };
          comps.push(paint[key]!);
        }
        paint[key]!.strokes.push(...strokes.map((s) => ({ ...s, erase: false })));
      }
      continue;
    }
    paint = { pure: null, add: null, sub: null };
    const mode: MaskMode = blend === 2 ? 'intersect' : blend === 1 || num(e, 'MaskValue', 1) <= 0 ? 'subtract' : 'add';
    const { built, outside } = shapeComponent(e, what, container, frame, notes);
    handle(built, mode, inverted !== (outside ?? false));
  }

  // Before Lightroom 11 a range mask refined the whole correction.
  if (isStruct(c.CorrectionRangeMask)) {
    const built = rangeComponent(c.CorrectionRangeMask, frame, notes);
    if (built) handle(built, 'intersect', false);
  }

  if (needsFrame) {
    out.noFrame++;
    return null;
  }
  const uniq = [...new Set(skipped)];
  if (!comps.length) {
    out.warnings.push(uniq.length ? `Mask "${name}" skipped: ${uniq.join(', ')} can't be imported` : `Mask "${name}" skipped: nothing to import`);
    return null;
  }
  if (uniq.length) out.warnings.push(`Mask "${name}": ${uniq.join(', ')} left out (can't be imported)`);
  for (const n of notes) out.warnings.push(`Mask "${name}": ${n}`);

  // Keep the recipe small: cap the points of each brush.
  for (const comp of comps) {
    if (comp.kind !== 'brush') continue;
    let budget = MAX_BRUSH_POINTS * 2;
    let cut = false;
    comp.strokes = comp.strokes.filter((s) => {
      if (budget <= 0) return !(cut = true);
      if (s.points.length > budget) {
        s.points = s.points.slice(0, budget);
        cut = true;
      }
      budget -= s.points.length;
      return true;
    });
    if (cut) out.warnings.push(`Mask "${name}": brush strokes shortened to ${MAX_BRUSH_POINTS} points`);
  }

  return {
    id: shortId(),
    name,
    visible: flag(c, 'CorrectionActive') !== false,
    amount: clamp(num(c, 'CorrectionAmount', 1) * 100, 0, 200),
    components: mergeAi(comps),
    adjust: localAdjustments(c, container, out),
  };
}

const LOCAL_LABELS: Record<string, string> = {
  LocalLuminanceNoise: 'Noise',
  LocalMoire: 'Moiré',
  LocalDefringe: 'Defringe',
  LocalGrain: 'Grain',
  LocalCurveRefineSaturation: 'Curve Refine Saturation',
  LocalPointColors: 'Point Color',
};

const localLabel = (field: string) =>
  LOCAL_CURVES.has(field) ? 'Curve' : (LOCAL_LABELS[field] ?? field.replace(/^Local/, '').replace(/([a-z])([A-Z])/g, '$1 $2'));

/**
 * Lightroom's local corrections -> masks (in Lightroom's order), or null when the XMP has
 * none. Masks over our limits are left out with a warning. Without `ctx` (the photo size)
 * only masks that need no position (luminance ranges) can be imported.
 */
export function importMasks(crs: Pick<CrsSettings, 'structs'>, ctx?: CropContext): MaskImport | null {
  const present = MASK_CONTAINERS.filter((k) => crs.structs[k]?.length);
  if (!present.length) return null;
  const frame = ctx ? maskFrame(ctx) : null;
  const out: Collector = { warnings: [], unmapped: new Set(), unsupportedLocals: new Set(), noFrame: 0 };
  const converted: { mask: Mask; container: MaskContainer }[] = [];
  for (const container of present) {
    crs.structs[container]!.forEach((c, i) => {
      if (!isStruct(c)) return;
      const mask = convertCorrection(c, container, i, frame, out);
      if (mask) converted.push({ mask, container });
    });
  }

  // Limits: whole masks are left out, since dropping a part could flip what a mask covers.
  const masks: Mask[] = [];
  const imported: Partial<Record<MaskContainer, number>> = {};
  const over: string[] = [];
  let components = 0;
  let brushes = 0;
  let ai = 0;
  for (const { mask, container } of converted) {
    const nb = mask.components.filter((c) => c.kind === 'brush').length;
    const na = mask.components.filter((c) => c.kind === 'ai').length;
    if (masks.length >= MAX_MASKS) over.push(mask.name);
    else if (components + mask.components.length > MAX_COMPONENTS) out.warnings.push(`Mask "${mask.name}" skipped: more than ${MAX_COMPONENTS} mask parts in total`);
    else if (brushes + nb > MAX_BRUSHES) out.warnings.push(`Mask "${mask.name}" skipped: more than ${MAX_BRUSHES} brushes in total`);
    else if (ai + na > MAX_AI) out.warnings.push(`Mask "${mask.name}" skipped: more than ${MAX_AI} AI selections in total`);
    else {
      masks.push(mask);
      components += mask.components.length;
      brushes += nb;
      ai += na;
      imported[container] = (imported[container] ?? 0) + 1;
    }
  }
  if (over.length) out.warnings.push(`${over.length} mask${over.length === 1 ? '' : 's'} over the limit of ${MAX_MASKS} skipped: ${over.map((n) => `"${n}"`).join(', ')}`);
  if (out.noFrame) out.warnings.push(`${out.noFrame} mask${out.noFrame === 1 ? '' : 's'} skipped (mask positions need the photo size)`);
  if (out.unsupportedLocals.size) {
    const labels = [...new Set([...out.unsupportedLocals].map(localLabel))].sort();
    out.warnings.push(`Mask sliders not supported (ignored): ${labels.join(', ')}`);
  }
  return { masks: normalizeMasks(masks), imported, warnings: out.warnings, unmapped: [...out.unmapped].sort() };
}
