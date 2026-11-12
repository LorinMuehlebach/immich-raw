// Cutting an image into the fixed-size tiles an upscale model takes, and putting the upscaled
// tiles together again. Every tile carries `pad` pixels of context on each side (mirrored at the
// image edges) that are cut off afterwards. A tile also blends into the tiles above and left of it
// over `band` pixels, which hides the small tile-to-tile differences some models have.
import type { RgbaImage } from '../types.ts';

/** The part of the image one tile is responsible for, in input pixels. */
export interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Tiles of at most `core` x `core` pixels covering width x height, row by row. */
export function planTiles(width: number, height: number, core: number): Tile[] {
  if (core < 1) throw new Error('Tiles need at least one pixel.');
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y += core) {
    for (let x = 0; x < width; x += core) tiles.push({ x, y, w: Math.min(core, width - x), h: Math.min(core, height - y) });
  }
  return tiles;
}

/** Index `i` reflected into 0..n-1 without repeating the edge pixel (any distance outside). */
export function mirror(i: number, n: number): number {
  if (n <= 1) return 0;
  const p = 2 * (n - 1);
  const j = ((i % p) + p) % p;
  return j < n ? j : p - j;
}

/**
 * The model input for `tile`: side x side pixels starting `pad` pixels above and left of it, as
 * NCHW float RGB in 0..1. Pixels outside the image are mirrored.
 */
export function readRgbaTile(src: RgbaImage, tile: Tile, pad: number, side: number, out = new Float32Array(3 * side * side)): Float32Array {
  const { width: W, height: H, data } = src;
  const plane = side * side;
  const x0 = tile.x - pad;
  const y0 = tile.y - pad;
  const cols = new Int32Array(side);
  for (let i = 0; i < side; i++) cols[i] = mirror(x0 + i, W) * 4;
  for (let j = 0; j < side; j++) {
    const row = mirror(y0 + j, H) * W * 4;
    const o = j * side;
    for (let i = 0; i < side; i++) {
      const s = row + cols[i]!;
      out[o + i] = data[s]! / 255;
      out[plane + o + i] = data[s + 1]! / 255;
      out[2 * plane + o + i] = data[s + 2]! / 255;
    }
  }
  return out;
}

/** Halves planar RGB of side x side with 2x2 averages (a 4x model's output, made 2x). */
export function halvePlanar(data: Float32Array, side: number): Float32Array {
  const h = side >> 1;
  const out = new Float32Array(3 * h * h);
  for (let c = 0; c < 3; c++) {
    const src = c * side * side;
    const dst = c * h * h;
    for (let y = 0; y < h; y++) {
      const r0 = src + 2 * y * side;
      const r1 = r0 + side;
      for (let x = 0; x < h; x++) {
        out[dst + y * h + x] = (data[r0 + 2 * x]! + data[r0 + 2 * x + 1]! + data[r1 + 2 * x]! + data[r1 + 2 * x + 1]!) * 0.25;
      }
    }
  }
  return out;
}

/**
 * Puts one upscaled tile into `out` (RGBA, `scale` times the input size). `planar` is the model's
 * output for the tile's whole input (padding included), already at `scale`: side * scale square.
 * The padding is cut off; over `band` input pixels above and left of the tile, where its
 * neighbours are already written, it fades in linearly.
 */
export function writeRgbaTile(out: RgbaImage, planar: Float32Array, side: number, tile: Tile, pad: number, scale: number, band: number): void {
  const os = side * scale;
  const plane = os * os;
  const W = out.width;
  const bl = tile.x > 0 ? Math.min(band, pad, tile.x) * scale : 0;
  const bt = tile.y > 0 ? Math.min(band, pad, tile.y) * scale : 0;
  const X0 = tile.x * scale - bl;
  const Y0 = tile.y * scale - bt;
  const X1 = (tile.x + tile.w) * scale;
  const Y1 = (tile.y + tile.h) * scale;
  // Where (X0, Y0) is in the model output.
  const px = (pad * scale - bl) - X0;
  const py = (pad * scale - bt) - Y0;
  const d = out.data;
  for (let Y = Y0; Y < Y1; Y++) {
    const wy = Y - Y0 < bt ? (Y - Y0 + 0.5) / bt : 1;
    const src = (Y + py) * os + px;
    let o = (Y * W + X0) * 4;
    for (let X = X0; X < X1; X++, o += 4) {
      const wx = X - X0 < bl ? (X - X0 + 0.5) / bl : 1;
      const w = wx * wy;
      const s = src + X;
      const r = clamp255(planar[s]!);
      const g = clamp255(planar[plane + s]!);
      const b = clamp255(planar[2 * plane + s]!);
      if (w >= 1) {
        d[o] = r;
        d[o + 1] = g;
        d[o + 2] = b;
      } else {
        d[o] = d[o]! + (r - d[o]!) * w;
        d[o + 1] = d[o + 1]! + (g - d[o + 1]!) * w;
        d[o + 2] = d[o + 2]! + (b - d[o + 2]!) * w;
      }
      d[o + 3] = 255;
    }
  }
}

const clamp255 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : v * 255);
