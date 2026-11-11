// Face parts from MediaPipe's 478 face landmarks: outlines of the eyes, irises, brows and
// lips, filled into maps.

export const LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
export const LIPS_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
export const EYE_LEFT = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
export const EYE_RIGHT = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
export const BROW_LEFT = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276];
export const BROW_RIGHT = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
export const IRIS_LEFT = [474, 475, 476, 477];
export const IRIS_RIGHT = [469, 470, 471, 472];
export const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
/** Just below the nose (top of the upper lip area). */
export const UNDER_NOSE = 2;
export const LANDMARKS = 478;

/** Landmark points (normalised x, y pairs) of `idx`, in pixels of a w x h map. */
export function outline(lm: Float32Array, idx: readonly number[], w: number, h: number): number[] {
  const out: number[] = [];
  for (const i of idx) out.push(lm[2 * i]! * w, lm[2 * i + 1]! * h);
  return out;
}

/**
 * Fills a polygon (pixel coordinates, flat x, y pairs) into a w x h map with `value`, testing
 * pixel centres (even-odd rule). op 'max' paints, 'clear' sets the inside to 0.
 */
export function fillPolygon(map: Float32Array, w: number, h: number, pts: readonly number[], value = 1, op: 'max' | 'clear' = 'max'): void {
  const n = pts.length >> 1;
  if (n < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minY = Math.min(minY, pts[2 * i + 1]!);
    maxY = Math.max(maxY, pts[2 * i + 1]!);
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(h - 1, Math.ceil(maxY));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ay = pts[2 * i + 1]!;
      const by = pts[2 * j + 1]!;
      if (ay > cy !== by > cy) {
        const ax = pts[2 * i]!;
        const bx = pts[2 * j]!;
        xs.push(ax + ((cy - ay) * (bx - ax)) / (by - ay));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k]! - 0.5));
      const to = Math.min(w - 1, Math.floor(xs[k + 1]! - 0.5));
      for (let x = from; x <= to; x++) {
        const i = y * w + x;
        map[i] = op === 'clear' ? 0 : Math.max(map[i]!, value);
      }
    }
  }
}

/** Fills a disc (pixel centre cx, cy and radius r) with `value`. */
export function fillDisc(map: Float32Array, w: number, h: number, cx: number, cy: number, r: number, value = 1): void {
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) map[y * w + x] = Math.max(map[y * w + x]!, value);
    }
  }
}

/** Centre and mean radius of an iris (its four ring landmarks), in pixels. */
export function iris(lm: Float32Array, idx: readonly number[], w: number, h: number): { cx: number; cy: number; r: number } {
  const p = outline(lm, idx, w, h);
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < p.length; i += 2) {
    cx += p[i]!;
    cy += p[i + 1]!;
  }
  cx /= idx.length;
  cy /= idx.length;
  let r = 0;
  for (let i = 0; i < p.length; i += 2) r += Math.hypot(p[i]! - cx, p[i + 1]! - cy);
  return { cx, cy, r: r / idx.length };
}

/** Bounding box of a face's landmarks (normalised). */
export function faceBox(lm: Float32Array): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < lm.length; i += 2) {
    x0 = Math.min(x0, lm[i]!);
    x1 = Math.max(x1, lm[i]!);
    y0 = Math.min(y0, lm[i + 1]!);
    y1 = Math.max(y1, lm[i + 1]!);
  }
  return [x0, y0, x1, y1];
}

export interface FaceParts {
  eyes: Float32Array;
  iris: Float32Array;
  brows: Float32Array;
  lips: Float32Array;
  /** Inside the lips (where teeth show). */
  mouth: Float32Array;
  /** The face below the nose, widened a little: where facial hair grows. */
  lowerFace: Float32Array;
}

/** Face part maps (0 or 1) for all faces at w x h. */
export function faceParts(faces: readonly Float32Array[], w: number, h: number): FaceParts {
  const n = w * h;
  const p: FaceParts = { eyes: new Float32Array(n), iris: new Float32Array(n), brows: new Float32Array(n), lips: new Float32Array(n), mouth: new Float32Array(n), lowerFace: new Float32Array(n) };
  for (const lm of faces) {
    for (const eye of [EYE_LEFT, EYE_RIGHT]) fillPolygon(p.eyes, w, h, outline(lm, eye, w, h));
    for (const ring of [IRIS_LEFT, IRIS_RIGHT]) {
      const c = iris(lm, ring, w, h);
      fillDisc(p.iris, w, h, c.cx, c.cy, c.r);
    }
    for (const brow of [BROW_LEFT, BROW_RIGHT]) fillPolygon(p.brows, w, h, outline(lm, brow, w, h));
    fillPolygon(p.lips, w, h, outline(lm, LIPS_OUTER, w, h));
    fillPolygon(p.mouth, w, h, outline(lm, LIPS_INNER, w, h));
    // The oval below the nose, pushed out from the nose by 25 % (beards reach past the jaw).
    const nose = [lm[2 * UNDER_NOSE]! * w, lm[2 * UNDER_NOSE + 1]! * h] as const;
    const oval = outline(lm, FACE_OVAL, w, h);
    const lower: number[] = [];
    for (let i = 0; i < oval.length; i += 2) {
      const x = oval[i]!;
      const y = oval[i + 1]!;
      if (y >= nose[1] - (h * 0.0005)) lower.push(nose[0] + (x - nose[0]) * 1.25, nose[1] + (y - nose[1]) * 1.25);
    }
    if (lower.length >= 6) {
      lower.push(nose[0], nose[1]);
      fillPolygon(p.lowerFace, w, h, lower);
    }
  }
  // Lips are the ring around the mouth; eyes without the iris are the whites.
  for (let i = 0; i < n; i++) {
    if (p.mouth[i]) p.lips[i] = 0;
    p.iris[i] = p.iris[i]! * p.eyes[i]!;
  }
  return p;
}
