// Local adjustments (Lightroom's Masking panel). A mask is built from components (gradients,
// brush strokes, polygons, range masks) that are added, subtracted or intersected, and carries
// its own sliders.
//
// Geometry lives in the "mask frame": the decoded image in sensor orientation, scaled so
// the longer side is 1 (x in [0, W/max], y in [0, H/max], y down). It is isotropic, so a
// circle stays a circle, and it doesn't move when the photo is cropped, straightened or
// rotated: masks stay on the content.
import { clampParam, type ParamSpec } from './params.ts';

export const MAX_MASKS = 8;
/** Components across all masks (the shader evaluates them in one loop). */
export const MAX_COMPONENTS = 24;
/** Brush and polygon components across all masks (each one is a map in the shader's brush atlas). */
export const MAX_BRUSHES = 8;
/** Corners of one polygon (a lasso is simplified down to this). */
export const MAX_POLYGON_POINTS = 500;
/** Sample points of one colour range component (Lightroom allows 5). */
export const MAX_COLOR_SAMPLES = 5;
/** Points across all strokes of one brush component, to keep the recipe small. */
export const MAX_BRUSH_POINTS = 20000;
/** AI components across all masks (each one is a map in the AI atlas). */
export const MAX_AI = 8;
/** Points brushed over an object (Objects mask). */
export const MAX_OBJECT_POINTS = 64;

export type MaskMode = 'add' | 'subtract' | 'intersect';
export type ComponentKind = 'linear' | 'radial' | 'luminance' | 'brush' | 'polygon' | 'color' | 'ai';

interface ComponentBase {
  id: string;
  mode: MaskMode;
  invert: boolean;
  /** Edge refinement of this part alone, before the parts are combined; absent = none. */
  edge?: MaskEdge;
}

/** Full effect on the (x0, y0) side, fading to none at (x1, y1). */
export interface LinearComponent extends ComponentBase {
  kind: 'linear';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Ellipse: full effect inside, fading out over the outer `feather` % of its radius. */
export interface RadialComponent extends ComponentBase {
  kind: 'radial';
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** Degrees, clockwise (y down), of the rx axis. */
  angle: number;
  /** 0..100 */
  feather: number;
}

/** Brightness range in display lightness 0..100, with soft edges. */
export interface LuminanceComponent extends ComponentBase {
  kind: 'luminance';
  lo: number;
  hi: number;
  /** 0..100: how far beyond lo/hi the selection fades out. */
  smooth: number;
}

/** One brush stroke: dabs along a polyline. */
export interface BrushStroke {
  /** Erasing strokes remove from the brush mask (Lightroom's Erase brush / Alt). */
  erase: boolean;
  /** Dab radius in mask-frame units (the longer image side is 1). */
  size: number;
  /** 0..100: the outer part of the radius that fades out. */
  feather: number;
  /** 0..100: how much one dab adds; overlapping dabs build up. */
  flow: number;
  /** 0..100: the most the stroke can build up to. */
  density: number;
  /** Flat [x0, y0, x1, y1, ...] in the mask frame. */
  points: number[];
}

/** Painted mask: the strokes are rasterised in order (later erase strokes remove earlier paint). */
export interface BrushComponent extends ComponentBase {
  kind: 'brush';
  strokes: BrushStroke[];
}

/**
 * A closed shape, filled: drawn corner by corner, or freehand (the lasso). Its edge is sharp
 * (anti-aliased); the part's edge settings soften it. Lightroom has no polygon mask.
 */
export interface PolygonComponent extends ComponentBase {
  kind: 'polygon';
  /** Corners, flat [x0, y0, x1, y1, ...] in the mask frame; the last one joins the first. */
  points: number[];
  /** Drawn freehand: edited as a whole (moved), not corner by corner. */
  freehand?: boolean;
}

/** A point (or small disc of radius r, mask-frame units) whose colour the range selects. */
export interface ColorSample {
  x: number;
  y: number;
  r: number;
}

/**
 * Colour range: selects colours close to the sampled ones. The colours are read from the
 * photo at render time (after white balance, before any other edit), so the selection
 * follows a white balance change.
 */
export interface ColorComponent extends ComponentBase {
  kind: 'color';
  samples: ColorSample[];
  /** 0..100: how wide a range of similar colours is included (Lightroom's Refine). */
  refine: number;
}

/** What an AI component selects (Lightroom's Select Subject, Sky, Background, People, Landscape, Objects). */
export type AiTarget = 'subject' | 'sky' | 'background' | 'people' | 'landscape' | 'object';
export type PersonPart = 'person' | 'faceSkin' | 'bodySkin' | 'hair' | 'facialHair' | 'eyebrows' | 'eyeSclera' | 'iris' | 'lips' | 'teeth' | 'clothes';
export type LandscapeClass = 'sky' | 'water' | 'vegetation' | 'mountains' | 'architecture' | 'naturalGround' | 'artificialGround' | 'snow';

export const AI_TARGETS: AiTarget[] = ['subject', 'sky', 'background', 'people', 'landscape', 'object'];
export const AI_TARGET_LABELS: Record<AiTarget, string> = {
  subject: 'Subject',
  sky: 'Sky',
  background: 'Background',
  people: 'People',
  landscape: 'Landscape',
  object: 'Object',
};
/** Lightroom's People parts, in its order. */
export const PERSON_PART_LABELS: Record<PersonPart, string> = {
  person: 'Entire Person',
  faceSkin: 'Face Skin',
  bodySkin: 'Body Skin',
  eyebrows: 'Eyebrows',
  eyeSclera: 'Eye Sclera',
  iris: 'Iris and Pupil',
  lips: 'Lips',
  teeth: 'Teeth',
  hair: 'Hair',
  facialHair: 'Facial Hair',
  clothes: 'Clothes',
};
export const PERSON_PARTS = Object.keys(PERSON_PART_LABELS) as PersonPart[];
export const LANDSCAPE_LABELS: Record<LandscapeClass, string> = {
  sky: 'Sky',
  water: 'Water',
  vegetation: 'Vegetation',
  mountains: 'Mountains',
  architecture: 'Architecture',
  naturalGround: 'Natural Ground',
  artificialGround: 'Artificial Ground',
  snow: 'Snow',
};
export const LANDSCAPE_CLASSES = Object.keys(LANDSCAPE_LABELS) as LandscapeClass[];

/**
 * AI selection. It stores what was selected, never pixels: the editor computes the map
 * from the photo (and recomputes it on another photo, like Lightroom's adaptive presets).
 * Points are in the mask frame, like all other geometry.
 */
export interface AiComponent extends ComponentBase {
  kind: 'ai';
  target: AiTarget;
  /** People: the parts selected (their union). */
  parts?: PersonPart[];
  /** People: a point on the one person selected; absent or null = everyone. */
  person?: { x: number; y: number } | null;
  /** Landscape: the categories selected (their union). */
  classes?: LandscapeClass[];
  /** Object: the box drawn around it (x0, y0, x1, y1). */
  box?: [number, number, number, number];
  /** Object: points brushed over it, flat [x, y, ...]. */
  points?: number[];
}

export type MaskComponent = LinearComponent | RadialComponent | LuminanceComponent | BrushComponent | PolygonComponent | ColorComponent | AiComponent;

export interface LocalAdjustments {
  temp: number;
  tint: number;
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  texture: number;
  clarity: number;
  dehaze: number;
  hue: number;
  saturation: number;
  sharpness: number;
  /** Colour overlay (Lightroom's colour swatch): hue 0..359 and saturation 0..100. */
  colorHue: number;
  colorSat: number;
}

export type LocalKey = keyof LocalAdjustments;

/**
 * Edge refinement of one part of a mask, or of the whole mask (its parts combined), in
 * pixels of the full-resolution photo. Smooth and Offset treat the selection as a shape whose
 * outline is where it is 50 %; Feather then fades that outline. Lightroom has no equivalent:
 * masks imported from XMP start without refinement.
 */
export interface MaskEdge {
  /** Grows (+) or shrinks (-) the mask by this many pixels. */
  offset: number;
  /** Width of the fade across the edge. */
  feather: number;
  /** Radius below which wiggles and specks of the edge are smoothed away. */
  smooth: number;
}

export interface Mask {
  id: string;
  name: string;
  /** Off = the mask's adjustments are not applied (Lightroom's eye icon). */
  visible: boolean;
  /** 0..200 %: scales all of the mask's adjustments. */
  amount: number;
  components: MaskComponent[];
  adjust: LocalAdjustments;
  edge: MaskEdge;
}

const lp = (key: LocalKey, label: string, min: number, max: number, step = 1, decimals = 0, signed = true): ParamSpec => ({
  path: `adjust.${key}`,
  label,
  min,
  max,
  default: 0,
  step,
  decimals,
  signed,
});

/** Lightroom's local sliders. Paths are relative to the mask. */
export const LOCAL_PARAMS: Record<LocalKey, ParamSpec> = {
  temp: lp('temp', 'Temp', -100, 100),
  tint: lp('tint', 'Tint', -100, 100),
  exposure: lp('exposure', 'Exposure', -4, 4, 0.01, 2),
  contrast: lp('contrast', 'Contrast', -100, 100),
  highlights: lp('highlights', 'Highlights', -100, 100),
  shadows: lp('shadows', 'Shadows', -100, 100),
  whites: lp('whites', 'Whites', -100, 100),
  blacks: lp('blacks', 'Blacks', -100, 100),
  texture: lp('texture', 'Texture', -100, 100),
  clarity: lp('clarity', 'Clarity', -100, 100),
  dehaze: lp('dehaze', 'Dehaze', -100, 100),
  hue: lp('hue', 'Hue', -180, 180),
  saturation: lp('saturation', 'Saturation', -100, 100),
  sharpness: lp('sharpness', 'Sharpness', -100, 100),
  colorHue: lp('colorHue', 'Color Hue', 0, 359, 1, 0, false),
  colorSat: lp('colorSat', 'Color Saturation', 0, 100, 1, 0, false),
};

export const LOCAL_KEYS = Object.keys(LOCAL_PARAMS) as LocalKey[];

export const MASK_AMOUNT: ParamSpec = { path: 'amount', label: 'Amount', min: 0, max: 200, default: 100, step: 1, decimals: 0, signed: false };
export const MASK_OFFSET: ParamSpec = { path: 'edge.offset', label: 'Offset', min: -100, max: 100, default: 0, step: 1, decimals: 0, signed: true, unit: 'px' };
export const MASK_FEATHER: ParamSpec = { path: 'edge.feather', label: 'Feather', min: 0, max: 200, default: 0, step: 1, decimals: 0, signed: false, unit: 'px' };
export const MASK_SMOOTH: ParamSpec = { path: 'edge.smooth', label: 'Smooth', min: 0, max: 100, default: 0, step: 1, decimals: 0, signed: false, unit: 'px' };
export const EDGE_PARAMS: ParamSpec[] = [MASK_OFFSET, MASK_FEATHER, MASK_SMOOTH];
export const RADIAL_FEATHER: ParamSpec = { path: 'feather', label: 'Feather', min: 0, max: 100, default: 50, step: 1, decimals: 0, signed: false };
export const LUMINANCE_SMOOTH: ParamSpec = { path: 'smooth', label: 'Smoothness', min: 0, max: 100, default: 20, step: 1, decimals: 0, signed: false };
export const COLOR_REFINE: ParamSpec = { path: 'refine', label: 'Refine', min: 0, max: 100, default: 50, step: 1, decimals: 0, signed: false };
/** Brush settings (not stored per component: each stroke keeps the values it was painted with). */
export const BRUSH_SIZE: ParamSpec = { path: 'size', label: 'Size', min: 1, max: 100, default: 25, step: 1, decimals: 0, signed: false };
export const BRUSH_FEATHER: ParamSpec = { path: 'feather', label: 'Feather', min: 0, max: 100, default: 50, step: 1, decimals: 0, signed: false };
export const BRUSH_FLOW: ParamSpec = { path: 'flow', label: 'Flow', min: 1, max: 100, default: 100, step: 1, decimals: 0, signed: false };
export const BRUSH_DENSITY: ParamSpec = { path: 'density', label: 'Density', min: 1, max: 100, default: 100, step: 1, decimals: 0, signed: false };

export const COMPONENT_LABELS: Record<ComponentKind, string> = {
  linear: 'Linear Gradient',
  radial: 'Radial Gradient',
  luminance: 'Luminance Range',
  brush: 'Brush',
  polygon: 'Polygon',
  color: 'Color Range',
  ai: 'AI Selection',
};

/** Name of an AI component, as Lightroom names it: "Subject", "People – Face Skin", "Landscape – Sky + Water". */
export function aiLabel(c: Pick<AiComponent, 'target' | 'parts' | 'classes' | 'person'>): string {
  const base = AI_TARGET_LABELS[c.target];
  const list = (names: string[], all: number) => (names.length === all ? '' : names.length > 2 ? `${names.slice(0, 2).join(' + ')} + …` : names.join(' + '));
  if (c.target === 'people') {
    const parts = c.parts ?? ['person'];
    const who = c.person ? 'Person' : base;
    const what = parts.length === 1 && parts[0] === 'person' ? '' : list(parts.map((p) => PERSON_PART_LABELS[p]), -1);
    return what ? `${who} – ${what}` : who;
  }
  if (c.target === 'landscape') {
    const what = list((c.classes ?? []).map((k) => LANDSCAPE_LABELS[k]), LANDSCAPE_CLASSES.length);
    return what ? `${base} – ${what}` : base;
  }
  return base;
}

/** Name of a part, as the panel and the history show it. */
export function componentLabel(c: MaskComponent): string {
  if (c.kind === 'ai') return aiLabel(c);
  if (c.kind === 'polygon' && c.freehand) return 'Lasso';
  return COMPONENT_LABELS[c.kind];
}

export const shortId = (): string => Math.random().toString(36).slice(2, 10);

export function defaultAdjustments(): LocalAdjustments {
  return Object.fromEntries(LOCAL_KEYS.map((k) => [k, 0])) as unknown as LocalAdjustments;
}

export const defaultEdge = (): MaskEdge => ({ offset: 0, feather: 0, smooth: 0 });

export function newMask(name: string, first: MaskComponent): Mask {
  return { id: shortId(), name, visible: true, amount: 100, components: [{ ...first, mode: 'add' }], adjust: defaultAdjustments(), edge: defaultEdge() };
}

/** True when the refinement changes anything (offset, feather or smooth set). */
export function isEdgeSet(r: MaskEdge | undefined | null): r is MaskEdge {
  return !!r && (r.offset !== 0 || r.feather > 0 || r.smooth > 0);
}

/** True when the whole mask's edge is refined. */
export function isMaskRefined(m: Pick<Mask, 'edge'>): boolean {
  return isEdgeSet(m.edge as MaskEdge | undefined); // undefined: a recipe that skipped normalizeMasks
}

/** True when this part's own edge is refined. */
export function isPartRefined(c: Pick<MaskComponent, 'edge'>): boolean {
  return isEdgeSet(c.edge);
}

/** Defaults for a component of the given kind (geometry is set by whoever creates it). */
export function newComponent(kind: ComponentKind, mode: MaskMode = 'add'): MaskComponent {
  const base = { id: shortId(), mode, invert: false };
  if (kind === 'linear') return { ...base, kind, x0: 0.5, y0: 0.2, x1: 0.5, y1: 0.45 };
  if (kind === 'radial') return { ...base, kind, cx: 0.5, cy: 0.33, rx: 0.2, ry: 0.15, angle: 0, feather: 50 };
  if (kind === 'brush') return { ...base, kind, strokes: [] };
  if (kind === 'polygon') return { ...base, kind, points: [] };
  if (kind === 'color') return { ...base, kind, samples: [], refine: 50 };
  if (kind === 'ai') return { ...base, kind, target: 'subject' };
  return { ...base, kind, lo: 50, hi: 100, smooth: 20 };
}

/** A new AI component (the editor fills in parts, classes or the object prompt). */
export function newAiComponent(target: AiTarget, mode: MaskMode = 'add', extra: Partial<Pick<AiComponent, 'parts' | 'person' | 'classes' | 'box' | 'points'>> = {}): AiComponent {
  const c: AiComponent = { id: shortId(), mode, invert: false, kind: 'ai', target };
  if (target === 'people') {
    c.parts = extra.parts?.length ? [...extra.parts] : ['person'];
    c.person = extra.person ?? null;
  }
  if (target === 'landscape') c.classes = extra.classes?.length ? [...extra.classes] : ['sky'];
  if (target === 'object') {
    if (extra.box) c.box = [...extra.box];
    if (extra.points?.length) c.points = [...extra.points];
  }
  return c;
}

/** True when the mask changes the picture (visible, has a component and a non-zero slider). */
export function isMaskActive(m: Mask): boolean {
  return m.visible && m.amount > 0 && m.components.length > 0 && LOCAL_KEYS.some((k) => k !== 'colorHue' && m.adjust[k] !== 0);
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, def: number, min = -Infinity, max = Infinity): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
const clampNum = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
/** Stroke points are stored with 5 decimals (1/100000 of the longer side is far below a pixel). */
const quant = (v: number) => Math.round(v * 1e5) / 1e5;

/** A stored refinement, clamped (whole pixels); missing fields are 0. */
function normalizeEdge(input: unknown): MaskEdge {
  const r = isObject(input) ? input : {};
  return {
    offset: Math.round(clampParam(MASK_OFFSET, num(r.offset, 0))),
    feather: Math.round(clampParam(MASK_FEATHER, num(r.feather, 0))),
    smooth: Math.round(clampParam(MASK_SMOOTH, num(r.smooth, 0))),
  };
}

function normalizeComponent(input: unknown): MaskComponent | null {
  const c = normalizeComponentShape(input);
  if (!c) return null;
  // Kept only when it does something, so parts without one stay as they were stored.
  const edge = normalizeEdge((input as Record<string, unknown>).edge);
  if (isEdgeSet(edge)) c.edge = edge;
  return c;
}

function normalizeComponentShape(input: unknown): MaskComponent | null {
  if (!isObject(input)) return null;
  const mode: MaskMode = input.mode === 'subtract' || input.mode === 'intersect' ? input.mode : 'add';
  const base = { id: typeof input.id === 'string' && input.id ? input.id : shortId(), mode, invert: input.invert === true };
  // Geometry may reach a little outside the image (a gradient that starts above the frame).
  const pos = (v: unknown, def: number) => num(v, def, -2, 3);
  switch (input.kind) {
    case 'linear': {
      const c = { ...base, kind: 'linear' as const, x0: pos(input.x0, 0.5), y0: pos(input.y0, 0.2), x1: pos(input.x1, 0.5), y1: pos(input.y1, 0.45) };
      // A zero-length gradient has no direction.
      if (Math.hypot(c.x1 - c.x0, c.y1 - c.y0) < 1e-4) c.y1 = c.y0 + 1e-3;
      return c;
    }
    case 'radial':
      return {
        ...base,
        kind: 'radial',
        cx: pos(input.cx, 0.5),
        cy: pos(input.cy, 0.33),
        rx: num(input.rx, 0.2, 1e-3, 4),
        ry: num(input.ry, 0.15, 1e-3, 4),
        angle: ((num(input.angle, 0) % 360) + 360) % 360,
        feather: clampParam(RADIAL_FEATHER, num(input.feather, 50)),
      };
    case 'luminance': {
      const lo = num(input.lo, 50, 0, 100);
      const hi = num(input.hi, 100, 0, 100);
      return { ...base, kind: 'luminance', lo: Math.min(lo, hi), hi: Math.max(lo, hi), smooth: clampParam(LUMINANCE_SMOOTH, num(input.smooth, 20)) };
    }
    case 'brush': {
      const strokes: BrushStroke[] = [];
      let budget = MAX_BRUSH_POINTS * 2;
      for (const st of Array.isArray(input.strokes) ? input.strokes : []) {
        if (!isObject(st) || !Array.isArray(st.points)) continue;
        const pts: number[] = [];
        for (let i = 0; i + 1 < st.points.length && pts.length < budget; i += 2) {
          const x = st.points[i];
          const y = st.points[i + 1];
          if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) pts.push(quant(clampNum(x, -2, 3)), quant(clampNum(y, -2, 3)));
        }
        if (!pts.length) continue;
        budget -= pts.length;
        strokes.push({
          erase: st.erase === true,
          size: num(st.size, 0.02, 1e-4, 1),
          feather: clampParam(BRUSH_FEATHER, num(st.feather, 50)),
          flow: clampParam(BRUSH_FLOW, num(st.flow, 100)),
          density: clampParam(BRUSH_DENSITY, num(st.density, 100)),
          points: pts,
        });
      }
      return { ...base, kind: 'brush', strokes };
    }
    case 'polygon': {
      const pts: number[] = [];
      const src = Array.isArray(input.points) ? input.points : [];
      for (let i = 0; i + 1 < src.length && pts.length < MAX_POLYGON_POINTS * 2; i += 2) {
        const x = src[i];
        const y = src[i + 1];
        if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) pts.push(quant(clampNum(x, -2, 3)), quant(clampNum(y, -2, 3)));
      }
      // A shape needs three corners.
      if (pts.length < 6) return null;
      const c: PolygonComponent = { ...base, kind: 'polygon', points: pts };
      if (input.freehand === true) c.freehand = true;
      return c;
    }
    case 'color': {
      const samples: ColorSample[] = [];
      for (const sm of Array.isArray(input.samples) ? input.samples : []) {
        if (samples.length >= MAX_COLOR_SAMPLES || !isObject(sm)) continue;
        samples.push({ x: pos(sm.x, 0.5), y: pos(sm.y, 0.5), r: num(sm.r, 0, 0, 0.25) });
      }
      return { ...base, kind: 'color', samples, refine: clampParam(COLOR_REFINE, num(input.refine, 50)) };
    }
    case 'ai':
      return normalizeAi(input, base);
    default:
      return null;
  }
}

function pickList<T extends string>(v: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(v)) return [];
  // Kept in the canonical order, so the same selection always gives the same JSON.
  return allowed.filter((k) => v.includes(k));
}

function normalizeAi(input: Record<string, unknown>, base: Pick<AiComponent, 'id' | 'mode' | 'invert'>): AiComponent | null {
  const target = AI_TARGETS.find((t) => t === input.target);
  if (!target) return null;
  const c: AiComponent = { ...base, kind: 'ai', target };
  const pos = (v: unknown, def: number) => quant(num(v, def, -2, 3));
  if (target === 'people') {
    const parts = pickList(input.parts, PERSON_PARTS);
    c.parts = parts.length ? parts : ['person'];
    c.person = isObject(input.person) ? { x: pos(input.person.x, 0.5), y: pos(input.person.y, 0.5) } : null;
  } else if (target === 'landscape') {
    const classes = pickList(input.classes, LANDSCAPE_CLASSES);
    if (!classes.length) return null;
    c.classes = classes;
  } else if (target === 'object') {
    const b = Array.isArray(input.box) && input.box.length === 4 && input.box.every((v) => typeof v === 'number' && Number.isFinite(v)) ? (input.box as number[]) : null;
    if (b) {
      const [x0, y0, x1, y1] = b.map((v) => pos(v, 0)) as [number, number, number, number];
      if (Math.abs(x1 - x0) > 1e-3 && Math.abs(y1 - y0) > 1e-3) c.box = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
    }
    const pts: number[] = [];
    const src = Array.isArray(input.points) ? input.points : [];
    for (let i = 0; i + 1 < src.length && pts.length < MAX_OBJECT_POINTS * 2; i += 2) {
      const x = src[i];
      const y = src[i + 1];
      if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) pts.push(pos(x, 0), pos(y, 0));
    }
    if (pts.length) c.points = pts;
    // An object needs something to point at it.
    if (!c.box && !c.points) return null;
  }
  return c;
}

/** Valid masks from stored JSON: unknown fields dropped, numbers clamped, limits enforced. */
export function normalizeMasks(input: unknown): Mask[] {
  if (!Array.isArray(input)) return [];
  const out: Mask[] = [];
  let components = 0;
  for (const item of input) {
    if (out.length >= MAX_MASKS || !isObject(item)) continue;
    const comps: MaskComponent[] = [];
    for (const c of Array.isArray(item.components) ? item.components : []) {
      if (components + comps.length >= MAX_COMPONENTS) break;
      const n = normalizeComponent(c);
      if (n) comps.push(n);
    }
    if (!comps.length) continue;
    comps[0]!.mode = 'add';
    components += comps.length;
    const adj = isObject(item.adjust) ? item.adjust : {};
    const adjust = defaultAdjustments();
    for (const k of LOCAL_KEYS) adjust[k] = clampParam(LOCAL_PARAMS[k], num(adj[k], 0));
    out.push({
      id: typeof item.id === 'string' && item.id ? item.id : shortId(),
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 60) : `Mask ${out.length + 1}`,
      visible: item.visible !== false,
      amount: clampParam(MASK_AMOUNT, num(item.amount, 100)),
      components: comps,
      adjust,
      edge: normalizeEdge(item.edge),
    });
  }
  return out;
}

/** Total number of components, to check against MAX_COMPONENTS before adding one. */
export const componentCount = (masks: Mask[]): number => masks.reduce((n, m) => n + m.components.length, 0);

/** Brush and polygon components across all masks, to check against MAX_BRUSHES. */
export const brushCount = (masks: Mask[]): number => masks.reduce((n, m) => n + m.components.filter((c) => c.kind === 'brush' || c.kind === 'polygon').length, 0);

/** AI components across all masks, to check against MAX_AI. */
export const aiCount = (masks: Mask[]): number => masks.reduce((n, m) => n + m.components.filter((c) => c.kind === 'ai').length, 0);

/** Every AI component of the recipe's masks. */
export const aiComponents = (masks: Mask[]): AiComponent[] => masks.flatMap((m) => m.components.filter((c): c is AiComponent => c.kind === 'ai'));
