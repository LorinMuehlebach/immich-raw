// AI Upscale: runs an upscale model over a whole image, tile by tile.
import type { Upscaler, UpscaleScale } from '../models.ts';
import type { RgbaImage } from '../types.ts';
import { halvePlanar, planTiles, readRgbaTile, writeRgbaTile } from './tiles.ts';

/** One model run: NCHW float RGB of side x side in, the same at the model's scale out. */
export type Infer = (input: Float32Array, side: number) => Promise<Float32Array>;

export interface UpscaleOptions {
  /** Called after every tile. */
  onTile?: (done: number, total: number) => void;
  /** Checked before every tile; true stops with CANCELLED. */
  cancelled?: () => boolean;
}

export const CANCELLED = 'Cancelled.';

/** `image` made `scale` times larger by the model `u`, in tiles of side x side input pixels. */
export async function upscaleImage(image: RgbaImage, u: Upscaler, scale: UpscaleScale, side: number, infer: Infer, opts: UpscaleOptions = {}): Promise<RgbaImage> {
  if (u.fixedSide && side !== u.fixedSide) throw new Error(`This model takes ${u.fixedSide} px tiles.`);
  if (scale > u.nativeScale) throw new Error(`This model upscales up to ${u.nativeScale}x.`);
  const core = side - 2 * u.pad;
  const tiles = planTiles(image.width, image.height, core);
  const W = image.width * scale;
  const H = image.height * scale;
  const out: RgbaImage = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  const input = new Float32Array(3 * side * side);
  for (let i = 0; i < tiles.length; i++) {
    // Let the worker read its messages: on the CPU a model run never leaves the microtask
    // queue, so a Cancel would otherwise wait for the whole image.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (opts.cancelled?.()) throw new Error(CANCELLED);
    const t = tiles[i]!;
    readRgbaTile(image, t, u.pad, side, input);
    let result = await infer(input, side);
    if (result.length !== 3 * (side * u.nativeScale) ** 2) throw new Error('The upscale model returned an unexpected size.');
    for (let s = u.nativeScale; s > scale; s /= 2) result = halvePlanar(result, side * s);
    writeRgbaTile(out, result, side, t, u.pad, scale, u.band);
    opts.onTile?.(i + 1, tiles.length);
  }
  return out;
}
