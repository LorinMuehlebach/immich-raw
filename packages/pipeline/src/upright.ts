// Guided Upright (Lightroom's): from lines drawn along edges that should be vertical or
// horizontal, the camera rotation that makes them so, as a homography of the image.
//
// The photo is treated as taken by a pinhole camera with focal length f (in half image
// diagonals, the frame of transformMatrix). A guide and the camera centre span a plane; two
// verticals meet in a vanishing point, and turning the camera so that point lies straight
// down makes them parallel and vertical. With the guides one has:
// - two or more verticals: the smallest turn that makes them vertical; with one horizontal
//   too, then a turn about the vertical axis that makes that horizontal;
// - two or more horizontals: the same with the roles swapped;
// - two of each: both vanishing points (and f is measured from them when it can be);
// - one guide, or one of each: only a rotation in the image plane (like Straighten).
import type { Affine } from './geometry.ts';

type V3 = [number, number, number];
/** Row-major 3x3 rotation. */
export type Rot3 = [number, number, number, number, number, number, number, number, number];
/** A guide in the centred, isotropic frame of transformMatrix (half diagonal = 1, y down). */
export type Segment = [[number, number], [number, number]];

/** Largest correction accepted (degrees of camera turn); beyond it the guides are taken as a mistake. */
export const UPRIGHT_MAX_TURN = 60;
/** Half the diagonal of a 36 x 24 mm frame: 35 mm-equivalent focal lengths -> half diagonals. */
export const HALF_DIAGONAL_35MM = Math.hypot(36, 24) / 2;

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const mul = (a: Rot3, b: Rot3): Rot3 => {
  const r = new Array(9).fill(0) as Rot3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k]! * b[k * 3 + j]!;
  return r;
};
const apply = (r: Rot3, v: V3): V3 => [r[0] * v[0] + r[1] * v[1] + r[2] * v[2], r[3] * v[0] + r[4] * v[1] + r[5] * v[2], r[6] * v[0] + r[7] * v[1] + r[8] * v[2]];
const IDENTITY: Rot3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Is the guide closer to vertical than to horizontal (on screen)? */
export const isVertical = (s: Segment) => Math.abs(s[1][1] - s[0][1]) >= Math.abs(s[1][0] - s[0][0]);

/** Normal of the plane through the camera centre and the guide (rays (x, y, f)). */
const planeNormal = (s: Segment, f: number): V3 => norm(cross([s[0][0], s[0][1], f], [s[1][0], s[1][1], f]));

/** The smallest rotation taking unit vector a to unit vector b (Rodrigues). */
function rotationBetween(a: V3, b: V3): Rot3 {
  const k = cross(a, b);
  const s = Math.hypot(k[0], k[1], k[2]);
  const c = dot(a, b);
  if (s < 1e-12) return IDENTITY;
  const [x, y, z] = [k[0] / s, k[1] / s, k[2] / s];
  const t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}

const rotX = (a: number): Rot3 => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const rotY = (a: number): Rot3 => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const rotZ = (a: number): Rot3 => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];

/** The vanishing direction of two guides, turned towards `towards` (the axis it should become). */
function vanishing(a: Segment, b: Segment, f: number, towards: V3): V3 {
  const v = norm(cross(planeNormal(a, f), planeNormal(b, f)));
  return dot(v, towards) < 0 ? [-v[0], -v[1], -v[2]] : v;
}

/**
 * Focal length (half diagonals) at which the vertical and the horizontal vanishing points are
 * at right angles, or null when the guides can't tell (nearly parallel lines, odd values).
 */
export function focalFromGuides(v: [Segment, Segment], h: [Segment, Segment]): number | null {
  const point = (a: Segment, b: Segment): [number, number] | null => {
    const l1 = cross([a[0][0], a[0][1], 1], [a[1][0], a[1][1], 1]);
    const l2 = cross([b[0][0], b[0][1], 1], [b[1][0], b[1][1], 1]);
    const p = cross(l1, l2);
    // Lines parallel on the image (to within a fraction of a degree): no finite point.
    if (Math.abs(p[2]) < 1e-9 * Math.hypot(p[0], p[1])) return null;
    return [p[0] / p[2], p[1] / p[2]];
  };
  const pv = point(v[0], v[1]);
  const ph = point(h[0], h[1]);
  if (!pv || !ph) return null;
  const f2 = -(pv[0] * ph[0] + pv[1] * ph[1]);
  if (!(f2 > 0)) return null;
  const f = Math.sqrt(f2);
  // About 6 to 130 mm on full frame.
  return f >= 0.3 && f <= 6 ? f : null;
}

/** Turn in the image plane that makes the guides as vertical / horizontal as they can be. */
function roll(segments: Segment[]): Rot3 {
  let sum = 0;
  for (const s of segments) {
    const a = Math.atan2(s[1][1] - s[0][1], s[1][0] - s[0][0]);
    // Turn to the nearest of vertical or horizontal: a multiple of 90°.
    const target = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
    sum += target - a;
  }
  return rotZ(sum / segments.length);
}

/** Rotation angle of a rotation matrix, degrees. */
export const turnDegrees = (r: Rot3) => (Math.acos(Math.min(1, Math.max(-1, (r[0] + r[4] + r[8] - 1) / 2))) * 180) / Math.PI;

/**
 * The camera rotation for the guides at focal length f (half diagonals), and the focal length
 * used (measured from the guides when there are two of each). Null without guides, or when the
 * correction would turn the camera by more than UPRIGHT_MAX_TURN.
 */
export function solveUpright(segments: Segment[], f: number): { rot: Rot3; f: number } | null {
  if (!segments.length) return null;
  const vs = segments.filter(isVertical);
  const hs = segments.filter((s) => !isVertical(s));
  if (vs.length >= 2 && hs.length >= 2) f = focalFromGuides([vs[0]!, vs[1]!], [hs[0]!, hs[1]!]) ?? f;
  const X: V3 = [1, 0, 0];
  const Y: V3 = [0, 1, 0];
  let rot: Rot3;
  if (vs.length >= 2 && hs.length >= 2) {
    // Both vanishing points: the turn that sends them to the image axes.
    const v = vanishing(vs[0]!, vs[1]!, f, Y);
    const h0 = vanishing(hs[0]!, hs[1]!, f, X);
    const d = dot(h0, v);
    const h = norm([h0[0] - d * v[0], h0[1] - d * v[1], h0[2] - d * v[2]]);
    const z = cross(h, v);
    rot = [...h, ...v, ...z] as Rot3;
  } else if (vs.length >= 2) {
    rot = rotationBetween(vanishing(vs[0]!, vs[1]!, f, Y), Y);
    if (hs.length) {
      // Then about the vertical axis, until the horizontal guide is horizontal.
      const n = apply(rot, planeNormal(hs[0]!, f));
      rot = mul(rotY(Math.atan(-n[0] / n[2])), rot);
    }
  } else if (hs.length >= 2) {
    rot = rotationBetween(vanishing(hs[0]!, hs[1]!, f, X), X);
    if (vs.length) {
      // Then about the horizontal axis, until the vertical guide is vertical.
      const n = apply(rot, planeNormal(vs[0]!, f));
      rot = mul(rotX(Math.atan(n[1] / n[2])), rot);
    }
  } else {
    rot = roll(segments);
  }
  if (!rot.every(Number.isFinite) || turnDegrees(rot) > UPRIGHT_MAX_TURN) return null;
  return { rot, f };
}

/** The camera turn as a map of the centred image: K R K⁻¹ with K = diag(f, f, 1). */
export function rotationHomography(rot: Rot3, f: number): Affine {
  const K: Rot3 = [f, 0, 0, 0, f, 0, 0, 0, 1];
  const Kinv: Rot3 = [1 / f, 0, 0, 0, 1 / f, 0, 0, 0, 1];
  return mul(K, mul(rot, Kinv)) as Affine;
}
