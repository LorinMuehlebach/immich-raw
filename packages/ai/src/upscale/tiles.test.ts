import { describe, expect, it } from 'vitest';
import { upscaler, type Upscaler } from '../models.ts';
import type { RgbaImage } from '../types.ts';
import { CANCELLED, upscaleImage, type Infer } from './run.ts';
import { halvePlanar, mirror, planTiles, readRgbaTile } from './tiles.ts';

/** A test image: every pixel different, so a shifted tile shows. */
function noise(w: number, h: number): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = 12345;
  for (let i = 0; i < data.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    data[i] = (i & 3) === 3 ? 255 : s >>> 24;
  }
  return { width: w, height: h, data };
}

/** A fake model: optional box blur of `radius` (needs context), then nearest-neighbour upscale. */
function fakeModel(native: number, radius = 0, offset?: () => number): Infer {
  return async (input, side) => {
    const plane = side * side;
    const blurred = new Float32Array(input.length);
    for (let c = 0; c < 3; c++) {
      for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
          let sum = 0;
          let n = 0;
          for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
              const xx = x + dx;
              const yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= side || yy >= side) continue;
              sum += input[c * plane + yy * side + xx]!;
              n++;
            }
          }
          blurred[c * plane + y * side + x] = sum / n;
        }
      }
    }
    const add = offset?.() ?? 0;
    const os = side * native;
    const out = new Float32Array(3 * os * os);
    for (let c = 0; c < 3; c++) {
      for (let y = 0; y < os; y++) {
        for (let x = 0; x < os; x++) out[c * os * os + y * os + x] = blurred[c * plane + Math.floor(y / native) * side + Math.floor(x / native)]! + add;
      }
    }
    return out;
  };
}

/** Nearest-neighbour upscale of the whole image (what the tiles must add up to). */
function nearest(img: RgbaImage, s: number): RgbaImage {
  const W = img.width * s;
  const H = img.height * s;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (Math.floor(y / s) * img.width + Math.floor(x / s)) * 4;
      data.set(img.data.subarray(i, i + 4), (y * W + x) * 4);
    }
  }
  return { width: W, height: H, data };
}

const u = (nativeScale: 2 | 4, pad: number, band: number): Upscaler => ({ model: 'upscaleSharp', nativeScale, fixedSide: null, pad, band });

describe('planTiles', () => {
  it('covers the image exactly once, row by row', () => {
    const tiles = planTiles(37, 53, 16);
    expect(tiles).toHaveLength(3 * 4);
    expect(tiles[0]).toEqual({ x: 0, y: 0, w: 16, h: 16 });
    expect(tiles[2]).toEqual({ x: 32, y: 0, w: 5, h: 16 });
    expect(tiles[11]).toEqual({ x: 32, y: 48, w: 5, h: 5 });
    const seen = new Uint8Array(37 * 53);
    for (const t of tiles) for (let y = t.y; y < t.y + t.h; y++) for (let x = t.x; x < t.x + t.w; x++) seen[y * 37 + x]!++;
    expect(seen.every((n) => n === 1)).toBe(true);
  });

  it('makes one tile for an image smaller than a tile', () => {
    expect(planTiles(10, 7, 128)).toEqual([{ x: 0, y: 0, w: 10, h: 7 }]);
  });
});

describe('mirror', () => {
  it('reflects without repeating the edge pixel, at any distance', () => {
    expect([-6, -5, -4, -3, -2, -1, 0, 4, 5, 6, 7, 8, 9].map((i) => mirror(i, 5))).toEqual([2, 3, 4, 3, 2, 1, 0, 4, 3, 2, 1, 0, 1]);
    expect(mirror(-3, 1)).toBe(0);
  });
});

describe('readRgbaTile', () => {
  it('reads NCHW 0..1 with the padding mirrored at the edges', () => {
    const img = noise(4, 3);
    const t = readRgbaTile(img, { x: 0, y: 0, w: 4, h: 3 }, 1, 6);
    const px = (x: number, y: number, c: number) => img.data[(y * 4 + x) * 4 + c]! / 255;
    // (0, 0) of the tile is (-1, -1) of the image, mirrored to (1, 1).
    expect(t[0]).toBeCloseTo(px(1, 1, 0));
    expect(t[36 + 7]).toBeCloseTo(px(0, 0, 1));
    expect(t[72 + 6 * 5 + 5]).toBeCloseTo(px(mirror(4, 4), mirror(4, 3), 2));
  });
});

describe('halvePlanar', () => {
  it('averages 2x2 blocks of each plane', () => {
    const side = 4;
    const data = new Float32Array(3 * 16).map((_, i) => i);
    const h = halvePlanar(data, side);
    expect(h).toHaveLength(12);
    expect(h[0]).toBe((0 + 1 + 4 + 5) / 4);
    expect(h[4 + 3]).toBe((26 + 27 + 30 + 31) / 4); // plane 1, (1, 1)
  });
});

describe('upscaleImage', () => {
  it.each([
    [2, 2, 0],
    [4, 4, 0],
    [2, 4, 0],
    [2, 2, 3],
    [4, 4, 3],
  ] as const)('tiles add up to one nearest-neighbour upscale (x%i from a x%i model, band %i)', async (scale, native, band) => {
    const img = noise(37, 53);
    const out = await upscaleImage(img, u(native, 4, band), scale, 16, fakeModel(native));
    expect(out.width).toBe(37 * scale);
    expect(out.height).toBe(53 * scale);
    expect(out.data).toEqual(nearest(img, scale).data);
  });

  it('gives the same result as one big tile when the padding covers what the model looks at', async () => {
    const img = noise(41, 29);
    const model = fakeModel(2, 3);
    const whole = await upscaleImage(img, u(2, 3, 0), 2, 41 + 6, model);
    const tiled = await upscaleImage(img, u(2, 3, 0), 2, 12, model);
    expect(tiled.data).toEqual(whole.data);
  });

  it('blends tiles that come out a little different, instead of leaving a step', async () => {
    const flat: RgbaImage = { width: 32, height: 8, data: new Uint8ClampedArray(32 * 8 * 4).fill(100) };
    const run = async (band: number) => {
      let tile = 0;
      // The second tile comes out 20 levels brighter.
      const out = await upscaleImage(flat, u(2, 4, band), 2, 24, fakeModel(2, 0, () => (tile++ * 20) / 255));
      const row = Array.from({ length: out.width }, (_, x) => out.data[(4 * out.width + x) * 4]!);
      return Math.max(...row.slice(1).map((v, i) => Math.abs(v - row[i]!)));
    };
    expect(await run(0)).toBe(20);
    expect(await run(4)).toBeLessThanOrEqual(3);
  });

  it('reports progress per tile and stops when cancelled', async () => {
    const img = noise(40, 40);
    const seen: number[] = [];
    await upscaleImage(img, u(2, 4, 0), 2, 28, fakeModel(2), { onTile: (d, t) => seen.push(d / t) });
    expect(seen).toEqual([0.25, 0.5, 0.75, 1]);
    let n = 0;
    await expect(upscaleImage(img, u(2, 4, 0), 2, 28, fakeModel(2), { cancelled: () => ++n > 2 })).rejects.toThrow(CANCELLED);
  });

  it('notices a Cancel that arrives as an event while a model that never yields is running', async () => {
    // Like ONNX Runtime on the CPU: each run resolves without giving the event loop a turn.
    const busy: Infer = (input, side) => fakeModel(2)(input, side);
    let stop = false;
    setTimeout(() => (stop = true), 0);
    let tiles = 0;
    await expect(upscaleImage(noise(64, 64), u(2, 4, 0), 2, 16, busy, { onTile: () => tiles++, cancelled: () => stop })).rejects.toThrow(CANCELLED);
    expect(tiles).toBeLessThan(16);
  });

  it('rejects a tile size a fixed-size model does not take', async () => {
    await expect(upscaleImage(noise(8, 8), upscaler('natural', 2), 2, 256, fakeModel(2))).rejects.toThrow('512');
  });
});
