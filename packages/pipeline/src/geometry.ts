// Geometry shared by the renderer and the crop tool.
//
// Coordinate frames (all y-down):
// - source s: normalised sensor image [0,1]², as decoded (not rotated)
// - upright u: the image after camera orientation + crop.rotate90, normalised [0,1]²
//   (pixel size Wu x Hu)
// - output t: normalised render frame [0,1]². In edit mode it is the crop rectangle;
//   in crop mode it is the whole upright image, rotated by the straighten angle.
//
// The Transform panel (perspective, Guided Upright) sits between the upright image and the
// crop: the crop is drawn on the transformed image.
//
// Positive angles rotate the image clockwise on screen.
import type { CropParams, TransformParams } from '@immich-raw/recipe';
import { HALF_DIAGONAL_35MM, rotationHomography, solveUpright, type Segment } from './upright.ts';

/** Row-major 3x3 acting on (x, y, 1); projective when the last row isn't (0, 0, 1). */
export type Affine = [number, number, number, number, number, number, number, number, number];

export type QuarterTurns = 0 | 1 | 2 | 3;

/** Clockwise quarter turns needed to show the sensor image upright (LibRaw flip values). */
export function quarterTurnsFromFlip(flip: number): QuarterTurns {
  if (flip === 3) return 2;
  if (flip === 6) return 1;
  if (flip === 5) return 3;
  return 0;
}

export function totalTurns(flip: number, crop: Pick<CropParams, 'rotate90'>): QuarterTurns {
  return ((quarterTurnsFromFlip(flip) + crop.rotate90) % 4) as QuarterTurns;
}

export function uprightSize(srcW: number, srcH: number, q: QuarterTurns): { w: number; h: number } {
  return q % 2 === 1 ? { w: srcH, h: srcW } : { w: srcW, h: srcH };
}

export const mulAffine = (a: Affine, b: Affine): Affine => {
  const r = new Array(9).fill(0) as Affine;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k]! * b[k * 3 + j]!;
  return r;
};

export const applyAffine = (m: Affine, x: number, y: number): [number, number] => {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
};

/** Inverse of a 3x3 map (affine or projective), scaled so the last element is 1. */
export function invertAffine(m: Affine): Affine {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const inv: Affine = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d];
  const k = Math.abs(inv[8]) > 1e-12 ? inv[8] : det;
  return inv.map((v) => v / k) as Affine;
}

/** Strongest keystone of the Vertical/Horizontal sliders (camera tilt, degrees). */
const KEYSTONE_MAX_DEG = 30;
/** Virtual focal length of the keystone, in half image diagonals. */
const KEYSTONE_FOCAL = 1;

const IDENTITY: Affine = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** True when the Transform sliders change the picture. */
function slidersActive(t: TransformParams): boolean {
  return t.vertical !== 0 || t.horizontal !== 0 || t.rotate !== 0 || t.aspect !== 0 || t.scale !== 100 || t.offsetX !== 0 || t.offsetY !== 0;
}

/** True when the Transform panel (sliders or Guided Upright) changes the picture. */
export function isTransformActive(t: TransformParams | undefined): boolean {
  return !!t && (slidersActive(t) || !!t.upright?.guides.length);
}

/** Normalised upright coordinates -> centred, isotropic (half diagonal = 1). */
function centredFrame(Wu: number, Hu: number): Affine {
  const hd = Math.hypot(Wu, Hu) / 2;
  return [Wu / hd, 0, -0.5 * (Wu / hd), 0, Hu / hd, -0.5 * (Hu / hd), 0, 0, 1];
}

/** A re-projection (centred frame) moved back so the centre stays put, with unit scale there. */
function keepCentre(P: Affine): Affine {
  const c = applyAffine(P, 0, 0);
  P = mulAffine([1, 0, -c[0], 0, 1, -c[1], 0, 0, 1], P);
  const d = 1e-4;
  const px = applyAffine(P, d, 0);
  const py = applyAffine(P, 0, d);
  // Geometric mean of both axes.
  const det = Math.abs(px[0] * py[1] - px[1] * py[0]) / (d * d);
  const k = 1 / Math.sqrt(det || 1);
  return mulAffine([k, 0, 0, 0, k, 0, 0, 0, 1], P);
}

/**
 * Guided Upright as a map on the upright image (normalised, untransformed point -> where it
 * appears), or null without guides (or with guides that ask for too much). The guides are in
 * the mask frame of the source image (srcW x srcH, sensor orientation); q turns it upright.
 */
export function uprightMatrix(t: TransformParams | undefined, q: QuarterTurns, srcW: number, srcH: number): Affine | null {
  const g = t?.upright;
  if (!g?.guides.length) return null;
  const { w: Wu, h: Hu } = uprightSize(srcW, srcH, q);
  const N = centredFrame(Wu, Hu);
  const m = Math.max(srcW, srcH, 1);
  // Mask frame -> source -> upright -> centred.
  const toN = mulAffine(N, mulAffine(invertAffine(orientAffine(q)), scale(m / srcW, m / srcH)));
  const segments = g.guides.map(([x0, y0, x1, y1]): Segment => [applyAffine(toN, x0, y0), applyAffine(toN, x1, y1)]);
  const solved = solveUpright(segments, g.focal35 / HALF_DIAGONAL_35MM);
  if (!solved) return null;
  return mulAffine(invertAffine(N), mulAffine(keepCentre(rotationHomography(solved.rot, solved.f)), N));
}

/**
 * The Transform panel as a map on the upright image (normalised, size Wu x Hu):
 * untransformed point -> where it appears. `upright` (uprightMatrix) applies first; then
 * Vertical/Horizontal re-project the image as if the camera had been tilted (keeping the centre
 * and the size there), then rotate, aspect, scale and offset, all about the image centre.
 */
export function transformMatrix(t: TransformParams | undefined, Wu: number, Hu: number, upright?: Affine | null): Affine {
  const sliders = slidersMatrix(t, Wu, Hu);
  return upright ? mulAffine(sliders, upright) : sliders;
}

function slidersMatrix(t: TransformParams | undefined, Wu: number, Hu: number): Affine {
  if (!t || !slidersActive(t)) return IDENTITY;
  const hd = Math.hypot(Wu, Hu) / 2;
  const N = centredFrame(Wu, Hu);
  const f = KEYSTONE_FOCAL;
  // Negative Vertical widens the top (tilt about x); negative Horizontal widens the left.
  const phi = ((-t.vertical / 100) * KEYSTONE_MAX_DEG * Math.PI) / 180;
  const psi = ((t.horizontal / 100) * KEYSTONE_MAX_DEG * Math.PI) / 180;
  const rx: Affine = [1, 0, 0, 0, Math.cos(phi), -Math.sin(phi), 0, Math.sin(phi), Math.cos(phi)];
  const ry: Affine = [Math.cos(psi), 0, Math.sin(psi), 0, 1, 0, -Math.sin(psi), 0, Math.cos(psi)];
  const K: Affine = [f, 0, 0, 0, f, 0, 0, 0, 1];
  const Kinv: Affine = [1 / f, 0, 0, 0, 1 / f, 0, 0, 0, 1];
  // Keep the centre where it is and the scale there.
  const P = keepCentre(mulAffine(K, mulAffine(mulAffine(ry, rx), Kinv)));
  const stretch = Math.pow(2, t.aspect / 200);
  const sc = t.scale / 100;
  const r = (t.rotate * Math.PI) / 180;
  let M = mulAffine([Math.cos(r), -Math.sin(r), 0, Math.sin(r), Math.cos(r), 0, 0, 0, 1], P);
  M = mulAffine([sc / stretch, 0, 0, 0, sc * stretch, 0, 0, 0, 1], M);
  M = mulAffine([1, 0, (t.offsetX / 100) * (Wu / hd) * 0.5, 0, 1, (t.offsetY / 100) * (Hu / hd) * 0.5, 0, 0, 1], M);
  return mulAffine(invertAffine(N), mulAffine(M, N));
}

/** Where an upright point that appears at u (after the transform) comes from. */
export function transformInverse(t: TransformParams | undefined, Wu: number, Hu: number, upright?: Affine | null): Affine {
  return isTransformActive(t) ? invertAffine(transformMatrix(t, Wu, Hu, upright)) : IDENTITY;
}

const translate = (x: number, y: number): Affine => [1, 0, x, 0, 1, y, 0, 0, 1];
const scale = (x: number, y: number): Affine => [x, 0, 0, 0, y, 0, 0, 0, 1];
/** Clockwise rotation on screen (y-down) by `deg`. */
const rotateCw = (deg: number): Affine => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};

/** upright u -> source s. */
export function orientAffine(q: QuarterTurns): Affine {
  switch (q) {
    case 1:
      return [0, 1, 0, -1, 0, 1, 0, 0, 1]; // sx = uy, sy = 1 - ux
    case 2:
      return [-1, 0, 1, 0, -1, 1, 0, 0, 1];
    case 3:
      return [0, -1, 1, 1, 0, 0, 0, 0, 1]; // sx = 1 - uy, sy = ux
    default:
      return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }
}

export interface FrameInfo {
  /** Output t -> source s. */
  tToS: Affine;
  /** Output size in pixels of the source the sizes were given for. */
  width: number;
  height: number;
}

/**
 * Mapping for edit mode: the output frame is the crop rectangle, the image rotated
 * by -angle around the crop centre underneath it.
 */
export function editFrame(crop: CropParams, flip: number, srcW: number, srcH: number, transform?: TransformParams): FrameInfo {
  const q = totalTurns(flip, crop);
  const { w: Wu, h: Hu } = uprightSize(srcW, srcH, q);
  const cw = crop.w * Wu;
  const ch = crop.h * Hu;
  // t -> centred crop pixels -> rotate back -> upright pixels -> upright normalised
  //   -> undo the perspective transform -> source
  let m = mulAffine(scale(cw, ch), translate(-0.5, -0.5));
  m = mulAffine(rotateCw(-crop.angle), m);
  m = mulAffine(translate(crop.cx * Wu, crop.cy * Hu), m);
  m = mulAffine(scale(1 / Wu, 1 / Hu), m);
  m = mulAffine(transformInverse(transform, Wu, Hu, uprightMatrix(transform, q, srcW, srcH)), m);
  m = mulAffine(orientAffine(q), m);
  return { tToS: m, width: Math.max(1, Math.round(cw)), height: Math.max(1, Math.round(ch)) };
}

/** Mapping for crop mode: the whole upright image, rotated by angle around its centre. */
export function cropViewFrame(crop: CropParams, flip: number, srcW: number, srcH: number, transform?: TransformParams): FrameInfo {
  const q = totalTurns(flip, crop);
  const { w: Wu, h: Hu } = uprightSize(srcW, srcH, q);
  let m = scale(Wu, Hu);
  m = mulAffine(translate(-Wu / 2, -Hu / 2), m);
  m = mulAffine(rotateCw(-crop.angle), m);
  m = mulAffine(translate(Wu / 2, Hu / 2), m);
  m = mulAffine(scale(1 / Wu, 1 / Hu), m);
  m = mulAffine(transformInverse(transform, Wu, Hu, uprightMatrix(transform, q, srcW, srcH)), m);
  m = mulAffine(orientAffine(q), m);
  return { tToS: m, width: Math.round(Wu), height: Math.round(Hu) };
}

/** Crop rectangle as drawn in crop mode, normalised to the view (= upright image box). */
export interface ViewRect {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

const rotPoint = (deg: number, x: number, y: number): [number, number] => applyAffine(rotateCw(deg), x, y);

/** Recipe crop -> rectangle in crop-mode view coordinates. */
export function cropToView(crop: CropParams, Wu: number, Hu: number): ViewRect {
  const [dx, dy] = rotPoint(crop.angle, (crop.cx - 0.5) * Wu, (crop.cy - 0.5) * Hu);
  return { cx: 0.5 + dx / Wu, cy: 0.5 + dy / Hu, w: crop.w, h: crop.h };
}

/** Rectangle in crop-mode view coordinates -> recipe crop centre/size (angle unchanged). */
export function viewToCrop(view: ViewRect, angle: number, Wu: number, Hu: number): Pick<CropParams, 'cx' | 'cy' | 'w' | 'h'> {
  const [dx, dy] = rotPoint(-angle, (view.cx - 0.5) * Wu, (view.cy - 0.5) * Hu);
  return { cx: 0.5 + dx / Wu, cy: 0.5 + dy / Hu, w: view.w, h: view.h };
}

/**
 * Are all four corners of the view rectangle inside the rotated image? With `limit` (the
 * inverse perspective transform, see transformInverse) inside the transformed image instead:
 * the transformed image is a convex quadrilateral, so the corners are enough.
 */
export function viewRectInside(view: ViewRect, angle: number, Wu: number, Hu: number, eps = 1e-6, limit?: Affine): boolean {
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    const vx = (view.cx + (sx! * view.w) / 2 - 0.5) * Wu;
    const vy = (view.cy + (sy! * view.h) / 2 - 0.5) * Hu;
    const [px, py] = rotPoint(-angle, vx, vy);
    if (limit) {
      const [ux, uy] = applyAffine(limit, px / Wu + 0.5, py / Hu + 0.5);
      if (!(ux >= -eps && uy >= -eps && ux <= 1 + eps && uy <= 1 + eps)) return false;
    } else if (Math.abs(px) > Wu / 2 + eps * Wu || Math.abs(py) > Hu / 2 + eps * Hu) return false;
  }
  return true;
}

/**
 * Makes the rectangle fit inside the rotated image: first pulls the centre in, then
 * shrinks around the centre (keeping the aspect ratio).
 */
export function fitViewRect(view: ViewRect, angle: number, Wu: number, Hu: number, limit?: Affine): ViewRect {
  const inside = (r: ViewRect) => viewRectInside(r, angle, Wu, Hu, 1e-6, limit);
  let r = { ...view, w: Math.min(view.w, 1), h: Math.min(view.h, 1) };
  if (inside(r)) return r;
  // Move the centre towards a point inside the image until a tiny rect there fits.
  const tiny = (c: ViewRect) => ({ ...c, w: 1e-4, h: 1e-4 });
  const [ax, ay] = limit ? insidePoint(angle, Wu, Hu, limit) : [0.5, 0.5];
  if (!inside(tiny(r))) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      const c = { ...r, cx: ax + (r.cx - ax) * mid, cy: ay + (r.cy - ay) * mid };
      if (inside(tiny(c))) lo = mid;
      else hi = mid;
    }
    r = { ...r, cx: ax + (r.cx - ax) * lo, cy: ay + (r.cy - ay) * lo };
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (inside({ ...r, w: r.w * mid, h: r.h * mid })) lo = mid;
    else hi = mid;
  }
  return { ...r, w: r.w * lo, h: r.h * lo };
}

/** A view point well inside the transformed image (its centre, in view coordinates). */
function insidePoint(angle: number, Wu: number, Hu: number, limit: Affine): [number, number] {
  const [ux, uy] = applyAffine(invertAffine(limit), 0.5, 0.5);
  const [dx, dy] = rotPoint(angle, (ux - 0.5) * Wu, (uy - 0.5) * Hu);
  return [0.5 + dx / Wu, 0.5 + dy / Hu];
}

/** Largest centred rectangle with the given pixel aspect (w/h) that fits the rotated image. */
export function maxViewRect(aspect: number | null, angle: number, Wu: number, Hu: number, limit?: Affine): ViewRect {
  let w = 1;
  let h = 1;
  if (aspect) {
    // aspect is in pixels; view units are normalised per axis
    const viewAspect = aspect * (Hu / Wu);
    if (viewAspect >= 1) h = 1 / viewAspect;
    else w = viewAspect;
  }
  if (!limit) return fitViewRect({ cx: 0.5, cy: 0.5, w, h }, angle, Wu, Hu);
  // Inside the transformed image: start from its centre and shrink until it fits.
  const [cx, cy] = insidePoint(angle, Wu, Hu, limit);
  return fitViewRect({ cx, cy, w, h }, angle, Wu, Hu, limit);
}

/** Pixel aspect (w/h) for the crop's aspect preset, or null for free. */
export function aspectRatioFor(crop: Pick<CropParams, 'aspect' | 'portrait'>, Wu: number, Hu: number): number | null {
  if (crop.aspect === 'free') return null;
  let r: number;
  if (crop.aspect === 'original') {
    r = Math.max(Wu, Hu) / Math.min(Wu, Hu);
  } else {
    const [a, b] = crop.aspect.split(':').map(Number);
    r = Math.max(a!, b!) / Math.min(a!, b!);
  }
  return crop.portrait ? 1 / r : r;
}

/** Changes the rectangle to the given pixel aspect, keeping its area roughly, then fits it. */
export function withAspect(view: ViewRect, aspect: number | null, angle: number, Wu: number, Hu: number, limit?: Affine): ViewRect {
  if (!aspect) return fitViewRect(view, angle, Wu, Hu, limit);
  const areaPx = view.w * Wu * view.h * Hu;
  const wPx = Math.sqrt(areaPx * aspect);
  const hPx = wPx / aspect;
  return fitViewRect({ ...view, w: wPx / Wu, h: hPx / Hu }, angle, Wu, Hu, limit);
}
