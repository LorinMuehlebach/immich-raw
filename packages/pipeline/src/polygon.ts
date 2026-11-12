// Polygon masks: the shape is filled on the CPU into a coverage map in the mask frame, the same
// size as a brush map, and goes into the brush atlas (the shader reads it like a brush).
import type { PolygonComponent } from '@immich-raw/recipe';
import { BRUSH_RES, type BrushMap } from './brush.ts';

/** Sub-scanlines per texel row; across a row the coverage is exact. */
const SUBSAMPLES = 4;

/**
 * Coverage of a closed polygon (flat [x, y, ...] in the mask frame, even-odd fill) on a map of
 * fx x fy (longer side 1) at `res` texels per unit.
 */
export function rasterizePolygon(points: readonly number[], fx: number, fy: number, res = BRUSH_RES): BrushMap {
  const width = Math.max(1, Math.round(fx * res));
  const height = Math.max(1, Math.round(fy * res));
  const data = new Float32Array(width * height);
  const n = Math.floor(points.length / 2);
  if (n < 3) return { width, height, data };
  // Edges in texel units, skipping horizontal ones (they never cross a scanline).
  const edges: { x0: number; y0: number; y1: number; slope: number }[] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let xa = points[i * 2]! * res;
    let ya = points[i * 2 + 1]! * res;
    let xb = points[j * 2]! * res;
    let yb = points[j * 2 + 1]! * res;
    if (ya === yb) continue;
    if (ya > yb) [xa, ya, xb, yb] = [xb, yb, xa, ya];
    edges.push({ x0: xa, y0: ya, y1: yb, slope: (xb - xa) / (yb - ya) });
    minY = Math.min(minY, ya);
    maxY = Math.max(maxY, yb);
  }
  const rowFrom = Math.max(0, Math.floor(minY));
  const rowTo = Math.min(height - 1, Math.ceil(maxY));
  const xs: number[] = [];
  const w = 1 / SUBSAMPLES;
  for (let row = rowFrom; row <= rowTo; row++) {
    const line = row * width;
    for (let k = 0; k < SUBSAMPLES; k++) {
      const y = row + (k + 0.5) * w;
      xs.length = 0;
      // Half-open in y, so a corner shared by two edges counts once.
      for (const e of edges) if (y >= e.y0 && y < e.y1) xs.push(e.x0 + (y - e.y0) * e.slope);
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) addSpan(data, line, width, xs[i]!, xs[i + 1]!, w);
    }
  }
  return { width, height, data };
}

/** Adds coverage `w` over [a, b) of one row, with the partly covered end texels pro rata. */
function addSpan(data: Float32Array, line: number, width: number, a: number, b: number, w: number): void {
  a = Math.max(0, a);
  b = Math.min(width, b);
  if (b <= a) return;
  const ia = Math.floor(a);
  const ib = Math.floor(b);
  if (ia === ib) {
    data[line + ia]! += (b - a) * w;
    return;
  }
  data[line + ia]! += (ia + 1 - a) * w;
  for (let x = ia + 1; x < ib; x++) data[line + x]! += w;
  if (ib < width) data[line + ib]! += (b - ib) * w;
}

/** Even-odd test: is mask-frame point p inside the polygon? */
export function pointInPolygon(points: readonly number[], p: readonly [number, number]): boolean {
  const n = Math.floor(points.length / 2);
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2]!;
    const yi = points[i * 2 + 1]!;
    const xj = points[j * 2]!;
    const yj = points[j * 2 + 1]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Fewer corners for a freehand outline (Ramer–Douglas–Peucker on the closed shape): corners
 * closer than `tolerance` to the simplified outline are dropped. The tolerance doubles until at
 * most `maxPoints` corners are left.
 */
export function simplifyPolygon(points: readonly number[], tolerance: number, maxPoints = Infinity): number[] {
  const n = Math.floor(points.length / 2);
  if (n <= 3) return points.slice(0, n * 2);
  const pt = (i: number): [number, number] => [points[i * 2]!, points[i * 2 + 1]!];
  // Split the ring at the corner farthest from the first one, and simplify both halves.
  let far = 0;
  let best = -1;
  const [x0, y0] = pt(0);
  for (let i = 1; i < n; i++) {
    const [x, y] = pt(i);
    const d = (x - x0) ** 2 + (y - y0) ** 2;
    if (d > best) [best, far] = [d, i];
  }
  for (let tol = tolerance; ; tol *= 2) {
    const keep = new Uint8Array(n);
    keep[0] = keep[far] = 1;
    rdp(pt, 0, far, tol, keep, n);
    rdp(pt, far, n, tol, keep, n);
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(...pt(i));
    if (out.length / 2 <= maxPoints || tol > 1) return out.length >= 6 ? out : points.slice(0, 6);
  }
}

/** Marks the corners between a and b (indices mod n) that the outline needs at tolerance tol. */
function rdp(pt: (i: number) => [number, number], a: number, b: number, tol: number, keep: Uint8Array, n: number): void {
  const stack: [number, number][] = [[a, b]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    if (i1 - i0 < 2) continue;
    const [ax, ay] = pt(i0 % n);
    const [bx, by] = pt(i1 % n);
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let worst = -1;
    let at = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const [x, y] = pt(i % n);
      const d = len > 0 ? Math.abs((x - ax) * dy - (y - ay) * dx) / len : Math.hypot(x - ax, y - ay);
      if (d > worst) [worst, at] = [d, i];
    }
    if (worst > tol) {
      keep[at % n] = 1;
      stack.push([i0, at], [at, i1]);
    }
  }
}

/** A short key of the corners (they are stored rounded to 5 decimals). */
export function polygonKey(points: readonly number[]): string {
  let h = 0x811c9dc5;
  for (const v of points) h = Math.imul(h ^ Math.round(v * 1e5), 16777619);
  return `${points.length}:${(h >>> 0).toString(36)}`;
}

/** Fills polygon components, re-using the map while the shape doesn't change. */
export class PolygonRasterizer {
  private cache = new Map<string, { key: string; map: BrushMap }>();

  rasterize(c: PolygonComponent, fx: number, fy: number): BrushMap {
    const key = `${polygonKey(c.points)}|${fx}|${fy}`;
    const hit = this.cache.get(c.id);
    if (hit && hit.key === key) return hit.map;
    const map = rasterizePolygon(c.points, fx, fy);
    this.cache.set(c.id, { key, map });
    return map;
  }

  /** Forgets components that no longer exist. */
  retain(ids: Set<string>): void {
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
  }
}
