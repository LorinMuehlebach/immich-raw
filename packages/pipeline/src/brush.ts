// Brush masks: strokes are rasterised on the CPU into a coverage map in the mask frame
// (sensor orientation, longer side = BRUSH_RES texels), one map per brush component, and
// packed into one texture atlas for the shader.
//
// Painting model (like Lightroom's brush): each dab adds `flow` of the way towards the
// stroke's `density`, so overlapping dabs build up but never beyond the density; erasing
// dabs take coverage away the same way.
import type { BrushComponent, BrushStroke } from '@immich-raw/recipe';

/** Texels on the longer image side of a brush map. */
export const BRUSH_RES = 2048;

/** Dab radius in mask-frame units for the brush Size slider (1..100). */
export function brushRadius(size: number): number {
  return 0.002 + Math.pow(Math.min(100, Math.max(1, size)) / 100, 2) * 0.2;
}

export interface BrushMap {
  width: number;
  height: number;
  /** Coverage 0..1, row-major. */
  data: Float32Array;
}

interface CacheEntry {
  map: BrushMap;
  /** Per stroke: points already painted (and the stroke's settings, to detect edits). */
  painted: { key: string; points: number }[];
  /** Spacing carried over from the last dab of the last stroke. */
  tail: { x: number; y: number; carry: number } | null;
}

const strokeKey = (s: BrushStroke) => `${s.erase ? 1 : 0}|${s.size}|${s.feather}|${s.flow}|${s.density}|${s.points[0]}|${s.points[1]}`;

/** Rasterises brush components, re-using earlier work while a stroke is being painted. */
export class BrushRasterizer {
  private cache = new Map<string, CacheEntry>();

  /** Coverage map of `c` for a mask frame of fx x fy (longer side 1). */
  rasterize(c: BrushComponent, fx: number, fy: number): BrushMap {
    const width = Math.max(1, Math.round(fx * BRUSH_RES));
    const height = Math.max(1, Math.round(fy * BRUSH_RES));
    let e = this.cache.get(c.id);
    if (!e || e.map.width !== width || e.map.height !== height || !extends_(e, c.strokes)) {
      e = { map: { width, height, data: new Float32Array(width * height) }, painted: [], tail: null };
      this.cache.set(c.id, e);
    }
    for (let i = 0; i < c.strokes.length; i++) {
      const st = c.strokes[i]!;
      const done = e.painted[i];
      const from = done ? done.points : 0;
      if (from >= st.points.length) continue;
      if (!done) e.tail = null;
      e.tail = paint(e.map, st, from, done ? e.tail : null);
      e.painted[i] = { key: strokeKey(st), points: st.points.length };
    }
    return e.map;
  }

  /** Forgets components that no longer exist. */
  retain(ids: Set<string>): void {
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
  }
}

/** Do the strokes continue what was painted (same strokes, the last one possibly longer)? */
function extends_(e: CacheEntry, strokes: BrushStroke[]): boolean {
  if (strokes.length < e.painted.length) return false;
  for (let i = 0; i < e.painted.length; i++) {
    const p = e.painted[i]!;
    const s = strokes[i]!;
    if (strokeKey(s) !== p.key || s.points.length < p.points) return false;
    // Only the last painted stroke may still grow.
    if (i < e.painted.length - 1 && s.points.length !== p.points) return false;
  }
  return true;
}

/**
 * Paints the stroke's points from index `from` (flat array index) on, dabbing along the
 * polyline. `tail` continues the spacing of an earlier call for the same stroke.
 */
function paint(map: BrushMap, st: BrushStroke, from: number, tail: CacheEntry['tail']): CacheEntry['tail'] {
  const r = brushRadius01(st) * BRUSH_RES;
  const step = Math.max(0.5, r * 0.15);
  let prev = tail ?? (from >= 2 ? { x: st.points[from - 2]! * BRUSH_RES, y: st.points[from - 1]! * BRUSH_RES, carry: 0 } : null);
  for (let i = from; i + 1 < st.points.length; i += 2) {
    const x = st.points[i]! * BRUSH_RES;
    const y = st.points[i + 1]! * BRUSH_RES;
    if (!prev) {
      dab(map, x, y, r, st);
      prev = { x, y, carry: 0 };
      continue;
    }
    const dx = x - prev.x;
    const dy = y - prev.y;
    const len = Math.hypot(dx, dy);
    let d = step - prev.carry;
    while (d <= len) {
      dab(map, prev.x + (dx * d) / len, prev.y + (dy * d) / len, r, st);
      d += step;
    }
    prev = { x, y, carry: len - (d - step) };
  }
  return prev;
}

/** Stroke radius in mask-frame units (stored strokes keep their own size). */
const brushRadius01 = (st: BrushStroke) => st.size;

function dab(map: BrushMap, cx: number, cy: number, r: number, st: BrushStroke): void {
  const { width, height, data } = map;
  const flow = st.flow / 100;
  const density = st.density / 100;
  // Feather is the outer part of the radius that fades; keep at least a texel of softness.
  const inner = Math.max(0, Math.min(1 - st.feather / 100, 1 - 1 / Math.max(r, 1)));
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(height - 1, Math.ceil(cy + r));
  const inv = 1 / r;
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) * inv;
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) * inv;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= 1) continue;
      let a = 1;
      if (d > inner) {
        const t = (d - inner) / (1 - inner);
        a = 1 - t * t * (3 - 2 * t);
      }
      const k = flow * a;
      const o = y * width + x;
      const m = data[o]!;
      data[o] = st.erase ? m * (1 - k * density) : m + k * Math.max(0, density - m);
    }
  }
}

export interface BrushAtlas {
  width: number;
  height: number;
  /** 8-bit coverage. */
  data: Uint8Array;
  /** Per component id: where its map sits, as [u0, v0, su, sv] (uv = s * (su, sv) + (u0, v0)). */
  cells: Map<string, [number, number, number, number]>;
}

/** Packs brush maps (all the same size) two per row into one 8-bit texture. */
export function packBrushAtlas(maps: { id: string; map: BrushMap }[], maxSize = Infinity): BrushAtlas | null {
  return packMaskAtlas(maps, maxSize);
}

/** A coverage map: Float32 0..1 or Uint8 0..255, row-major. */
export interface MaskMap {
  width: number;
  height: number;
  data: Float32Array | Uint8Array;
}

/**
 * Packs coverage maps two per row into one 8-bit texture. Cells take the first map's size;
 * when the atlas would be larger than `maxSize` (the GPU's texture limit, often 4096 on
 * phones) every cell is scaled down to fit.
 */
export function packMaskAtlas(maps: { id: string; map: MaskMap }[], maxSize = Infinity): BrushAtlas | null {
  if (!maps.length) return null;
  const cols = maps.length > 1 ? 2 : 1;
  const rows = Math.ceil(maps.length / cols);
  const { width: w0, height: h0 } = maps[0]!.map;
  const k = Math.max(1, (w0 * cols) / maxSize, (h0 * rows) / maxSize);
  const w = Math.max(1, Math.floor(w0 / k));
  const h = Math.max(1, Math.floor(h0 / k));
  const W = w * cols;
  const H = h * rows;
  const data = new Uint8Array(W * H);
  const cells = new Map<string, [number, number, number, number]>();
  maps.forEach(({ id, map }, i) => {
    const ox = (i % cols) * w;
    const oy = Math.floor(i / cols) * h;
    const scale = map.data instanceof Uint8Array ? 1 : 255;
    const same = map.width === w && map.height === h;
    for (let y = 0; y < h; y++) {
      const row = (oy + y) * W + ox;
      const sy = same ? y : Math.min(map.height - 1, Math.floor(((y + 0.5) * map.height) / h));
      for (let x = 0; x < w; x++) {
        const sx = same ? x : Math.min(map.width - 1, Math.floor(((x + 0.5) * map.width) / w));
        data[row + x] = Math.round(Math.min(255, Math.max(0, map.data[sy * map.width + sx]! * scale)));
      }
    }
    cells.set(id, [ox / W, oy / H, w / W, h / H]);
  });
  return { width: W, height: H, data, cells };
}
