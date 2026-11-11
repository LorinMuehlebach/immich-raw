import { describe, expect, it } from 'vitest';
import { applyAffine, fitSize, invertAffine, normalizeBrightness, resampleToSource, resizeMap, resizeRgba, toTensor } from './image.ts';
import type { Affine } from './types.ts';

// The orientation part of the pipeline's editFrame for a camera that needs one clockwise turn
// (flip 6): upright t -> source s is s = (t.y, 1 - t.x).
const TURN_CW: Affine = [0, 1, 0, -1, 0, 1, 0, 0, 1];

describe('image helpers', () => {
  it('resizes maps keeping pixel centres', () => {
    expect([...resizeMap([0, 1], 2, 1, 4, 1)]).toEqual([0, 0.25, 0.75, 1]);
    expect([...resizeMap([0, 10, 20, 30], 4, 1, 2, 1, 0.1)]).toEqual([0.5, 2.5]);
  });

  it('shrinks images with a box filter before resampling', () => {
    // A 1-pixel checkerboard averages to grey instead of aliasing.
    const w = 64;
    const data = new Uint8ClampedArray(w * w * 4);
    for (let i = 0; i < w * w; i++) data.fill((i % w) % 2 ^ Math.floor(i / w) % 2 ? 255 : 0, i * 4, i * 4 + 4);
    const small = resizeRgba({ width: w, height: w, data }, 8, 8);
    expect(Math.abs(small.data[0]! - 128)).toBeLessThan(2);
  });

  it('makes planar, normalised and padded tensors', () => {
    const img = { width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 51, 255]) };
    const t = toTensor(img, 1, 1, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], 1 / 255, 2, 1);
    expect([...t].map((v) => Math.round(v * 100) / 100)).toEqual([1, 0, -1, 0, -0.6, 0]);
  });

  it('maps an upright map back onto the sensor orientation', () => {
    const fit = fitSize(300, 200, 2048);
    expect(fit).toEqual([300, 200]);
    // Upright 3 x 2 map with only its top-left pixel set ...
    const map = new Float32Array(6);
    map[0] = 1;
    // ... lands at the bottom-left of the 2 x 3 sensor image (turned back counter-clockwise).
    const s = resampleToSource(map, 3, 2, invertAffine(TURN_CW), 2, 3);
    expect([...s]).toEqual([0, 0, 0, 0, 255, 0]);
    const [x, y] = applyAffine(TURN_CW, 0.25, 0.75);
    expect([x, y]).toEqual([0.75, 0.75]);
  });

  it('brightens dark renderings only', () => {
    const dark = { width: 2, height: 1, data: new Uint8ClampedArray([20, 20, 20, 255, 60, 60, 60, 255]) };
    const out = normalizeBrightness(dark);
    expect(out.data[4]!).toBeGreaterThan(150);
    expect(out.data[0]!).toBeLessThan(out.data[4]!);
    const bright = { width: 1, height: 1, data: new Uint8ClampedArray([240, 240, 240, 255]) };
    expect(normalizeBrightness(bright)).toBe(bright);
  });
});
